import { useMemo, useState } from 'react';
import { ResponsiveContainer, Treemap, Tooltip } from 'recharts';
import type { FieldPlotCropsField } from '../../../hooks/useAgronomicAnalyticsData';

interface Props {
  fields: FieldPlotCropsField[];
}

const CROP_COLORS: Record<string, string> = {
  soja: '#ca8a04',
  maíz: '#f59e0b',
  maiz: '#f59e0b',
  trigo: '#84cc16',
  girasol: '#f97316',
  sorgo: '#a16207',
  cebada: '#78716c',
  avena: '#737373',
  maní: '#b45309',
  mani: '#b45309',
  algodón: '#e5e7eb',
  centeno: '#57534e',
};
const FALLBACK_CROP_COLOR = '#0e7490';
const EMPTY_COLOR = '#cbd5e1'; // sin sembrar

function colorForCrop(crop: string | null): string {
  if (!crop) return EMPTY_COLOR;
  return CROP_COLORS[crop.toLowerCase()] ?? FALLBACK_CROP_COLOR;
}

interface TreeLeaf {
  name: string;       // etiqueta visible (nombre del lote o cultivo)
  plotName: string;
  crop: string | null;
  size: number;       // hectáreas (o 1 si no hay dato, para que igual se vea)
  ha: number | null;  // hectáreas reales para el tooltip (null = sin dato)
  fill: string;
  children?: TreeLeaf[];
  [key: string]: unknown; // index signature que exige TreemapDataType de recharts
}

/**
 * Convierte los lotes de un campo en nodos del treemap.
 * - Lote sin cultivo → un rectángulo gris "sin sembrar".
 * - Un cultivo que cubre todo el lote → un rectángulo del color del cultivo.
 * - N cultivos (o siembra parcial) → el lote se subdivide: un sub-rectángulo
 *   por cultivo (proporcional a sus ha) + el remanente gris si queda área libre.
 */
function buildTreeData(field: FieldPlotCropsField): TreeLeaf[] {
  // Piso de tamaño: un lote de 1 ha al lado de uno de 120 quedaba como una
  // astilla ilegible. Ningún rectángulo ocupa menos del 4% del total del
  // campo — el área deja de ser estrictamente proporcional en los extremos,
  // pero el nombre entra y el tooltip conserva las ha reales.
  const totalHa = field.plots.reduce((a, p) => a + (p.hectares && p.hectares > 0 ? p.hectares : 1), 0);
  const minSize = totalHa * 0.04;
  const floored = (ha: number) => Math.max(ha, minSize);

  return field.plots.map((plot) => {
    const plotHa = plot.hectares && plot.hectares > 0 ? plot.hectares : null;
    const crops = plot.crops;

    if (crops.length === 0) {
      return {
        name: plot.plotName, plotName: plot.plotName, crop: null,
        size: floored(plotHa ?? 1), ha: plotHa, fill: EMPTY_COLOR,
      };
    }

    const knownCropHa = crops.map(c => c.hectares && c.hectares > 0 ? c.hectares : null);
    const singleFullCrop = crops.length === 1 && (knownCropHa[0] == null || plotHa == null || knownCropHa[0] >= plotHa - 0.01);
    if (singleFullCrop) {
      return {
        name: plot.plotName, plotName: plot.plotName, crop: crops[0].crop,
        size: floored(plotHa ?? knownCropHa[0] ?? 1), ha: plotHa ?? knownCropHa[0], fill: colorForCrop(crops[0].crop),
      };
    }

    // Subdivisión: cultivos con ha conocidas; los sin dato reparten el área restante
    const knownSum = knownCropHa.reduce((a: number, h) => a + (h ?? 0), 0);
    const unknownCount = knownCropHa.filter(h => h == null).length;
    const freeForUnknown = plotHa != null ? Math.max(plotHa - knownSum, 0) : 0;
    const perUnknown = unknownCount > 0 ? (freeForUnknown > 0 ? freeForUnknown / unknownCount : 1) : 0;

    // Los hijos tapan al padre en recharts, así que el nombre del lote viaja
    // en la etiqueta de cada sub-celda ("1B · Maíz") en vez de en un marco.
    const children: TreeLeaf[] = crops.map((c, i) => {
      const ha = knownCropHa[i] ?? (perUnknown > 0 ? perUnknown : null);
      return {
        name: `${plot.plotName} · ${c.crop}`, plotName: plot.plotName, crop: c.crop,
        size: floored(ha ?? 1), ha, fill: colorForCrop(c.crop),
      };
    });
    const usedHa = children.reduce((a, c) => a + (typeof c.ha === 'number' ? c.ha : c.size), 0);
    if (plotHa != null && plotHa - usedHa > 0.01) {
      children.push({
        name: `${plot.plotName} · sin sembrar`, plotName: plot.plotName, crop: null,
        size: floored(plotHa - usedHa), ha: plotHa - usedHa, fill: EMPTY_COLOR,
      });
    }

    return {
      name: plot.plotName, plotName: plot.plotName, crop: null,
      size: 0, ha: plotHa, fill: 'transparent', isPlotFrame: true, children,
    };
  });
}

