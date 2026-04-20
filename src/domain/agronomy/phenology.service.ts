import { pool } from '../../config/db.js';

export interface PhenologyAlert {
  userId: number;
  phone: string;
  telegramId: string | null;
  plotName: string;
  fieldName: string;
  crop: string;
  stageName: string;
  stageCode: string;
  daysSinceSowing: number;
  alertMessage: string;
  plotCropId: number;
}

export class PhenologyService {
  async getPendingAlerts(): Promise<PhenologyAlert[]> {
    const { rows } = await pool.query(
      `SELECT
         pc.id AS plot_crop_id,
         pc.crop,
         pc.start_date,
         p.name AS plot_name,
         f.name AS field_name,
         u.id AS user_id,
         u.phone_number AS phone,
         u.telegram_id,
         cs.stage_name,
         cs.stage_code,
         cs.typical_days_from_sowing,
         cs.alert_message,
         EXTRACT(DAY FROM NOW() - pc.start_date)::int AS days_since_sowing
       FROM plot_crops pc
       JOIN plots p ON pc.plot_id = p.id
       JOIN fields f ON p.field_id = f.id
       JOIN users u ON f.user_id = u.id
       JOIN user_settings us ON us.user_id = u.id
       JOIN crop_stages cs ON LOWER(cs.crop) = LOWER(pc.crop)
      WHERE pc.end_date IS NULL
        AND p.deleted_at IS NULL
        AND f.deleted_at IS NULL
        AND us.phenology_alerts = true
        AND ABS(EXTRACT(DAY FROM NOW() - pc.start_date)::int - cs.typical_days_from_sowing) <= 1
      ORDER BY u.id, pc.start_date`
    );

    return rows.map((r: any) => ({
      userId: r.user_id,
      phone: r.phone,
      telegramId: r.telegram_id || null,
      plotName: r.plot_name,
      fieldName: r.field_name,
      crop: r.crop,
      stageName: r.stage_name,
      stageCode: r.stage_code,
      daysSinceSowing: r.days_since_sowing,
      alertMessage: r.alert_message,
      plotCropId: r.plot_crop_id,
    }));
  }

  formatAlert(alert: PhenologyAlert): string {
    return `🌱 Tu *${alert.crop}* en *${alert.plotName}* tiene ${alert.daysSinceSowing} días (${alert.stageCode} - ${alert.stageName}). ${alert.alertMessage}`;
  }
}
