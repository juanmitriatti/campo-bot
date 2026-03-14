import type { UserId, User } from '../../types/index.js';

export type { User };

export interface UserWithSettings extends User {
  settings: {
    weekly_summary: boolean;
    weekly_summary_day: number;
    weekly_summary_hour: number;
    budget_alerts: boolean;
    rain_alerts: boolean;
    confirm_before_save: boolean;
    claude_daily_limit: number;
    rain_alert_mm: number;
  };
}
