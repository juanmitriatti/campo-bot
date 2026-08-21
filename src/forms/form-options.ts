// Opciones dinámicas de los formularios (lotes + cultivos), compartidas por el
// render web (GET /api/forms/:token) y el envío de Flows por WhatsApp — así el
// Flow endpointless hornea las MISMAS opciones que ve la Mini App. Nunca duplicar.
import { KNOWN_CROPS } from '../utils/crops.js';
import { getUserFields, getPlotsByField, getAllActiveCrops } from '../services/expenses.js';

export interface FormPlotOption {
  id: number;
  name: string;
  fieldName: string;
  activeCrop: string | null;
}

export interface FormOptions {
  plots: FormPlotOption[];
  crops: string[];
}

/** Lotes visibles (cosecha: solo con cultivo activo) + cultivos conocidos. */
export async function computeFormOptions(
  action: 'sow_crop' | 'harvest_crop',
  userId: number,
): Promise<FormOptions> {
  const fields = await getUserFields(userId);
  const actives = (await getAllActiveCrops(userId)) as Array<{ plot_id: number; crop: string }>;
  const activeByPlot = new Map(actives.map(a => [a.plot_id, a.crop]));
  const plots: FormPlotOption[] = [];
  for (const f of fields as Array<{ id: number; name: string }>) {
    for (const p of (await getPlotsByField(f.id)) as Array<{ id: number; name: string }>) {
      plots.push({ id: p.id, name: p.name, fieldName: f.name, activeCrop: activeByPlot.get(p.id) ?? null });
    }
  }
  const visible = action === 'harvest_crop' ? plots.filter(p => p.activeCrop) : plots;
  return { plots: visible, crops: KNOWN_CROPS };
}
