// Selector de PRESENTACIÓN de formularios en WhatsApp.
//
// La definición del formulario (reglas de negocio) es una sola
// (form-definitions.ts); lo que cambia por canal es cómo se le pregunta al
// usuario:
//   - `conversation` (HOY, default): el colector conversacional
//     (src/forms/conversation/) pregunta lo que falta por chat.
//   - `meta_flow` (FUTURO): WhatsApp Flows de Meta (form-offer-meta-flow.ts).
//     Requiere además el flow_id publicado del formulario; sin él se cae a
//     `conversation` con log (nunca un formulario que no se puede abrir).
//
// Reactivar Flows = publicar con scripts/publish-whatsapp-flows.ts
// (--publish --save-settings) y poner WHATSAPP_FORM_PROVIDER=meta_flow en
// /admin. Sin deploy.
import { getSetting } from '../services/settings.service.js';
import type { FormDefinition } from './form-definitions.js';

export type WhatsAppFormProvider =
  | { kind: 'conversation' }
  | { kind: 'meta_flow'; flowId: string };

export async function resolveWhatsAppFormProvider(def: FormDefinition): Promise<WhatsAppFormProvider> {
  const configured = String((await getSetting('WHATSAPP_FORM_PROVIDER')) ?? '').trim() || 'conversation';
  if (configured !== 'meta_flow') return { kind: 'conversation' };
  const flowId = String((await getSetting(def.settingKey)) ?? '').trim();
  if (!flowId) {
    console.log(`[FORM] provider fallback: meta_flow sin ${def.settingKey} → conversation`);
    return { kind: 'conversation' };
  }
  return { kind: 'meta_flow', flowId };
}
