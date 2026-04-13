export interface PendingCampaignClose {
  plotCropId: number;
  crop: string;
  plotName: string;
}

export const pendingCampaignCloseStore = new Map<string, PendingCampaignClose>();
