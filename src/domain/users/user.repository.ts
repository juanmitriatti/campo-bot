import {
  getOrCreateUser as _getOrCreateUser,
  setUserName as _setUserName,
  setUserCity as _setUserCity,
  getUserSettings as _getUserSettings,
  updateUserSetting as _updateUserSetting,
  getDailyClaudeCount as _getDailyClaudeCount,
  saveAiUsage as _saveAiUsage,
} from '../../services/expenses.js';
import { pool } from '../../config/db.js';
import { getSettingBool } from '../../services/settings.service.js';
import type { User, UserId, UserSettings, AiUsage } from '../../types/index.js';
import { asUserId } from '../../types/index.js';

export class UserRepository {
  async getOrCreate(phone: string): Promise<User> {
    const row = await _getOrCreateUser(phone);
    return {
      id: asUserId(row.id),
      phone_number: row.phone_number,
      name: row.name ?? null,
      city: row.city ?? null,
    };
  }

  /**
   * Look up a user that has VERIFIED this WhatsApp number.
   * Returns null if no verified user owns this phone.
   */
  async findVerifiedByPhone(phone: string): Promise<User | null> {
    const { rows } = await pool.query(
      `SELECT id, phone_number, name, city
       FROM users
       WHERE phone_number = $1
         AND whatsapp_verified_at IS NOT NULL
         AND status <> 'disabled'
       LIMIT 1`,
      [phone]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: asUserId(row.id),
      phone_number: row.phone_number,
      name: row.name ?? null,
      city: row.city ?? null,
    };
  }

  /**
   * Look up a user that has VERIFIED this Telegram chat.
   */
  async findVerifiedByTelegramId(telegramId: string): Promise<User | null> {
    const { rows } = await pool.query(
      `SELECT id, phone_number, name, city
       FROM users
       WHERE telegram_id = $1
         AND telegram_verified_at IS NOT NULL
         AND status <> 'disabled'
       LIMIT 1`,
      [telegramId]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: asUserId(row.id),
      phone_number: row.phone_number,
      name: row.name ?? null,
      city: row.city ?? null,
    };
  }

  /**
   * Reads the REQUIRE_VERIFIED_CHANNEL kill switch. When true, unverified
   * channels (WhatsApp number / Telegram chat) get rejected with an
   * onboarding hint instead of being auto-claimed.
   */
  async isVerificationRequired(): Promise<boolean> {
    return (await getSettingBool('REQUIRE_VERIFIED_CHANNEL')) === true;
  }

  async setName(userId: UserId, name: string): Promise<void> {
    await _setUserName(userId, name);
  }

  async setCity(userId: UserId, city: string, province?: string | null): Promise<void> {
    await _setUserCity(userId, city, province);
  }

  async getSettings(userId: UserId): Promise<UserSettings> {
    const settings = await _getUserSettings(userId);
    return {
      weekly_summary: settings.weekly_summary ?? true,
      weekly_summary_day: settings.weekly_summary_day ?? 0,
      weekly_summary_hour: settings.weekly_summary_hour ?? 19,
      budget_alerts: settings.budget_alerts ?? true,
      rain_alerts: settings.rain_alerts ?? true,
      confirm_before_save: settings.confirm_before_save ?? true,
      claude_daily_limit: settings.claude_daily_limit ?? 50,
      rain_alert_mm: settings.rain_alert_mm ?? 10,
    };
  }

  async updateSetting(userId: UserId, field: string, value: unknown): Promise<void> {
    await _updateUserSetting(userId, field, value);
  }

  // --- AI usage ---

  async getDailyClaudeCount(userId: UserId): Promise<number> {
    return _getDailyClaudeCount(userId);
  }

  async saveAiUsage(userId: UserId, usage: AiUsage): Promise<void> {
    await _saveAiUsage(userId, usage);
  }
}