function TreemapCell(props: Record<string, unknown>) {
  const x = Number(props.x ?? 0);
  const y = Number(props.y ?? 0);
  const width = Number(props.width ?? 0);
  const height = Number(props.height ?? 0);
  const depth = Number(props.depth ?? 0);
  const name = String(props.name ?? '');
  const fill = typeof props.fill === 'string' ? props.fill : EMPTY_COLOR;
  const ha = props.ha as number | null | undefined;

  if (width <= 0 || height <= 0) return null;

  // Nodo-lote subdividido: no dibuja nada propio (los hijos llevan la
  // etiqueta "lote · cultivo"); depth 0 es la raíz sintética de recharts.
  if (depth === 0 || props.isPlotFrame) return null;

  // Etiqueta adaptativa: fuente normal si hay lugar, chica si la celda es
  // reducida, y rotada 90 grados en celdas angostas y altas. fitChars estima
  // cuantos caracteres entran (~0.62 * fontSize por caracter).
  const haLabel = ha != null ? `${Math.round(ha * 10) / 10} ha` : '';
  const big = width > 55 && height > 30;
  const fontSize = big ? 11 : 9;
  const fitChars = (px: number) => Math.max(0, Math.floor((px - 8) / (fontSize * 0.62)));
  const truncate = (t: string, max: number) => (t.length > max ? `${t.slice(0, Math.max(max - 1, 1))}…` : t);

  const horizChars = fitChars(width);
  const vertChars = fitChars(height);
  const canHoriz = horizChars >= 3 && height >= 14;
  const canVert = !canHoriz && vertChars >= 3 && width >= 12;

  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="#fff" strokeWidth={2} rx={3} />
      {canHoriz && (
        <>
          <text x={x + width / 2} y={y + height / 2 + (big && haLabel && height > 44 ? -4 : 4)} textAnchor="middle" fontSize={fontSize} fontWeight={600} fill="#1f2937">
            {truncate(name, horizChars)}
          </text>
          {big && haLabel && height > 44 && (
            <text x={x + width / 2} y={y + height / 2 + 12} textAnchor="middle" fontSize={10} fill="#374151">{haLabel}</text>
          )}
        </>
      )}
      {canVert && (
        <text
          x={x + width / 2}
          y={y + height / 2}
          textAnchor="middle"
          fontSize={fontSize}
          fontWeight={600}
          fill="#1f2937"
          transform={`rotate(-90 ${x + width / 2} ${y + height / 2})`}
        >
          {truncate(name, vertChars)}
        </text>
      )}
    </g>
  );
}

function TreemapTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: Record<string, unknown> }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload ?? {};
  const plotName = String(p.plotName ?? p.name ?? '');
  const crop = p.crop as string | null | undefined;
  const ha = p.ha as number | null | undefined;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-xs shadow">
      <div className="font-semibold text-gray-800 dark:text-gray-100">{plotName}</div>
      <div className="text-gray-600 dark:text-gray-300">
        {crop ? `🌱 ${crop}` : 'Sin sembrar'}{ha != null ? ` · ${Math.round(ha * 10) / 10} ha` : ''}
      </div>
    </div>
  );
}

export default function FieldPlotsTreemap({ fields }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const safeIdx = Math.min(selectedIdx, Math.max(fields.length - 1, 0));
  const field = fields[safeIdx];

  const treeData = useMemo(() => (field ? buildTreeData(field) : []), [field]);

  const legendCrops = useMemo(() => {
    if (!field) return [];
    const seen = new Set<string>();
    for (const plot of field.plots) for (const c of plot.crops) seen.add(c.crop);
    return [...seen];
  }, [field]);
  const hasEmpty = useMemo(
    () => !!field && field.plots.some(p =>
      p.crops.length === 0 ||
      (p.hectares != null && p.crops.reduce((a, c) => a + (c.hectares ?? p.hectares ?? 0), 0) < p.hectares - 0.01)),
    [field],
  );

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Mapa de lotes por cultivo</h3>

      {fields.length > 1 && (
        <div className="flex items-center gap-1 border-b border-gray-200 dark:border-gray-700 mb-3 overflow-x-auto">
          {fields.map((f, i) => {
            const isActive = i === safeIdx;
            return (
              <button
                key={f.fieldId}
                type="button"
                onClick={() => setSelectedIdx(i)}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'px-3 py-2 text-sm font-medium transition-colors -mb-px whitespace-nowrap',
                  isActive
                    ? 'border-b-2 border-campo-600 text-campo-700 dark:text-campo-400'
                    : 'border-b-2 border-transparent text-gray-500 dark:text-gray-300 hover:text-gray-700 dark:hover:text-gray-100',
                ].join(' ')}
              >
                {f.fieldName}
              </button>
            );
          })}
        </div>
      )}

      {!field || treeData.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-300 text-center py-12">
          Aún no hay lotes cargados. Creá lotes desde el bot con <span className="font-medium">agregar lote [nombre]</span>.
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={320}>
            <Treemap
              data={treeData}
              dataKey="size"
              isAnimationActive={false}
              content={<TreemapCell />}
            >
              <Tooltip content={<TreemapTooltip />} />
            </Treemap>
          </ResponsiveContainer>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3">
            {legendCrops.map(c => (
              <span key={c} className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: colorForCrop(c) }} />
                {c}
              </span>
            ))}
            {hasEmpty && (
              <span className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: EMPTY_COLOR }} />
                Sin sembrar
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
