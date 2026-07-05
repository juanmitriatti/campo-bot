import { TypedPendingStore } from './typed-pending-store.js';

export interface PendingCampaignClose {
  plotCropId: number;
  crop: string;
  plotName: string;
}

// Antes: Map pelado sin TTL ni persistencia — el pending vivía para siempre
// en memoria y moría en cada deploy. Ahora: contrato único (30 min + espejo DB).
export const pendingCampaignCloseStore = new TypedPendingStore<PendingCampaignClose>('campaign_close');
