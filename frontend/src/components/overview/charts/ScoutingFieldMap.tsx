import { useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { ScoutingByPlot } from '../../../hooks/useAgronomicAnalyticsData';

interface Props {
  scoutings: ScoutingByPlot[];
}

interface FieldAgg {
  fieldId: number;
  fieldName: string;
  lat: number;
  lng: number;
  worstScore: number;        // 0..5
  plots: ScoutingByPlot[];
}

// 0-5 → color. Weed_coverage_pct is divided by 20 to map to 0..5 scale.
function scoutScore(s: ScoutingByPlot): number {
  const weed = s.weedCoveragePct != null ? Math.min(5, s.weedCoveragePct / 20) : 0;
  const pest = s.pestSeverity1to5 != null ? s.pestSeverity1to5 : 0;
  return Math.max(weed, pest);
}

function colorForScore(score: number): string {
  if (score < 1) return '#22c55e';
  if (score < 2) return '#84cc16';
  if (score < 3) return '#eab308';
  if (score < 4) return '#f97316';
  return '#dc2626';
}

export default function ScoutingFieldMap({ scoutings }: Props) {
  const byField = useMemo<FieldAgg[]>(() => {
    const map = new Map<number, FieldAgg>();
    for (const s of scoutings) {
      if (s.fieldLat == null || s.fieldLng == null) continue;
      const existing = map.get(s.fieldId);
      const score = scoutScore(s);
      if (existing) {
        existing.worstScore = Math.max(existing.worstScore, score);
        existing.plots.push(s);
      } else {
        map.set(s.fieldId, {
          fieldId: s.fieldId,
          fieldName: s.fieldName,
          lat: s.fieldLat,
          lng: s.fieldLng,
          worstScore: score,
          plots: [s],
        });
      }
    }
    return [...map.values()];
  }, [scoutings]);

  const center: LatLngExpression = byField.length > 0
    ? [
        byField.reduce((s, f) => s + f.lat, 0) / byField.length,
        byField.reduce((s, f) => s + f.lng, 0) / byField.length,
      ]
    : [-34, -64];

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="p-4 pb-2">
        <h3 className="text-sm font-semibold text-gray-700">Mapa de sanidad (último monitoreo)</h3>
        <p className="text-xs text-gray-400">Color = peor severidad entre todos los lotes del campo</p>
      </div>
      <div style={{ height: 360 }}>
        {byField.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">Aún no hay monitoreos cargados con campos georreferenciados.</p>
        ) : (
          <MapContainer center={center} zoom={8} style={{ height: '100%', width: '100%' }}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {byField.map(f => (
              <CircleMarker
                key={f.fieldId}
                center={[f.lat, f.lng]}
                radius={12}
                pathOptions={{ color: colorForScore(f.worstScore), fillColor: colorForScore(f.worstScore), fillOpacity: 0.6 }}
              >
                <Popup>
                  <div className="text-xs">
                    <strong>{f.fieldName}</strong>
                    <ul className="mt-1 space-y-1">
                      {f.plots.map(p => (
                        <li key={p.plotId}>
                          <span className="font-medium">{p.plotName}</span> · {new Date(p.scoutedAt).toLocaleDateString('es-AR')}
                          <br />
                          {p.weedCoveragePct != null && <span>Malezas: {p.weedCoveragePct}% </span>}
                          {p.weedSpecies.length > 0 && <span>({p.weedSpecies.join(', ')}) </span>}
                          <br />
                          {p.pestSeverity1to5 != null && <span>Plagas: severidad {p.pestSeverity1to5}/5 </span>}
                          {p.pestSpecies && <span>({p.pestSpecies})</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>
        )}
      </div>
    </div>
  );
}
