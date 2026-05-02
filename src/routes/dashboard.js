import { Router } from "express";
import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { pool } from "../config/db.js";
import { getObservationsByField, getWeekObservationCount } from "../services/observations.js";
import { generateWeeklyReport, getReportsByField, getAllReports, getReportById } from "../services/agro-report.js";
import { getAllSettings, setSetting, SECRET_KEYS, SETTING_DEFINITIONS } from "../services/settings.service.js";
import { getErrorLogs, getErrorById, getErrorStats, getErrorFilters, logError } from "../services/error-logger.js";
import { getAlertHistory, getAlertStats } from "../services/alert.service.js";
import { getActivityDictionary, updateActivitySynonyms } from "../services/activity-dictionary.service.js";

const router = Router();

// ─── Static files ────────────────────────────────────────────────────────────

router.use("/", express.static("src/public"));
router.get("/", (req, res) => res.sendFile("index.html", { root: "src/public" }));

// ─── GET /dashboard/api/stats ────────────────────────────────────────────────

router.get("/api/stats", async (req, res) => {
  try {
    const [usersR, aiCostR, activeR] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM users"),
      // Haiku 4.5: input 0.80/M, cache read 0.08/M (10%), cache write 1.00/M (125%), output 4.00/M
      pool.query(
        `SELECT COALESCE(SUM(
           input_tokens / 1000000.0 * 0.80
           + COALESCE(cache_read_tokens, 0) / 1000000.0 * 0.08
           + COALESCE(cache_write_tokens, 0) / 1000000.0 * 1.00
           + output_tokens / 1000000.0 * 4.0
         ), 0) AS total
         FROM ai_usage
         WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`
      ),
      pool.query(
        `SELECT COUNT(DISTINCT user_id) AS total FROM ai_usage
         WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`
      ),
    ]);

    res.json({
      totalUsers: parseInt(usersR.rows[0].total),
      monthlyAiCost: parseFloat(aiCostR.rows[0].total),
      activeUsersWeek: parseInt(activeR.rows[0].total),
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    logError('admin-api', 'STATS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/users ────────────────────────────────────────────────

router.get("/api/users", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id,
         u.phone_number,
         u.name,
         u.last_name,
         u.city,
         u.province,
         u.email,
         u.status,
         u.last_message_at,
         p.display_name AS plan_name,
         COALESCE(ai.ai_calls_today, 0) AS ai_calls_today,
         COALESCE(ai.tokens_today, 0) AS tokens_today,
         COALESCE(ai.input_tokens_today, 0) AS input_tokens_today,
         COALESCE(ai.output_tokens_today, 0) AS output_tokens_today,
         COALESCE(ai.cache_read_today, 0) AS cache_read_today,
         COALESCE(ai.cache_write_today, 0) AS cache_write_today,
         COALESCE(ai_month.tokens_month, 0) AS tokens_month,
         COALESCE(ai_month.input_tokens_month, 0) AS input_tokens_month,
         COALESCE(ai_month.output_tokens_month, 0) AS output_tokens_month,
         COALESCE(ai_month.cache_read_month, 0) AS cache_read_month,
         COALESCE(ai_month.cache_write_month, 0) AS cache_write_month,
         COALESCE(u.last_message_at, ai_all.last_ai) AS last_activity,
         COALESCE(fields.field_count, 0) AS field_count,
         COALESCE(shared.shared_field_count, 0) AS shared_field_count
       FROM users u
       LEFT JOIN plans p ON u.plan_id = p.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS ai_calls_today,
                COALESCE(SUM(total_tokens), 0) AS tokens_today,
                COALESCE(SUM(input_tokens), 0) AS input_tokens_today,
                COALESCE(SUM(output_tokens), 0) AS output_tokens_today,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_today,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_today
         FROM ai_usage WHERE user_id = u.id AND created_at::date = CURRENT_DATE
       ) ai ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(total_tokens), 0) AS tokens_month,
                COALESCE(SUM(input_tokens), 0) AS input_tokens_month,
                COALESCE(SUM(output_tokens), 0) AS output_tokens_month,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_month,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_month
         FROM ai_usage WHERE user_id = u.id AND created_at >= date_trunc('month', CURRENT_DATE)
       ) ai_month ON true
       LEFT JOIN LATERAL (
         SELECT MAX(created_at) AS last_ai FROM ai_usage WHERE user_id = u.id
       ) ai_all ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS field_count FROM fields WHERE user_id = u.id AND deleted_at IS NULL
       ) fields ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS shared_field_count
         FROM field_members fm
         WHERE fm.user_id = u.id AND fm.role = 'member'
       ) shared ON true
       ORDER BY last_activity DESC NULLS LAST`
    );

    // Haiku 4.5 pricing: input 1x, cache_read 0.1x, cache_write 1.25x, output flat
    const INPUT_COST_PER_M = 0.80;
    const CACHE_READ_COST_PER_M = 0.08;   // 10% of input rate
    const CACHE_WRITE_COST_PER_M = 1.00;  // 125% of input rate (5-min TTL)
    const OUTPUT_COST_PER_M = 4.00;
    const calcCost = (inputTokens, outputTokens, cacheRead = 0, cacheWrite = 0) =>
      +(
        inputTokens / 1_000_000 * INPUT_COST_PER_M +
        cacheRead / 1_000_000 * CACHE_READ_COST_PER_M +
        cacheWrite / 1_000_000 * CACHE_WRITE_COST_PER_M +
        outputTokens / 1_000_000 * OUTPUT_COST_PER_M
      ).toFixed(4);

    res.json(result.rows.map(u => {
      const tokensToday = parseInt(u.tokens_today);
      const tokensMonth = parseInt(u.tokens_month);
      return {
        id: u.id,
        name: u.name,
        lastName: u.last_name || null,
        phone: u.phone_number,
        city: u.city,
        province: u.province || null,
        email: u.email || null,
        status: u.status || 'active',
        planName: u.plan_name || 'Free',
        fieldCount: parseInt(u.field_count),
        sharedFieldCount: parseInt(u.shared_field_count),
        aiCallsToday: parseInt(u.ai_calls_today),
        tokensToday,
        costToday: calcCost(
          parseInt(u.input_tokens_today),
          parseInt(u.output_tokens_today),
          parseInt(u.cache_read_today),
          parseInt(u.cache_write_today),
        ),
        costMonth: calcCost(
          parseInt(u.input_tokens_month),
          parseInt(u.output_tokens_month),
          parseInt(u.cache_read_month),
          parseInt(u.cache_write_month),
        ),
        lastActivity: u.last_activity,
        lastMessageAt: u.last_message_at,
      };
    }));
  } catch (error) {
    console.error("Error fetching users:", error);
    logError('admin-api', 'USERS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/users/:id ────────────────────────────────────────────

router.get("/api/users/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const [userR, expensesR] = await Promise.all([
      pool.query("SELECT * FROM users WHERE id = $1", [id]),
      pool.query(
        `SELECT expense_date, category, amount, description FROM expenses
         WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 10`,
        [id]
      ),
    ]);

    if (userR.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const u = userR.rows[0];
    res.json({
      id: u.id,
      name: u.name,
      lastName: u.last_name || null,
      phone: u.phone_number,
      city: u.city,
      province: u.province || null,
      email: u.email || null,
      planId: u.plan_id || null,
      recentExpenses: expensesR.rows.map(e => ({
        date: e.expense_date,
        category: e.category,
        amount: parseFloat(e.amount),
        description: e.description,
      })),
    });
  } catch (error) {
    console.error("Error fetching user detail:", error);
    logError('admin-api', 'USER_DETAIL_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/users/:id/settings ───────────────────────────────────

router.get("/api/users/:id/settings", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "SELECT * FROM user_settings WHERE user_id = $1",
      [id]
    );

    if (result.rows.length === 0) {
      return res.json({
        userId: parseInt(id),
        weeklySummary: true,
        weeklySummaryDay: 0,
        weeklySummaryHour: 19,
        budgetAlerts: true,
        rainAlerts: true,
        confirmBeforeSave: true,
        claudeDailyLimit: 50,
        rainAlertMm: 10,
      });
    }

    const s = result.rows[0];
    res.json({
      userId: s.user_id,
      weeklySummary: s.weekly_summary,
      weeklySummaryDay: s.weekly_summary_day,
      weeklySummaryHour: s.weekly_summary_hour,
      budgetAlerts: s.budget_alerts,
      rainAlerts: s.rain_alerts,
      confirmBeforeSave: s.confirm_before_save,
      claudeDailyLimit: s.claude_daily_limit,
      rainAlertMm: s.rain_alert_mm || 10,
    });
  } catch (error) {
    console.error("Error fetching user settings:", error);
    logError('admin-api', 'USER_SETTINGS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PUT /dashboard/api/users/:id/settings ───────────────────────────────────

router.put("/api/users/:id/settings", async (req, res) => {
  const { id } = req.params;
  const b = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO user_settings (
         user_id, weekly_summary, weekly_summary_day, weekly_summary_hour,
         budget_alerts, rain_alerts, confirm_before_save, claude_daily_limit, rain_alert_mm
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id)
       DO UPDATE SET
         weekly_summary      = COALESCE($2, user_settings.weekly_summary),
         weekly_summary_day  = COALESCE($3, user_settings.weekly_summary_day),
         weekly_summary_hour = COALESCE($4, user_settings.weekly_summary_hour),
         budget_alerts       = COALESCE($5, user_settings.budget_alerts),
         rain_alerts         = COALESCE($6, user_settings.rain_alerts),
         confirm_before_save = COALESCE($7, user_settings.confirm_before_save),
         claude_daily_limit  = COALESCE($8, user_settings.claude_daily_limit),
         rain_alert_mm       = COALESCE($9, user_settings.rain_alert_mm)
       RETURNING *`,
      [
        id,
        b.weeklySummary,
        b.weeklySummaryDay,
        b.weeklySummaryHour,
        b.budgetAlerts,
        b.rainAlerts,
        b.confirmBeforeSave,
        b.claudeDailyLimit,
        b.rainAlertMm,
      ]
    );

    const s = result.rows[0];
    res.json({
      userId: s.user_id,
      weeklySummary: s.weekly_summary,
      weeklySummaryDay: s.weekly_summary_day,
      weeklySummaryHour: s.weekly_summary_hour,
      budgetAlerts: s.budget_alerts,
      rainAlerts: s.rain_alerts,
      confirmBeforeSave: s.confirm_before_save,
      claudeDailyLimit: s.claude_daily_limit,
      rainAlertMm: s.rain_alert_mm || 10,
    });
  } catch (error) {
    console.error("Error upserting user settings:", error);
    logError('admin-api', 'USER_SETTINGS_UPSERT', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PUT /dashboard/api/users/:id ────────────────────────────────────────────

router.put("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  const { name, last_name, city, email, province } = req.body;

  try {
    const result = await pool.query(
      `UPDATE users SET
         name = COALESCE($1, name),
         last_name = COALESCE($2, last_name),
         city = COALESCE($3, city),
         email = COALESCE($4, email),
         province = COALESCE($6, province)
       WHERE id = $5 RETURNING *`,
      [name, last_name, city, email, id, province]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const u = result.rows[0];
    res.json({
      id: u.id,
      name: u.name,
      lastName: u.last_name || null,
      phone: u.phone_number,
      city: u.city,
      province: u.province || null,
      email: u.email || null,
    });
  } catch (error) {
    console.error("Error updating user:", error);
    logError('admin-api', 'USER_UPDATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/users/:id/ai-usage ───────────────────────────────────

router.get("/api/users/:id/ai-usage", async (req, res) => {
  const { id } = req.params;

  try {
    const [todayR, monthR, totalR] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(input_tokens / 1000000.0 * 0.80 + COALESCE(cache_read_tokens, 0) / 1000000.0 * 0.08 + COALESCE(cache_write_tokens, 0) / 1000000.0 * 1.00 + output_tokens / 1000000.0 * 4.00), 0) AS cost
         FROM ai_usage WHERE user_id = $1 AND created_at::date = CURRENT_DATE`,
        [id]
      ),
      pool.query(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(input_tokens / 1000000.0 * 0.80 + COALESCE(cache_read_tokens, 0) / 1000000.0 * 0.08 + COALESCE(cache_write_tokens, 0) / 1000000.0 * 1.00 + output_tokens / 1000000.0 * 4.00), 0) AS cost
         FROM ai_usage WHERE user_id = $1
           AND date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`,
        [id]
      ),
      pool.query(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(input_tokens / 1000000.0 * 0.80 + COALESCE(cache_read_tokens, 0) / 1000000.0 * 0.08 + COALESCE(cache_write_tokens, 0) / 1000000.0 * 1.00 + output_tokens / 1000000.0 * 4.00), 0) AS cost
         FROM ai_usage WHERE user_id = $1`,
        [id]
      ),
    ]);

    res.json({
      today: { calls: parseInt(todayR.rows[0].count), cost: parseFloat(todayR.rows[0].cost) },
      month: { calls: parseInt(monthR.rows[0].count), cost: parseFloat(monthR.rows[0].cost) },
      total: { calls: parseInt(totalR.rows[0].count), cost: parseFloat(totalR.rows[0].cost) },
    });
  } catch (error) {
    console.error("Error fetching AI usage:", error);
    logError('admin-api', 'AI_USAGE_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/parse-metrics ─────────────────────────────────────────

router.get("/api/parse-metrics", async (req, res) => {
  try {
    const [unparsedWeekR, unparsedTotalR, aiWeekR] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS count FROM unparsed_messages
         WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM unparsed_messages`
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM ai_usage
         WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`
      ),
    ]);

    res.json({
      unparsedWeek: parseInt(unparsedWeekR.rows[0].count),
      unparsedTotal: parseInt(unparsedTotalR.rows[0].count),
      claudeFallbacksWeek: parseInt(aiWeekR.rows[0].count),
    });
  } catch (error) {
    console.error("Error fetching parse metrics:", error);
    logError('admin-api', 'PARSE_METRICS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/unparsed-messages ─────────────────────────────────────

router.get("/api/unparsed-messages", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const userFilter = req.query.user || null;
  const phoneFilter = req.query.phone || null;
  const fromDate = req.query.from || null;
  const toDate = req.query.to || null;

  try {
    let query = `SELECT um.id, um.message, um.created_at, u.name, u.phone_number
       FROM unparsed_messages um
       JOIN users u ON um.user_id = u.id`;
    const conditions = [];
    const params = [];

    if (userFilter) {
      params.push(`%${userFilter}%`);
      conditions.push(`u.name ILIKE $${params.length}`);
    }
    if (phoneFilter) {
      params.push(`%${phoneFilter}%`);
      conditions.push(`u.phone_number ILIKE $${params.length}`);
    }
    if (fromDate) {
      params.push(fromDate);
      conditions.push(`um.created_at >= $${params.length}::date`);
    }
    if (toDate) {
      params.push(toDate);
      conditions.push(`um.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(' AND ');
    }
    query += ` ORDER BY um.created_at DESC`;
    params.push(limit, offset);
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);

    res.json(result.rows.map(r => ({
      id: r.id,
      message: r.message,
      userName: r.name,
      phone: r.phone_number,
      createdAt: r.created_at,
    })));
  } catch (error) {
    console.error("Error fetching unparsed messages:", error);
    logError('admin-api', 'UNPARSED_MESSAGES_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/global-settings ──────────────────────────────────────

router.get("/api/global-settings", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM global_settings WHERE id = 1");
    if (result.rows.length === 0) {
      return res.json({
        dailyWeatherEnabled: true,
        dailyWeatherHour: 6,
        defaultRainAlertMm: 10,
        budgetAlert80: true,
        budgetAlert100: true,
      });
    }
    const g = result.rows[0];
    res.json({
      dailyWeatherEnabled: g.daily_weather_enabled,
      dailyWeatherHour: g.daily_weather_hour,
      defaultRainAlertMm: g.default_rain_alert_mm,
      budgetAlert80: g.budget_alert_80,
      budgetAlert100: g.budget_alert_100,
    });
  } catch (error) {
    console.error("Error fetching global settings:", error);
    logError('admin-api', 'GLOBAL_SETTINGS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PUT /dashboard/api/global-settings ──────────────────────────────────────

router.put("/api/global-settings", async (req, res) => {
  const b = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO global_settings (id, daily_weather_enabled, daily_weather_hour, default_rain_alert_mm, budget_alert_80, budget_alert_100, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         daily_weather_enabled = COALESCE($1, global_settings.daily_weather_enabled),
         daily_weather_hour = COALESCE($2, global_settings.daily_weather_hour),
         default_rain_alert_mm = COALESCE($3, global_settings.default_rain_alert_mm),
         budget_alert_80 = COALESCE($4, global_settings.budget_alert_80),
         budget_alert_100 = COALESCE($5, global_settings.budget_alert_100),
         updated_at = NOW()
       RETURNING *`,
      [
        b.dailyWeatherEnabled,
        b.dailyWeatherHour,
        b.defaultRainAlertMm,
        b.budgetAlert80,
        b.budgetAlert100,
      ]
    );
    const g = result.rows[0];
    res.json({
      dailyWeatherEnabled: g.daily_weather_enabled,
      dailyWeatherHour: g.daily_weather_hour,
      defaultRainAlertMm: g.default_rain_alert_mm,
      budgetAlert80: g.budget_alert_80,
      budgetAlert100: g.budget_alert_100,
    });
  } catch (error) {
    console.error("Error updating global settings:", error);
    logError('admin-api', 'GLOBAL_SETTINGS_UPDATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/alerts-overview ──────────────────────────────────────

router.get("/api/alerts-overview", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id, u.name, u.phone_number, u.city,
         COALESCE(s.rain_alerts, true) AS rain_alerts,
         COALESCE(s.budget_alerts, true) AS budget_alerts,
         COALESCE(s.weekly_summary, true) AS weekly_summary,
         COALESCE(s.rain_alert_mm, 10) AS rain_alert_mm
       FROM users u
       LEFT JOIN user_settings s ON s.user_id = u.id
       ORDER BY u.name NULLS LAST`
    );

    res.json(result.rows.map(r => ({
      id: r.id,
      name: r.name,
      phone: r.phone_number,
      city: r.city,
      rainAlerts: r.rain_alerts,
      budgetAlerts: r.budget_alerts,
      weeklySummary: r.weekly_summary,
      rainAlertMm: r.rain_alert_mm,
    })));
  } catch (error) {
    console.error("Error fetching alerts overview:", error);
    logError('admin-api', 'ALERTS_OVERVIEW_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/alert-history ─────────────────────────────────────────

router.get("/api/alert-history", async (req, res) => {
  try {
    const type = req.query.type || null;
    const status = req.query.status || null;
    const userId = req.query.userId ? parseInt(req.query.userId) : null;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const result = await getAlertHistory({ type, status, userId, limit, offset });

    res.json({
      rows: result.rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        phone: r.phone_number,
        alertType: r.alert_type,
        fieldId: r.field_id,
        plotId: r.plot_id,
        message: r.message,
        payload: r.payload,
        status: r.status,
        retryCount: r.retry_count,
        dedupKey: r.dedup_key,
        createdAt: r.created_at,
        deliveredAt: r.delivered_at,
      })),
      total: result.total,
    });
  } catch (error) {
    console.error("Error fetching alert history:", error);
    logError('admin-api', 'ALERT_HISTORY_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/alert-stats ──────────────────────────────────────────

router.get("/api/alert-stats", async (req, res) => {
  try {
    const stats = await getAlertStats();
    res.json(stats);
  } catch (error) {
    console.error("Error fetching alert stats:", error);
    logError('admin-api', 'ALERT_STATS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/plans ─────────────────────────────────────────────────

router.get("/api/plans", async (req, res) => {
  try {
    const plansR = await pool.query(
      `SELECT p.*,
        (SELECT array_agg(f.key ORDER BY f.key) FROM features f JOIN plan_features pf ON pf.feature_id = f.id WHERE pf.plan_id = p.id) AS features,
        (SELECT COUNT(*) FROM users u WHERE u.plan_id = p.id) AS user_count
       FROM plans p ORDER BY p.price_ars ASC`
    );
    res.json(plansR.rows.map(p => ({
      id: p.id,
      name: p.name,
      displayName: p.display_name,
      priceArs: parseFloat(p.price_ars),
      isActive: p.is_active,
      dailyAiLimit: p.daily_ai_limit != null ? parseInt(p.daily_ai_limit) : 20,
      features: p.features || [],
      userCount: parseInt(p.user_count),
    })));
  } catch (error) {
    console.error("Error fetching plans:", error);
    logError('admin-api', 'PLANS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/features ──────────────────────────────────────────────

router.get("/api/features", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM features ORDER BY key");
    res.json(result.rows.map(f => ({
      id: f.id,
      key: f.key,
      description: f.description,
    })));
  } catch (error) {
    console.error("Error fetching features:", error);
    logError('admin-api', 'FEATURES_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PUT /dashboard/api/plans/:id ─────────────────────────────────────────────

router.put("/api/plans/:id", async (req, res) => {
  const { id } = req.params;
  const { displayName, priceArs, isActive, dailyAiLimit } = req.body;

  try {
    const sets = [];
    const values = [];
    let idx = 1;

    if (displayName !== undefined) { sets.push(`display_name = $${idx++}`); values.push(displayName); }
    if (priceArs !== undefined) { sets.push(`price_ars = $${idx++}`); values.push(priceArs); }
    if (isActive !== undefined) { sets.push(`is_active = $${idx++}`); values.push(isActive); }
    if (dailyAiLimit !== undefined) { sets.push(`daily_ai_limit = $${idx++}`); values.push(dailyAiLimit); }

    if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });

    values.push(id);
    const result = await pool.query(
      `UPDATE plans SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Plan not found" });

    const p = result.rows[0];
    res.json({ id: p.id, name: p.name, displayName: p.display_name, priceArs: parseFloat(p.price_ars), isActive: p.is_active, dailyAiLimit: p.daily_ai_limit != null ? parseInt(p.daily_ai_limit) : 20 });
  } catch (error) {
    console.error("Error updating plan:", error);
    logError('admin-api', 'PLAN_UPDATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PUT /dashboard/api/plans/:id/features ────────────────────────────────────

router.put("/api/plans/:id/features", async (req, res) => {
  const { id } = req.params;
  const { features } = req.body; // array of feature keys

  if (!Array.isArray(features)) return res.status(400).json({ error: "features must be an array" });

  try {
    await pool.query("DELETE FROM plan_features WHERE plan_id = $1", [id]);

    if (features.length > 0) {
      const values = features.map((_, i) => `($1, (SELECT id FROM features WHERE key = $${i + 2}))`).join(", ");
      await pool.query(
        `INSERT INTO plan_features (plan_id, feature_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [id, ...features]
      );
    }

    // Return updated plan features
    const result = await pool.query(
      `SELECT f.key FROM features f JOIN plan_features pf ON pf.feature_id = f.id WHERE pf.plan_id = $1 ORDER BY f.key`,
      [id]
    );
    res.json({ planId: parseInt(id), features: result.rows.map(r => r.key) });
  } catch (error) {
    console.error("Error updating plan features:", error);
    logError('admin-api', 'PLAN_FEATURES_UPDATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PUT /dashboard/api/users/:id/plan ────────────────────────────────────────

router.put("/api/users/:id/plan", async (req, res) => {
  const { id } = req.params;
  const { planId } = req.body;

  try {
    const result = await pool.query(
      `UPDATE users SET plan_id = $1 WHERE id = $2 RETURNING id, plan_id`,
      [planId, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });

    const planR = await pool.query("SELECT name, display_name FROM plans WHERE id = $1", [planId]);
    res.json({
      userId: parseInt(id),
      planId: planId,
      planName: planR.rows[0]?.name || null,
      planDisplayName: planR.rows[0]?.display_name || null,
    });
  } catch (error) {
    console.error("Error updating user plan:", error);
    logError('admin-api', 'USER_PLAN_UPDATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/users/:id/financial-summary ──────────────────────────

router.get("/api/users/:id/financial-summary", async (req, res) => {
  const { id } = req.params;

  try {
    const [expensesR, incomesR, expCountR, incCountR] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
         WHERE user_id = $1 AND deleted_at IS NULL
         AND date_trunc('month', expense_date) = date_trunc('month', NOW())`,
        [id]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM incomes
         WHERE user_id = $1 AND deleted_at IS NULL
         AND date_trunc('month', income_date) = date_trunc('month', NOW())`,
        [id]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM expenses
         WHERE user_id = $1 AND deleted_at IS NULL
         AND date_trunc('month', expense_date) = date_trunc('month', NOW())`,
        [id]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM incomes
         WHERE user_id = $1 AND deleted_at IS NULL
         AND date_trunc('month', income_date) = date_trunc('month', NOW())`,
        [id]
      ),
    ]);

    const totalExpenses = parseFloat(expensesR.rows[0].total);
    const totalIncome = parseFloat(incomesR.rows[0].total);

    res.json({
      totalExpenses,
      totalIncome,
      balance: totalIncome - totalExpenses,
      transactionCount: parseInt(expCountR.rows[0].count) + parseInt(incCountR.rows[0].count),
    });
  } catch (error) {
    console.error("Error fetching financial summary:", error);
    logError('admin-api', 'FINANCIAL_SUMMARY_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/fallback-logs ────────────────────────────────────────

router.get("/api/fallback-logs", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const userId = req.query.user_id || null;
  const userFilter = req.query.user || null;
  const fromDate = req.query.from || null;
  const toDate = req.query.to || null;

  try {
    let query = `SELECT fl.id, fl.input_text, fl.claude_response, fl.tokens_used, fl.cost_usd, fl.created_at,
              u.name, u.phone_number, fl.user_id
       FROM ai_fallback_logs fl
       JOIN users u ON fl.user_id = u.id`;
    const conditions = [];
    const params = [];

    if (userId) {
      params.push(userId);
      conditions.push(`fl.user_id = $${params.length}`);
    }
    if (userFilter) {
      params.push(`%${userFilter}%`);
      conditions.push(`u.name ILIKE $${params.length}`);
    }
    if (fromDate) {
      params.push(fromDate);
      conditions.push(`fl.created_at >= $${params.length}::date`);
    }
    if (toDate) {
      params.push(toDate);
      conditions.push(`fl.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(' AND ');
    }
    query += ` ORDER BY fl.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    res.json(result.rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      inputText: r.input_text,
      claudeResponse: r.claude_response,
      tokensUsed: r.tokens_used,
      costUsd: parseFloat(r.cost_usd),
      createdAt: r.created_at,
      userName: r.name,
      phone: r.phone_number,
    })));
  } catch (error) {
    console.error("Error fetching fallback logs:", error);
    logError('admin-api', 'FALLBACK_LOGS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/fallback-summary ─────────────────────────────────────

router.get("/api/fallback-summary", async (req, res) => {
  try {
    const [globalR, perUserR] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total_calls,
                COALESCE(SUM(tokens_used), 0) AS total_tokens,
                COALESCE(SUM(cost_usd), 0) AS total_cost,
                COALESCE(AVG(cost_usd), 0) AS avg_cost
         FROM ai_fallback_logs`
      ),
      pool.query(
        `SELECT fl.user_id, u.name, u.phone_number,
                COUNT(*) AS calls,
                COALESCE(SUM(fl.tokens_used), 0) AS tokens,
                COALESCE(SUM(fl.cost_usd), 0) AS cost,
                MAX(fl.created_at) AS last_call
         FROM ai_fallback_logs fl
         JOIN users u ON fl.user_id = u.id
         GROUP BY fl.user_id, u.name, u.phone_number
         ORDER BY calls DESC`
      ),
    ]);

    const row = globalR.rows[0];
    res.json({
      totalCalls: parseInt(row.total_calls),
      totalTokens: parseInt(row.total_tokens),
      totalCost: parseFloat(row.total_cost),
      avgCost: parseFloat(row.avg_cost),
      perUser: perUserR.rows.map(r => ({
        userId: r.user_id,
        name: r.name,
        phone: r.phone_number,
        calls: parseInt(r.calls),
        tokens: parseInt(r.tokens),
        cost: parseFloat(r.cost),
        lastCall: r.last_call,
      })),
    });
  } catch (error) {
    console.error("Error fetching fallback summary:", error);
    logError('admin-api', 'FALLBACK_SUMMARY_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/audio-stats ───────────────────────────────────────────

router.get("/api/audio-stats", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) AS total_audios,
         COALESCE(SUM(audio_duration_seconds), 0) AS total_seconds,
         COALESCE(SUM(cost_usd), 0) AS total_cost,
         COALESCE(AVG(cost_usd), 0) AS avg_cost
       FROM audio_transcription_logs`
    );

    const row = result.rows[0];
    res.json({
      totalAudios: parseInt(row.total_audios),
      totalMinutes: parseFloat((parseFloat(row.total_seconds) / 60).toFixed(2)),
      totalCost: parseFloat(row.total_cost),
      avgCost: parseFloat(row.avg_cost),
    });
  } catch (error) {
    console.error("Error fetching audio stats:", error);
    logError('admin-api', 'AUDIO_STATS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/users/:id/audio-usage ────────────────────────────────

router.get("/api/users/:id/audio-usage", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) AS total_audios,
         COALESCE(SUM(audio_duration_seconds), 0) AS total_seconds,
         COALESCE(SUM(cost_usd), 0) AS total_cost,
         MAX(created_at) AS last_audio
       FROM audio_transcription_logs
       WHERE user_id = $1`,
      [id]
    );

    const row = result.rows[0];
    res.json({
      totalAudios: parseInt(row.total_audios),
      totalMinutes: parseFloat((parseFloat(row.total_seconds) / 60).toFixed(2)),
      totalCost: parseFloat(row.total_cost),
      lastAudio: row.last_audio || null,
    });
  } catch (error) {
    console.error("Error fetching user audio usage:", error);
    logError('admin-api', 'USER_AUDIO_USAGE_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/users/:id/shared-fields ─────────────────────────────

router.get("/api/users/:id/shared-fields", async (req, res) => {
  const { id } = req.params;
  try {
    const [sharedWithMeR, myFieldsSharedR] = await Promise.all([
      // Fields shared WITH this user (they are member, not owner)
      pool.query(
        `SELECT f.id, f.name, f.city, fm.role, fm.created_at AS joined_at,
                owner_u.name AS owner_name, owner_u.phone_number AS owner_phone
         FROM field_members fm
         JOIN fields f ON f.id = fm.field_id
         JOIN field_members owner_fm ON owner_fm.field_id = f.id AND owner_fm.role = 'owner'
         JOIN users owner_u ON owner_u.id = owner_fm.user_id
         WHERE fm.user_id = $1 AND fm.role = 'member' AND f.deleted_at IS NULL
         ORDER BY fm.created_at DESC`, [id]
      ),
      // Fields this user OWNS that are shared with others
      pool.query(
        `SELECT f.id, f.name, f.city, fm.created_at AS shared_since,
                member_u.name AS member_name, member_u.phone_number AS member_phone
         FROM field_members fm
         JOIN fields f ON f.id = fm.field_id
         JOIN field_members owner_fm ON owner_fm.field_id = f.id AND owner_fm.role = 'owner' AND owner_fm.user_id = $1
         JOIN users member_u ON member_u.id = fm.user_id
         WHERE fm.user_id != $1 AND fm.role = 'member' AND f.deleted_at IS NULL
         ORDER BY fm.created_at DESC`, [id]
      ),
    ]);

    res.json({
      sharedWithMe: sharedWithMeR.rows.map(r => ({
        fieldId: r.id,
        fieldName: r.name,
        city: r.city,
        ownerName: r.owner_name,
        ownerPhone: r.owner_phone,
        joinedAt: r.joined_at,
      })),
      myFieldsSharedWith: myFieldsSharedR.rows.map(r => ({
        fieldId: r.id,
        fieldName: r.name,
        city: r.city,
        memberName: r.member_name,
        memberPhone: r.member_phone,
        sharedSince: r.shared_since,
      })),
    });
  } catch (error) {
    console.error("Error fetching user shared fields:", error);
    logError('admin-api', 'USER_SHARED_FIELDS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Agronomy endpoints ─────────────────────────────────────────────────────

router.get("/api/agro/fields", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.*,
         (SELECT COUNT(*) FROM plots WHERE field_id = f.id AND deleted_at IS NULL) AS plot_count,
         (SELECT COUNT(*) FROM agro_observations
          WHERE field_id = f.id
            AND EXTRACT(ISOYEAR FROM created_at) = EXTRACT(ISOYEAR FROM NOW())
            AND EXTRACT(WEEK FROM created_at) = EXTRACT(WEEK FROM NOW())) AS obs_week,
         u.name AS user_name,
         u.id AS uid,
         (SELECT COUNT(*) FROM field_members WHERE field_id = f.id) AS member_count
       FROM fields f
       LEFT JOIN users u ON f.user_id = u.id
       WHERE f.deleted_at IS NULL
       ORDER BY f.name`
    );
    res.json(result.rows.map(r => ({
      id: r.id,
      name: r.name,
      city: r.city,
      province: r.province,
      hectares: r.hectares,
      plotCount: parseInt(r.plot_count),
      obsWeek: parseInt(r.obs_week),
      userName: r.user_name,
      userId: r.uid,
      memberCount: parseInt(r.member_count),
    })));
  } catch (error) {
    console.error("Error fetching agro fields:", error);
    logError('admin-api', 'AGRO_FIELDS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/agro/fields/:id — edit field name/city
router.patch("/api/agro/fields/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, city, province } = req.body;
    const sets = [];
    const vals = [];
    let idx = 1;
    if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name); }
    if (city !== undefined) { sets.push(`city = $${idx++}`); vals.push(city); }
    if (province !== undefined) { sets.push(`province = $${idx++}`); vals.push(province); }
    if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
    vals.push(id);
    await pool.query(`UPDATE fields SET ${sets.join(', ')} WHERE id = $${idx} AND deleted_at IS NULL`, vals);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error updating field:", error);
    logError('admin-api', 'AGRO_FIELD_UPDATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/agro/fields/:id — soft delete
router.delete("/api/agro/fields/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`UPDATE fields SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`, [id]);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error deleting field:", error);
    logError('admin-api', 'AGRO_FIELD_DELETE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/agro/fields/:id", async (req, res) => {
  try {
    const fieldId = req.params.id;
    const [fieldR, plotsR, fieldFinR, plotFinR, rainfallR, membersR] = await Promise.all([
      pool.query(`SELECT f.*, u.name AS user_name FROM fields f LEFT JOIN users u ON f.user_id = u.id WHERE f.id = $1`, [fieldId]),
      pool.query(
        `SELECT p.*,
           pc.crop AS active_crop,
           (SELECT COUNT(*) FROM agro_observations
            WHERE plot_id = p.id
              AND EXTRACT(ISOYEAR FROM created_at) = EXTRACT(ISOYEAR FROM NOW())
              AND EXTRACT(WEEK FROM created_at) = EXTRACT(WEEK FROM NOW())) AS obs_week
         FROM plots p
         LEFT JOIN plot_crops pc ON pc.plot_id = p.id AND pc.end_date IS NULL
         WHERE p.field_id = $1
         ORDER BY p.name`, [fieldId]
      ),
      // Field-level financial totals
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN e.currency = 'ARS' THEN e.amount ELSE 0 END), 0) AS expenses_ars,
           COALESCE(SUM(CASE WHEN e.currency = 'USD' THEN e.amount ELSE 0 END), 0) AS expenses_usd,
           COALESCE((SELECT SUM(CASE WHEN i.currency = 'ARS' THEN i.amount ELSE 0 END) FROM incomes i WHERE i.field_id = $1 AND i.deleted_at IS NULL), 0) AS incomes_ars,
           COALESCE((SELECT SUM(CASE WHEN i.currency = 'USD' THEN i.amount ELSE 0 END) FROM incomes i WHERE i.field_id = $1 AND i.deleted_at IS NULL), 0) AS incomes_usd
         FROM expenses e
         WHERE e.field_id = $1 AND e.deleted_at IS NULL`, [fieldId]
      ),
      // Per-plot financial totals
      pool.query(
        `SELECT
           p.id AS plot_id,
           COALESCE(SUM(CASE WHEN e.currency = 'ARS' THEN e.amount ELSE 0 END), 0) AS expenses_ars,
           COALESCE(SUM(CASE WHEN e.currency = 'USD' THEN e.amount ELSE 0 END), 0) AS expenses_usd
         FROM plots p
         LEFT JOIN expenses e ON e.plot_id = p.id AND e.deleted_at IS NULL
         WHERE p.field_id = $1
         GROUP BY p.id`, [fieldId]
      ),
      // Rainfall current month
      pool.query(
        `SELECT COALESCE(SUM(millimeters), 0) AS total_mm, COUNT(*) AS count
         FROM rainfall
         WHERE field_id = $1
           AND EXTRACT(MONTH FROM rainfall_date) = EXTRACT(MONTH FROM NOW())
           AND EXTRACT(YEAR FROM rainfall_date) = EXTRACT(YEAR FROM NOW())`, [fieldId]
      ),
      // Members
      pool.query(
        `SELECT fm.role, fm.created_at, u.id AS user_id, u.name, u.phone_number
         FROM field_members fm
         JOIN users u ON u.id = fm.user_id
         WHERE fm.field_id = $1
         ORDER BY fm.role DESC, fm.created_at`, [fieldId]
      ),
    ]);

    if (fieldR.rows.length === 0) return res.status(404).json({ error: "Field not found" });
    const field = fieldR.rows[0];
    const fin = fieldFinR.rows[0] || {};

    // Per-plot income totals (separate query to avoid cross-join)
    const plotIncR = await pool.query(
      `SELECT
         p.id AS plot_id,
         COALESCE(SUM(CASE WHEN i.currency = 'ARS' THEN i.amount ELSE 0 END), 0) AS incomes_ars,
         COALESCE(SUM(CASE WHEN i.currency = 'USD' THEN i.amount ELSE 0 END), 0) AS incomes_usd
       FROM plots p
       LEFT JOIN incomes i ON i.plot_id = p.id AND i.deleted_at IS NULL
       WHERE p.field_id = $1
       GROUP BY p.id`, [fieldId]
    );

    const plotExpMap = {};
    for (const r of plotFinR.rows) plotExpMap[r.plot_id] = r;
    const plotIncMap = {};
    for (const r of plotIncR.rows) plotIncMap[r.plot_id] = r;
    const rain = rainfallR.rows[0] || { total_mm: 0, count: 0 };

    res.json({
      id: field.id,
      name: field.name,
      city: field.city,
      province: field.province || null,
      hectares: field.hectares,
      userName: field.user_name,
      userId: field.user_id,
      createdAt: field.created_at,
      totalExpensesARS: parseFloat(fin.expenses_ars) || 0,
      totalExpensesUSD: parseFloat(fin.expenses_usd) || 0,
      totalIncomesARS: parseFloat(fin.incomes_ars) || 0,
      totalIncomesUSD: parseFloat(fin.incomes_usd) || 0,
      rainfallMonth: { totalMm: parseFloat(rain.total_mm) || 0, count: parseInt(rain.count) || 0 },
      members: membersR.rows.map(m => ({
        userId: m.user_id,
        name: m.name,
        phone: m.phone_number,
        role: m.role,
        joinedAt: m.created_at,
      })),
      plots: plotsR.rows.map(p => {
        const pe = plotExpMap[p.id] || {};
        const pi = plotIncMap[p.id] || {};
        return {
          id: p.id,
          name: p.name,
          areaHectares: p.area_hectares,
          activeCrop: p.active_crop || null,
          soilType: p.soil_type || null,
          obsWeek: parseInt(p.obs_week),
          expensesARS: parseFloat(pe.expenses_ars) || 0,
          expensesUSD: parseFloat(pe.expenses_usd) || 0,
          incomesARS: parseFloat(pi.incomes_ars) || 0,
          incomesUSD: parseFloat(pi.incomes_usd) || 0,
        };
      }),
    });
  } catch (error) {
    console.error("Error fetching agro field detail:", error);
    logError('admin-api', 'AGRO_FIELD_DETAIL_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/agro/fields/:id/observations", async (req, res) => {
  try {
    const fieldId = req.params.id;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const { category, plotId, from, to } = req.query;

    const conditions = [`(o.field_id = $1 OR (o.plot_id IS NOT NULL AND p.field_id = $1))`];
    const params = [fieldId];
    let idx = 2;

    if (category) {
      conditions.push(`o.category = $${idx++}`);
      params.push(category);
    }
    if (plotId) {
      conditions.push(`o.plot_id = $${idx++}`);
      params.push(plotId);
    }
    if (from) {
      conditions.push(`o.created_at >= $${idx++}`);
      params.push(from);
    }
    if (to) {
      conditions.push(`o.created_at < ($${idx++}::date + INTERVAL '1 day')`);
      params.push(to);
    }

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT o.*, u.name AS user_name, p.name AS plot_name
       FROM agro_observations o
       LEFT JOIN users u ON o.user_id = u.id
       LEFT JOIN plots p ON o.plot_id = p.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY o.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    res.json(result.rows.map(o => ({
      id: o.id,
      plotName: o.plot_name || 'General del Campo',
      text: o.observation_text,
      category: o.category,
      source: o.source,
      userName: o.user_name,
      createdAt: o.created_at,
    })));
  } catch (error) {
    console.error("Error fetching observations:", error);
    logError('admin-api', 'OBSERVATIONS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/agro/fields/:id/activities", async (req, res) => {
  try {
    const fieldId = req.params.id;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const { plotId, eventType, from, to } = req.query;

    const conditions = [`de.plot_id IN (SELECT id FROM plots WHERE field_id = $1)`];
    const params = [fieldId];
    let idx = 2;

    if (plotId) {
      conditions.push(`de.plot_id = $${idx++}`);
      params.push(plotId);
    }
    if (eventType) {
      conditions.push(`de.event_type = $${idx++}`);
      params.push(eventType);
    }
    if (from) {
      conditions.push(`de.event_date >= $${idx++}`);
      params.push(from);
    }
    if (to) {
      conditions.push(`de.event_date <= $${idx++}`);
      params.push(to);
    }

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT de.*, p.name AS plot_name, u.name AS user_name
       FROM domain_events de
       LEFT JOIN plots p ON de.plot_id = p.id
       LEFT JOIN users u ON de.user_id = u.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY de.event_date DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    res.json(result.rows.map(a => ({
      id: a.id,
      eventType: a.event_type,
      eventDate: a.event_date,
      crop: a.crop,
      product: a.product,
      quantity: a.quantity,
      unit: a.unit,
      implement: a.implement,
      notes: a.notes,
      plotName: a.plot_name,
      userName: a.user_name,
    })));
  } catch (error) {
    console.error("Error fetching field activities:", error);
    logError('admin-api', 'FIELD_ACTIVITIES_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/agro/reports", async (req, res) => {
  try {
    const reports = await getAllReports();
    res.json(reports.map(r => ({
      id: r.id,
      fieldName: r.field_name,
      weekNumber: r.week_number,
      year: r.year,
      userName: r.user_name,
      createdAt: r.created_at,
    })));
  } catch (error) {
    console.error("Error fetching agro reports:", error);
    logError('admin-api', 'AGRO_REPORTS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/agro/fields/:id/reports", async (req, res) => {
  try {
    const reports = await getReportsByField(req.params.id);
    res.json(reports.map(r => ({
      id: r.id,
      weekNumber: r.week_number,
      year: r.year,
      userName: r.user_name,
      createdAt: r.created_at,
    })));
  } catch (error) {
    console.error("Error fetching field reports:", error);
    logError('admin-api', 'FIELD_REPORTS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/api/agro/fields/:id/generate-report", async (req, res) => {
  try {
    const fieldId = parseInt(req.params.id);
    // Find the field's owner user_id
    const fieldR = await pool.query(`SELECT user_id FROM fields WHERE id = $1`, [fieldId]);
    if (fieldR.rows.length === 0) return res.status(404).json({ error: "Field not found" });

    const report = await generateWeeklyReport(fieldR.rows[0].user_id, fieldId);
    res.json({
      id: report.reportId,
      weekNumber: report.weekNumber,
      year: report.year,
      observationCount: report.observationCount,
    });
  } catch (error) {
    console.error("Error generating agro report:", error);
    logError('admin-api', 'AGRO_REPORT_GENERATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/agro/reports/:id/pdf", async (req, res) => {
  try {
    const report = await getReportById(req.params.id);
    if (!report || !report.pdf_path) return res.status(404).json({ error: "Report not found" });
    if (!fs.existsSync(report.pdf_path)) return res.status(404).json({ error: "PDF file not found" });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="reporte_S${report.week_number}_${report.year}.pdf"`);
    fs.createReadStream(report.pdf_path).pipe(res);
  } catch (error) {
    console.error("Error serving report PDF:", error);
    logError('admin-api', 'REPORT_PDF_SERVE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Agro report logo upload ────────────────────────────────────────────────

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Formato no soportado. Usá PNG, JPG o WEBP.'));
  },
});

router.post('/api/agro-report/logo', logoUpload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No se recibió archivo' });
      return;
    }
    const brandingDir = path.resolve(process.cwd(), 'data/branding');
    fs.mkdirSync(brandingDir, { recursive: true });
    const ext = (req.file.mimetype.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const target = path.join(brandingDir, `report-logo.${ext}`);
    // Remove any previous logo (different extension) so only one stays around
    for (const e of ['png', 'jpg', 'webp']) {
      const stale = path.join(brandingDir, `report-logo.${e}`);
      if (stale !== target && fs.existsSync(stale)) { try { fs.unlinkSync(stale); } catch { /* ignore */ } }
    }
    fs.writeFileSync(target, req.file.buffer);
    await setSetting('AGRO_REPORT_LOGO_PATH', target);
    await setSetting('AGRO_REPORT_SHOW_LOGO', 'true');
    res.json({ ok: true, path: target, size: req.file.size });
  } catch (err) {
    console.error('Error uploading logo:', err);
    logError('admin-api', 'AGRO_LOGO_UPLOAD', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.delete('/api/agro-report/logo', async (_req, res) => {
  try {
    const currentPath = (await import('../services/settings.service.js')).getSetting
      ? await (await import('../services/settings.service.js')).getSetting('AGRO_REPORT_LOGO_PATH')
      : '';
    if (currentPath && fs.existsSync(currentPath)) {
      try { fs.unlinkSync(currentPath); } catch { /* ignore */ }
    }
    await setSetting('AGRO_REPORT_LOGO_PATH', '');
    await setSetting('AGRO_REPORT_SHOW_LOGO', 'false');
    res.json({ ok: true });
  } catch (err) {
    logError('admin-api', 'AGRO_LOGO_DELETE', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── System settings endpoints ──────────────────────────────────────────────

router.get("/api/settings", async (req, res) => {
  try {
    const settings = await getAllSettings();
    res.json(settings);
  } catch (error) {
    console.error("Error fetching settings:", error);
    logError('admin-api', 'SETTINGS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/api/settings", async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: "Invalid request body" });
    }

    const results = {};
    for (const [key, value] of Object.entries(updates)) {
      // Security: block secrets
      if (SECRET_KEYS.has(key)) {
        results[key] = { error: 'Cannot modify secret keys' };
        continue;
      }
      // Only allow defined settings
      if (!SETTING_DEFINITIONS[key]) {
        results[key] = { error: 'Unknown setting' };
        continue;
      }
      await setSetting(key, value);
      results[key] = { ok: true };
      // Audit log
      pool.query(
        `INSERT INTO admin_audit_log (admin_ip, action, entity_type, details)
         VALUES ($1, 'setting_changed', 'system_setting', $2)`,
        [req.ip, JSON.stringify({ key, value })]
      ).catch(() => {});
    }

    res.json(results);
  } catch (error) {
    console.error("Error updating settings:", error);
    logError('admin-api', 'SETTINGS_UPDATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Error logs endpoints ────────────────────────────────────────────────────

router.get("/api/errors/filters", async (req, res) => {
  try {
    const filters = await getErrorFilters();
    res.json(filters);
  } catch (error) {
    console.error("Error fetching error filters:", error);
    logError('admin-api', 'FILTERS_ERROR', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/errors", async (req, res) => {
  try {
    const { service, severity, user_id, error_type, date_from, date_to, limit, offset } = req.query;
    const result = await getErrorLogs({
      service: service || undefined,
      severity: severity || undefined,
      userId: user_id ? parseInt(user_id) : undefined,
      errorType: error_type || undefined,
      dateFrom: date_from || undefined,
      dateTo: date_to || undefined,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    });
    res.json(result);
  } catch (error) {
    console.error("Error fetching error logs:", error);
    logError('admin-api', 'ERROR_LOGS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/errors/stats", async (req, res) => {
  try {
    const stats = await getErrorStats();
    res.json(stats);
  } catch (error) {
    console.error("Error fetching error stats:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/errors/:id", async (req, res) => {
  try {
    const errorLog = await getErrorById(req.params.id);
    if (!errorLog) return res.status(404).json({ error: "Error log not found" });
    res.json(errorLog);
  } catch (error) {
    console.error("Error fetching error log:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/parser-errors ────────────────────────────────────────

router.get("/api/parser-errors", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const reason = req.query.reason || null;

    let query = `SELECT pe.*, u.phone_number, u.name as user_name
                 FROM parser_errors pe
                 LEFT JOIN users u ON pe.user_id = u.id`;
    const params = [];
    if (reason) {
      query += ` WHERE pe.error_reason = $1`;
      params.push(reason);
    }
    query += ` ORDER BY pe.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    let countQuery = `SELECT COUNT(*) FROM parser_errors`;
    const countParams = [];
    if (reason) {
      countQuery += ` WHERE error_reason = $1`;
      countParams.push(reason);
    }
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      errors: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (error) {
    console.error("Error fetching parser errors:", error);
    logError('admin-api', 'PARSER_ERRORS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/parser-errors/stats ──────────────────────────────────

router.get("/api/parser-errors/stats", async (req, res) => {
  try {
    const [byReason, weeklyTrend, total] = await Promise.all([
      pool.query(
        `SELECT error_reason, COUNT(*) as count
         FROM parser_errors
         WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
         GROUP BY error_reason
         ORDER BY count DESC`
      ),
      pool.query(
        `SELECT date_trunc('day', created_at)::date as day, COUNT(*) as count
         FROM parser_errors
         WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
         GROUP BY day
         ORDER BY day`
      ),
      pool.query(`SELECT COUNT(*) as total FROM parser_errors`),
    ]);

    res.json({
      byReason: byReason.rows,
      weeklyTrend: weeklyTrend.rows,
      total: parseInt(total.rows[0].total),
    });
  } catch (error) {
    console.error("Error fetching parser error stats:", error);
    logError('admin-api', 'PARSER_ERROR_STATS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/conversation-stats ────────────────────────────────────

router.get("/api/conversation-stats", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
  const userId = req.query.user_id ? parseInt(req.query.user_id) : null;

  try {
    const userFilter = userId ? ' AND ce.user_id = $2' : '';
    const params = [days];
    if (userId) params.push(userId);

    const [messagesR, perDayR, intentsR, topCmdsR, flowsR, flowByFlowR, abandonStepR, abandonReasonR, errorsR, errorsByTypeR] = await Promise.all([
      // Messages summary
      pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE ce.metadata->>'messageType' = 'text') AS text_count,
           COUNT(*) FILTER (WHERE ce.metadata->>'messageType' = 'audio') AS audio_count,
           COUNT(*) FILTER (WHERE ce.metadata->>'messageType' = 'interactive') AS interactive_count,
           COUNT(DISTINCT ce.user_id) AS unique_users
         FROM conversation_events ce
         WHERE ce.event_type = 'message_received'
           AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'${userFilter}`,
        params,
      ),
      // Messages per day
      pool.query(
        `SELECT
           date_trunc('day', ce.created_at)::date AS date,
           COUNT(*) AS count,
           COUNT(*) FILTER (WHERE ce.metadata->>'messageType' = 'text') AS text_count,
           COUNT(*) FILTER (WHERE ce.metadata->>'messageType' = 'audio') AS audio_count
         FROM conversation_events ce
         WHERE ce.event_type = 'message_received'
           AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'${userFilter}
         GROUP BY date ORDER BY date`,
        params,
      ),
      // Intent distribution
      pool.query(
        `SELECT
           ce.intent_type,
           COUNT(*) AS count,
           COUNT(*) FILTER (WHERE ce.metadata->>'aiUsed' = 'true') AS ai_fallback_count,
           AVG(ce.confidence) AS avg_confidence
         FROM conversation_events ce
         WHERE ce.event_type = 'intent_detected'
           AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'${userFilter}
         GROUP BY ce.intent_type
         ORDER BY count DESC`,
        params,
      ),
      // Top commands
      pool.query(
        `SELECT ce.intent_command AS command, COUNT(*) AS count
         FROM conversation_events ce
         WHERE ce.event_type = 'command_executed'
           AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'${userFilter}
         GROUP BY ce.intent_command
         ORDER BY count DESC
         LIMIT 20`,
        params,
      ),
      // Flow totals
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE ce.event_type = 'flow_started') AS started,
           COUNT(*) FILTER (WHERE ce.event_type = 'flow_completed') AS completed,
           COUNT(*) FILTER (WHERE ce.event_type = 'flow_abandoned') AS abandoned
         FROM conversation_events ce
         WHERE ce.event_type IN ('flow_started', 'flow_completed', 'flow_abandoned')
           AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'${userFilter}`,
        params,
      ),
      // Flow by flow_state
      pool.query(
        `SELECT
           ce.flow_state,
           COUNT(*) FILTER (WHERE ce.event_type = 'flow_started') AS started,
           COUNT(*) FILTER (WHERE ce.event_type = 'flow_completed') AS completed,
           COUNT(*) FILTER (WHERE ce.event_type = 'flow_abandoned') AS abandoned
         FROM conversation_events ce
         WHERE ce.event_type IN ('flow_started', 'flow_completed', 'flow_abandoned')
           AND ce.flow_state IS NOT NULL
           AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'${userFilter}
         GROUP BY ce.flow_state
         ORDER BY started DESC`,
        params,
      ),
      // Abandonment by step
      pool.query(
        `SELECT ce.flow_state, ce.flow_step, COUNT(*) AS count
         FROM conversation_events ce
         WHERE ce.event_type = 'flow_abandoned'
           AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'${userFilter}
         GROUP BY ce.flow_state, ce.flow_step
         ORDER BY count DESC`,
        params,
      ),
      // Abandonment reasons
      pool.query(
        `SELECT ce.metadata->>'reason' AS reason, COUNT(*) AS count
         FROM conversation_events ce
         WHERE ce.event_type = 'flow_abandoned'
           AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'${userFilter}
         GROUP BY reason
         ORDER BY count DESC`,
        params,
      ),
      // Error total
      pool.query(
        `SELECT COUNT(*) AS total
         FROM conversation_events ce
         WHERE ce.event_type = 'error'
           AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'${userFilter}`,
        params,
      ),
      // Errors by type
      pool.query(
        `SELECT ce.metadata->>'errorType' AS error_type, COUNT(*) AS count
         FROM conversation_events ce
         WHERE ce.event_type = 'error'
           AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'${userFilter}
         GROUP BY error_type
         ORDER BY count DESC`,
        params,
      ),
    ]);

    const m = messagesR.rows[0];
    const f = flowsR.rows[0];
    const fStarted = parseInt(f.started);
    const fCompleted = parseInt(f.completed);
    const fAbandoned = parseInt(f.abandoned);

    // Compute unknown + fallback from intents
    let unknownCount = 0;
    let aiFallbackCount = 0;
    let totalIntents = 0;
    let confidenceSum = 0;
    const distribution = intentsR.rows.map(r => {
      const count = parseInt(r.count);
      totalIntents += count;
      if (r.intent_type === 'unknown') unknownCount = count;
      aiFallbackCount += parseInt(r.ai_fallback_count);
      confidenceSum += parseFloat(r.avg_confidence || 0) * count;
      return { intentType: r.intent_type, count };
    });
    // Add percentage
    const distributionWithPct = distribution.map(d => ({
      ...d,
      pct: totalIntents > 0 ? Math.round((d.count / totalIntents) * 1000) / 10 : 0,
    }));

    const now = new Date();
    const from = new Date(now.getTime() - days * 86400000);

    res.json({
      period: { days, from: from.toISOString(), to: now.toISOString() },
      messages: {
        total: parseInt(m.total),
        textCount: parseInt(m.text_count),
        audioCount: parseInt(m.audio_count),
        interactiveCount: parseInt(m.interactive_count),
        uniqueUsers: parseInt(m.unique_users),
        perDay: perDayR.rows.map(r => ({
          date: r.date,
          count: parseInt(r.count),
          textCount: parseInt(r.text_count),
          audioCount: parseInt(r.audio_count),
        })),
      },
      intents: {
        distribution: distributionWithPct,
        topCommands: topCmdsR.rows.map(r => ({ command: r.command, count: parseInt(r.count) })),
        unknownCount,
        aiFallbackCount,
        avgConfidence: totalIntents > 0 ? Math.round((confidenceSum / totalIntents) * 100) / 100 : 0,
      },
      flows: {
        started: fStarted,
        completed: fCompleted,
        abandoned: fAbandoned,
        completionRate: fStarted > 0 ? Math.round((fCompleted / fStarted) * 1000) / 10 : 0,
        byFlow: flowByFlowR.rows.map(r => {
          const s = parseInt(r.started);
          const c = parseInt(r.completed);
          const a = parseInt(r.abandoned);
          return {
            flowState: r.flow_state,
            started: s,
            completed: c,
            abandoned: a,
            completionRate: s > 0 ? Math.round((c / s) * 1000) / 10 : 0,
          };
        }),
        abandonmentByStep: abandonStepR.rows.map(r => ({
          flowState: r.flow_state,
          flowStep: r.flow_step,
          count: parseInt(r.count),
        })),
        abandonmentReasons: abandonReasonR.rows.map(r => ({
          reason: r.reason,
          count: parseInt(r.count),
        })),
      },
      errors: {
        total: parseInt(errorsR.rows[0].total),
        byType: errorsByTypeR.rows.map(r => ({
          errorType: r.error_type,
          count: parseInt(r.count),
        })),
      },
    });
  } catch (error) {
    console.error("Error fetching conversation stats:", error);
    logError('admin-api', 'CONVERSATION_STATS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/conversation-stats/unknown-phrases ───────────────────

router.get("/api/conversation-stats/unknown-phrases", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);

  try {
    const result = await pool.query(
      `SELECT message, COUNT(*) AS count
       FROM unparsed_messages
       WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
       GROUP BY message
       ORDER BY count DESC
       LIMIT 50`,
      [days],
    );

    res.json({
      period: { days },
      phrases: result.rows.map(r => ({
        phrase: r.message,
        count: parseInt(r.count),
      })),
    });
  } catch (error) {
    console.error("Error fetching unknown phrases:", error);
    logError('admin-api', 'UNKNOWN_PHRASES_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/conversation-stats/user-journey/:userId ──────────────

router.get("/api/conversation-stats/user-journey/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, event_type, flow_state, flow_step, intent_type, intent_command,
              confidence, source, metadata, session_id, created_at
       FROM conversation_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId],
    );

    res.json({
      userId: parseInt(userId),
      events: result.rows.map(r => ({
        id: r.id,
        eventType: r.event_type,
        flowState: r.flow_state,
        flowStep: r.flow_step,
        intentType: r.intent_type,
        intentCommand: r.intent_command,
        confidence: r.confidence ? parseFloat(r.confidence) : null,
        source: r.source,
        metadata: r.metadata,
        sessionId: r.session_id,
        createdAt: r.created_at,
      })),
    });
  } catch (error) {
    console.error("Error fetching user journey:", error);
    logError('admin-api', 'USER_JOURNEY_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/deletion-log ──────────────────────────────────────────

router.get("/api/deletion-log", async (req, res) => {
  try {
    const { type, limit = 50 } = req.query;
    let query = `
      SELECT dl.*, u.phone_number, u.name as user_name
      FROM deletion_log dl
      JOIN users u ON dl.user_id = u.id
    `;
    const params = [];
    if (type) {
      params.push(type);
      query += ` WHERE dl.entity_type = $${params.length}`;
    }
    query += ` ORDER BY dl.deleted_at DESC`;
    params.push(parseInt(limit) || 50);
    query += ` LIMIT $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ deletionLog: result.rows });
  } catch (error) {
    console.error("Error fetching deletion log:", error);
    logError('admin-api', 'DELETION_LOG_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── PUT /dashboard/api/users/:id/status ─────────────────────────────────────

router.put("/api/users/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['active', 'suspended', 'disabled'].includes(status)) {
      return res.status(400).json({ error: "Invalid status. Must be: active, suspended, disabled" });
    }

    const result = await pool.query(
      `UPDATE users SET status = $1 WHERE id = $2 RETURNING id, status`,
      [status, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });

    // Audit log
    await pool.query(
      `INSERT INTO admin_audit_log (admin_ip, action, entity_type, entity_id, details)
       VALUES ($1, 'user_status_change', 'user', $2, $3)`,
      [req.ip, id, JSON.stringify({ newStatus: status })]
    ).catch(() => {});

    res.json({ ok: true, status: result.rows[0].status });
  } catch (error) {
    console.error("Error updating user status:", error);
    logError('admin-api', 'USER_STATUS_UPDATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /dashboard/api/users ────────────────────────────────────────────────

router.post("/api/users", async (req, res) => {
  try {
    const { name, last_name, phone, city, email, province } = req.body;
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: "El teléfono es obligatorio" });
    }

    // Check duplicate phone
    const existing = await pool.query("SELECT id FROM users WHERE phone_number = $1", [phone.trim()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Ya existe un usuario con ese teléfono" });
    }

    const result = await pool.query(
      `INSERT INTO users (phone_number, name, last_name, city, email, province, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       RETURNING *`,
      [phone.trim(), name || null, last_name || null, city || null, email || null, province || null]
    );

    const u = result.rows[0];

    // Audit log
    await pool.query(
      `INSERT INTO admin_audit_log (admin_ip, action, entity_type, entity_id, details)
       VALUES ($1, 'user_create', 'user', $2, $3)`,
      [req.ip, u.id, JSON.stringify({ phone: u.phone_number, name: u.name })]
    ).catch(() => {});

    res.status(201).json({
      id: u.id,
      name: u.name,
      lastName: u.last_name || null,
      phone: u.phone_number,
      city: u.city,
      province: u.province || null,
      email: u.email || null,
      status: u.status || 'active',
    });
  } catch (error) {
    console.error("Error creating user:", error);
    logError('admin-api', 'USER_CREATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── DELETE /dashboard/api/users/:id ─────────────────────────────────────────

router.delete("/api/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const userR = await pool.query("SELECT id, phone_number, name FROM users WHERE id = $1", [id]);
    if (userR.rows.length === 0) return res.status(404).json({ error: "User not found" });

    // Hard delete (cascade will handle related rows if FK has ON DELETE CASCADE,
    // otherwise we clean up manually)
    const u = userR.rows[0];

    // Delete related data in correct order
    await pool.query("DELETE FROM conversation_events WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM conversation_state WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM conversation_logs WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM ai_usage WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM ai_fallback_logs WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM audio_transcription_logs WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM unparsed_messages WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM parser_errors WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM domain_events WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM message_patterns WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM farmer_vocabulary WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM deletion_log WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM rainfall WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM budgets WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM expenses WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM incomes WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM agro_observations WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM agronomic_reports WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM user_settings WHERE user_id = $1", [id]);
    // Delete plots under fields, then fields
    await pool.query("DELETE FROM plots WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)", [id]);
    await pool.query("DELETE FROM fields WHERE user_id = $1", [id]);
    await pool.query("DELETE FROM users WHERE id = $1", [id]);

    // Audit log
    await pool.query(
      `INSERT INTO admin_audit_log (admin_ip, action, entity_type, entity_id, details)
       VALUES ($1, 'user_delete', 'user', $2, $3)`,
      [req.ip, parseInt(id), JSON.stringify({ phone: u.phone_number, name: u.name })]
    ).catch(() => {});

    res.json({ ok: true });
  } catch (error) {
    console.error("Error deleting user:", error);
    logError('admin-api', 'USER_DELETE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/analytics/overview ───────────────────────────────────

router.get("/api/analytics/overview", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 90);

  try {
    const [usersR, messagesR, expensesR, incomesR, rainfallR, activitiesR, aiR, fallbackR] = await Promise.all([
      // User counts
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE last_message_at >= NOW() - INTERVAL '7 days') AS active_week,
          COUNT(*) FILTER (WHERE last_message_at >= NOW() - INTERVAL '30 days') AS active_month,
          COUNT(*) FILTER (WHERE status = 'suspended' OR status = 'disabled') AS inactive
        FROM users
      `),
      // Messages
      pool.query(`
        SELECT COUNT(*) AS total
        FROM conversation_events
        WHERE event_type = 'message_received'
          AND created_at >= NOW() - $1::int * INTERVAL '1 day'
      `, [days]),
      // Expenses
      pool.query(`
        SELECT COUNT(*) AS total, COALESCE(SUM(amount), 0) AS sum_ars
        FROM expenses
        WHERE deleted_at IS NULL AND created_at >= NOW() - $1::int * INTERVAL '1 day'
      `, [days]),
      // Incomes
      pool.query(`
        SELECT COUNT(*) AS total, COALESCE(SUM(amount), 0) AS sum_ars
        FROM incomes
        WHERE deleted_at IS NULL AND created_at >= NOW() - $1::int * INTERVAL '1 day'
      `, [days]),
      // Rainfall
      pool.query(`
        SELECT COUNT(*) AS total
        FROM rainfall
        WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
      `, [days]),
      // Activities
      pool.query(`
        SELECT COUNT(*) AS total
        FROM domain_events
        WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
      `, [days]),
      // AI usage (Haiku 4.5: input 0.80/M, cache read 0.08/M, cache write 1.00/M, output 4.00/M)
      pool.query(`
        SELECT
          COUNT(*) AS calls,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(
            input_tokens / 1000000.0 * 0.80
            + COALESCE(cache_read_tokens, 0) / 1000000.0 * 0.08
            + COALESCE(cache_write_tokens, 0) / 1000000.0 * 1.00
            + output_tokens / 1000000.0 * 4.00
          ), 0) AS cost_usd
        FROM ai_usage
        WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
      `, [days]),
      // Conversational fallback
      pool.query(`
        SELECT COUNT(*) AS total
        FROM ai_fallback_logs
        WHERE claude_response LIKE '%conversational_fallback%'
          AND created_at >= NOW() - $1::int * INTERVAL '1 day'
      `, [days]),
    ]);

    const u = usersR.rows[0];
    const ai = aiR.rows[0];

    res.json({
      period: { days },
      users: {
        total: parseInt(u.total),
        activeWeek: parseInt(u.active_week),
        activeMonth: parseInt(u.active_month),
        inactive: parseInt(u.inactive),
      },
      messages: { total: parseInt(messagesR.rows[0].total) },
      expenses: {
        count: parseInt(expensesR.rows[0].total),
        totalArs: parseFloat(expensesR.rows[0].sum_ars),
      },
      incomes: {
        count: parseInt(incomesR.rows[0].total),
        totalArs: parseFloat(incomesR.rows[0].sum_ars),
      },
      rainfall: { count: parseInt(rainfallR.rows[0].total) },
      activities: { count: parseInt(activitiesR.rows[0].total) },
      ai: {
        calls: parseInt(ai.calls),
        inputTokens: parseInt(ai.input_tokens),
        outputTokens: parseInt(ai.output_tokens),
        costUsd: parseFloat(ai.cost_usd),
        conversationalFallbacks: parseInt(fallbackR.rows[0].total),
      },
    });
  } catch (error) {
    console.error("Error fetching analytics overview:", error);
    logError('admin-api', 'ANALYTICS_OVERVIEW_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/analytics/ai-tokens ──────────────────────────────────

router.get("/api/analytics/ai-tokens", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 90);

  try {
    const [perDayR, bySourceR] = await Promise.all([
      // Per-day cost (Haiku 4.5 full pricing incl. cache)
      pool.query(`
        SELECT
          date_trunc('day', created_at)::date AS date,
          COUNT(*) AS calls,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(
            input_tokens / 1000000.0 * 0.80
            + COALESCE(cache_read_tokens, 0) / 1000000.0 * 0.08
            + COALESCE(cache_write_tokens, 0) / 1000000.0 * 1.00
            + output_tokens / 1000000.0 * 4.00
          ) AS cost_usd
        FROM ai_usage
        WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
        GROUP BY date ORDER BY date
      `, [days]),
      // By source — derive from ai_fallback_logs (has source type in claude_response JSON)
      pool.query(`
        SELECT
          CASE
            WHEN claude_response LIKE '%agent_tool_use%' THEN 'agent_tool_use'
            WHEN claude_response LIKE '%ai_intent%' THEN 'intent_extraction'
            WHEN claude_response LIKE '%conversational_fallback%' THEN 'conversational_fallback'
            ELSE 'legacy_fallback'
          END AS source,
          COUNT(*) AS calls,
          COALESCE(SUM(tokens_used), 0) AS tokens,
          COALESCE(SUM(cost_usd), 0) AS cost_usd
        FROM ai_fallback_logs
        WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
        GROUP BY source
        ORDER BY calls DESC
      `, [days]),
    ]);

    res.json({
      period: { days },
      perDay: perDayR.rows.map(r => ({
        date: r.date,
        calls: parseInt(r.calls),
        inputTokens: parseInt(r.input_tokens),
        outputTokens: parseInt(r.output_tokens),
        costUsd: parseFloat(r.cost_usd),
      })),
      bySource: bySourceR.rows.map(r => ({
        source: r.source,
        calls: parseInt(r.calls),
        tokens: parseInt(r.tokens),
        costUsd: parseFloat(r.cost_usd),
      })),
    });
  } catch (error) {
    console.error("Error fetching AI token analytics:", error);
    logError('admin-api', 'AI_TOKEN_ANALYTICS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/analytics/parse-rates ────────────────────────────────

router.get("/api/analytics/parse-rates", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);

  try {
    const result = await pool.query(`
      SELECT
        ce.source,
        COUNT(*) AS count,
        AVG(ce.confidence) AS avg_confidence
      FROM conversation_events ce
      WHERE ce.event_type = 'intent_detected'
        AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'
      GROUP BY ce.source
      ORDER BY count DESC
    `, [days]);

    const total = result.rows.reduce((sum, r) => sum + parseInt(r.count), 0);

    res.json({
      period: { days },
      total,
      bySource: result.rows.map(r => ({
        source: r.source,
        count: parseInt(r.count),
        pct: total > 0 ? Math.round((parseInt(r.count) / total) * 1000) / 10 : 0,
        avgConfidence: r.avg_confidence ? Math.round(parseFloat(r.avg_confidence) * 100) / 100 : null,
      })),
    });
  } catch (error) {
    console.error("Error fetching parse rates:", error);
    logError('admin-api', 'PARSE_RATES_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/analytics/bot-performance ────────────────────────────

router.get("/api/analytics/bot-performance", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);

  try {
    const [intentR, responseTimeR, flowR] = await Promise.all([
      // Intent success rate
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE ce.intent_type != 'unknown') AS recognized,
          COUNT(*) FILTER (WHERE ce.intent_type = 'unknown') AS unknown,
          COUNT(*) FILTER (WHERE ce.metadata->>'aiUsed' = 'true') AS ai_used,
          AVG(ce.confidence) FILTER (WHERE ce.confidence IS NOT NULL) AS avg_confidence
        FROM conversation_events ce
        WHERE ce.event_type = 'intent_detected'
          AND ce.created_at >= NOW() - $1::int * INTERVAL '1 day'
      `, [days]),
      // Average response time
      pool.query(`
        SELECT AVG(processing_time_ms) AS avg_ms, PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY processing_time_ms) AS p95_ms
        FROM conversation_logs
        WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
          AND processing_time_ms IS NOT NULL
      `, [days]),
      // Flow metrics
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'flow_started') AS started,
          COUNT(*) FILTER (WHERE event_type = 'flow_completed') AS completed,
          COUNT(*) FILTER (WHERE event_type = 'flow_abandoned') AS abandoned
        FROM conversation_events
        WHERE event_type IN ('flow_started', 'flow_completed', 'flow_abandoned')
          AND created_at >= NOW() - $1::int * INTERVAL '1 day'
      `, [days]),
    ]);

    const i = intentR.rows[0];
    const totalIntents = parseInt(i.total);
    const recognized = parseInt(i.recognized);
    const f = flowR.rows[0];
    const fStarted = parseInt(f.started);

    res.json({
      period: { days },
      intents: {
        total: totalIntents,
        recognized,
        unknown: parseInt(i.unknown),
        recognitionRate: totalIntents > 0 ? Math.round((recognized / totalIntents) * 1000) / 10 : 0,
        aiUsedCount: parseInt(i.ai_used),
        aiRate: totalIntents > 0 ? Math.round((parseInt(i.ai_used) / totalIntents) * 1000) / 10 : 0,
        avgConfidence: i.avg_confidence ? Math.round(parseFloat(i.avg_confidence) * 100) / 100 : null,
      },
      responseTime: {
        avgMs: responseTimeR.rows[0].avg_ms ? Math.round(parseFloat(responseTimeR.rows[0].avg_ms)) : null,
        p95Ms: responseTimeR.rows[0].p95_ms ? Math.round(parseFloat(responseTimeR.rows[0].p95_ms)) : null,
      },
      flows: {
        started: fStarted,
        completed: parseInt(f.completed),
        abandoned: parseInt(f.abandoned),
        completionRate: fStarted > 0 ? Math.round((parseInt(f.completed) / fStarted) * 1000) / 10 : 0,
      },
    });
  } catch (error) {
    console.error("Error fetching bot performance:", error);
    logError('admin-api', 'BOT_PERFORMANCE_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /dashboard/api/audit-log ────────────────────────────────────────────

router.get("/api/audit-log", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const result = await pool.query(
      `SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ entries: result.rows });
  } catch (error) {
    console.error("Error fetching audit log:", error);
    logError('admin-api', 'AUDIT_LOG_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── AI Training endpoints ───────────────────────────────────────────────────

// List training examples with pagination + intent filter
router.get("/api/ai-training/examples", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const intent = req.query.intent || null;

    let query = `SELECT * FROM ai_training_examples`;
    const params = [];
    if (intent) {
      params.push(intent);
      query += ` WHERE intent = $${params.length}`;
    }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    let countQuery = `SELECT COUNT(*) FROM ai_training_examples`;
    const countParams = [];
    if (intent) {
      countParams.push(intent);
      countQuery += ` WHERE intent = $1`;
    }
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      examples: result.rows,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error("Error fetching training examples:", error);
    logError('admin-api', 'TRAINING_EXAMPLES_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create training example
router.post("/api/ai-training/examples", async (req, res) => {
  try {
    const { input, expected_output, intent, is_active } = req.body;
    if (!input || !expected_output || !intent) {
      return res.status(400).json({ error: "input, expected_output, and intent are required" });
    }

    const result = await pool.query(
      `INSERT INTO ai_training_examples (input, expected_output, intent, is_active, source)
       VALUES ($1, $2, $3, $4, 'manual')
       RETURNING *`,
      [input, JSON.stringify(expected_output), intent, is_active !== false],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating training example:", error);
    logError('admin-api', 'TRAINING_EXAMPLE_CREATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update training example
router.put("/api/ai-training/examples/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { input, expected_output, intent, is_active } = req.body;

    const result = await pool.query(
      `UPDATE ai_training_examples
       SET input = COALESCE($1, input),
           expected_output = COALESCE($2, expected_output),
           intent = COALESCE($3, intent),
           is_active = COALESCE($4, is_active),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [
        input || null,
        expected_output ? JSON.stringify(expected_output) : null,
        intent || null,
        is_active != null ? is_active : null,
        id,
      ],
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Example not found" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating training example:", error);
    logError('admin-api', 'TRAINING_EXAMPLE_UPDATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete training example
router.delete("/api/ai-training/examples/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM ai_training_examples WHERE id = $1 RETURNING id`,
      [req.params.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Example not found" });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error deleting training example:", error);
    logError('admin-api', 'TRAINING_EXAMPLE_DELETE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// List AI conversation logs (for feedback)
router.get("/api/ai-training/logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 70, 500);
    const offset = parseInt(req.query.offset) || 0;
    const reviewed = req.query.reviewed; // 'true', 'false', or unset

    let whereClause = `WHERE cl.ai_used = true`;
    if (reviewed === 'true') {
      whereClause += ` AND cl.was_correct IS NOT NULL`;
    } else if (reviewed === 'false') {
      whereClause += ` AND cl.was_correct IS NULL`;
    }

    const countQuery = `SELECT COUNT(*)::int AS total FROM conversation_logs cl ${whereClause}`;
    const dataQuery = `SELECT cl.*, u.name AS user_name
                       FROM conversation_logs cl
                       LEFT JOIN users u ON cl.user_id = u.id
                       ${whereClause}
                       ORDER BY cl.created_at DESC
                       LIMIT $1 OFFSET $2`;

    const [countResult, dataResult] = await Promise.all([
      pool.query(countQuery),
      pool.query(dataQuery, [limit, offset]),
    ]);

    res.json({
      logs: dataResult.rows,
      total: countResult.rows[0].total,
      limit,
      offset,
    });
  } catch (error) {
    console.error("Error fetching AI training logs:", error);
    logError('admin-api', 'AI_TRAINING_LOGS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Submit feedback on a conversation log
router.patch("/api/ai-training/logs/:id/feedback", async (req, res) => {
  try {
    const { id } = req.params;
    const { was_correct, corrected_intent } = req.body;

    if (was_correct === undefined) {
      return res.status(400).json({ error: "was_correct is required" });
    }

    const result = await pool.query(
      `UPDATE conversation_logs
       SET was_correct = $1, corrected_intent = $2
       WHERE id = $3
       RETURNING id, was_correct, corrected_intent`,
      [was_correct, corrected_intent || null, id],
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Log not found" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error saving feedback:", error);
    logError('admin-api', 'FEEDBACK_SAVE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Promote a corrected log to a training example
router.post("/api/ai-training/promote/:logId", async (req, res) => {
  try {
    const { logId } = req.params;

    const logR = await pool.query(
      `SELECT message_text, intent_type, intent_command, corrected_intent, was_correct
       FROM conversation_logs WHERE id = $1`,
      [logId],
    );
    if (logR.rows.length === 0) return res.status(404).json({ error: "Log not found" });

    const log = logR.rows[0];
    const intent = log.corrected_intent || log.intent_command || log.intent_type;
    if (!intent) return res.status(400).json({ error: "No intent to promote" });

    const expectedOutput = { intent, confidence: 1.0 };

    const result = await pool.query(
      `INSERT INTO ai_training_examples (input, expected_output, intent, is_active, source)
       VALUES ($1, $2, $3, true, 'promoted')
       RETURNING *`,
      [log.message_text, JSON.stringify(expectedOutput), intent],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error promoting log:", error);
    logError('admin-api', 'LOG_PROMOTE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// AI Training stats
router.get("/api/ai-training/stats", async (req, res) => {
  try {
    const [accuracyR, examplesR, topFailuresR, intentDistR] = await Promise.all([
      // Accuracy (last 30 days)
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE was_correct IS NOT NULL) AS reviewed,
          COUNT(*) FILTER (WHERE was_correct = true) AS correct,
          COUNT(*) FILTER (WHERE was_correct = false) AS incorrect
        FROM conversation_logs
        WHERE ai_used = true AND created_at >= NOW() - INTERVAL '30 days'
      `),
      // Active examples count
      pool.query(`SELECT COUNT(*) AS total FROM ai_training_examples WHERE is_active = true`),
      // Top failure intents (incorrect predictions, last 30 days)
      pool.query(`
        SELECT
          COALESCE(corrected_intent, intent_command, intent_type) AS intent,
          COUNT(*) AS count
        FROM conversation_logs
        WHERE was_correct = false
          AND ai_used = true
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY intent
        ORDER BY count DESC
        LIMIT 10
      `),
      // Intent distribution (last 30 days)
      pool.query(`
        SELECT
          COALESCE(intent_command, intent_type) AS intent,
          COUNT(*) AS count,
          AVG(confidence) AS avg_confidence
        FROM conversation_logs
        WHERE ai_used = true
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY intent
        ORDER BY count DESC
        LIMIT 20
      `),
    ]);

    const acc = accuracyR.rows[0];
    const reviewed = parseInt(acc.reviewed);
    const correct = parseInt(acc.correct);

    res.json({
      accuracy: reviewed > 0 ? Math.round((correct / reviewed) * 1000) / 10 : null,
      reviewed,
      correct,
      incorrect: parseInt(acc.incorrect),
      activeExamples: parseInt(examplesR.rows[0].total),
      topFailures: topFailuresR.rows.map(r => ({
        intent: r.intent,
        count: parseInt(r.count),
      })),
      intentDistribution: intentDistR.rows.map(r => ({
        intent: r.intent,
        count: parseInt(r.count),
        avgConfidence: r.avg_confidence ? Math.round(parseFloat(r.avg_confidence) * 100) / 100 : null,
      })),
    });
  } catch (error) {
    console.error("Error fetching AI training stats:", error);
    logError('admin-api', 'AI_TRAINING_STATS_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Activity Dictionary endpoints ──────────────────────────────────────────

router.get("/api/ai-training/dictionary", async (req, res) => {
  try {
    const entries = await getActivityDictionary();
    res.json({ entries });
  } catch (error) {
    console.error("Error fetching activity dictionary:", error);
    logError('admin-api', 'ACTIVITY_DICTIONARY_FETCH', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/api/ai-training/dictionary/:activityType", async (req, res) => {
  try {
    const { activityType } = req.params;
    const { synonyms } = req.body;
    if (typeof synonyms !== 'string') {
      return res.status(400).json({ error: "synonyms (string) is required" });
    }
    await updateActivitySynonyms(activityType, synonyms);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error updating activity dictionary:", error);
    logError('admin-api', 'ACTIVITY_DICTIONARY_UPDATE', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================
// Customer support tools (admin → end-user)
// ============================================================
//
// Helpers + endpoints to let an admin investigate and fix data on
// behalf of a user that wrote in: list their gastos/ingresos, edit or
// soft-delete a single row, view their bot conversation, refund their
// last MercadoPago charge. Every mutation is recorded in
// support_audit_log so we have a who/what/when paper trail.

async function recordSupportAction(adminUserId, targetUserId, action, opts = {}) {
  try {
    await pool.query(
      `INSERT INTO support_audit_log (admin_user_id, target_user_id, action, resource_type, resource_id, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        adminUserId,
        targetUserId,
        action,
        opts.resourceType || null,
        opts.resourceId != null ? String(opts.resourceId) : null,
        opts.reason || null,
        opts.metadata ? JSON.stringify(opts.metadata) : null,
      ],
    );
  } catch (err) {
    console.error('[support-audit] Failed to write audit row:', err.message);
  }
}

router.get("/api/users/:id/expenses", async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (Number.isNaN(userId)) return res.status(400).json({ error: 'invalid_user_id' });
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.expense_date, e.category, e.amount, e.currency, e.description, e.expense_type,
              e.product, e.quantity, e.unit, e.unit_price, e.deleted_at,
              p.name AS plot_name, f.name AS field_name
         FROM expenses e
         LEFT JOIN plots p ON e.plot_id = p.id
         LEFT JOIN fields f ON e.field_id = f.id
        WHERE e.user_id = $1
        ORDER BY e.expense_date DESC, e.created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    res.json({ expenses: rows });
  } catch (error) {
    console.error('Error fetching support user expenses:', error);
    logError('admin-api', 'SUPPORT_EXPENSES_LIST', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete("/api/users/:userId/expenses/:expenseId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const expenseId = parseInt(req.params.expenseId, 10);
  if (Number.isNaN(userId) || Number.isNaN(expenseId)) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const reason = (req.body && req.body.reason) || null;
  try {
    const { rows } = await pool.query(
      `UPDATE expenses SET deleted_at = NOW()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        RETURNING id, amount, currency, category, description, expense_date`,
      [expenseId, userId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'expense_not_found' });
    await recordSupportAction(req.auth?.userId, userId, 'delete_expense', {
      resourceType: 'expense',
      resourceId: expenseId,
      reason,
      metadata: rows[0],
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error soft-deleting expense as admin:', error);
    logError('admin-api', 'SUPPORT_DELETE_EXPENSE', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch("/api/users/:userId/expenses/:expenseId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const expenseId = parseInt(req.params.expenseId, 10);
  if (Number.isNaN(userId) || Number.isNaN(expenseId)) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const allowed = ['amount', 'currency', 'category', 'description', 'expense_date'];
  const sets = [];
  const values = [];
  let idx = 1;
  for (const key of allowed) {
    if (req.body && req.body[key] !== undefined) {
      sets.push(`${key} = $${idx++}`);
      values.push(req.body[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'no_fields' });
  values.push(expenseId, userId);
  try {
    const { rows } = await pool.query(
      `UPDATE expenses SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${idx++} AND user_id = $${idx} AND deleted_at IS NULL
        RETURNING *`,
      values,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'expense_not_found' });
    await recordSupportAction(req.auth?.userId, userId, 'edit_expense', {
      resourceType: 'expense',
      resourceId: expenseId,
      reason: req.body?.reason || null,
      metadata: { changes: req.body },
    });
    res.json({ expense: rows[0] });
  } catch (error) {
    console.error('Error editing expense as admin:', error);
    logError('admin-api', 'SUPPORT_EDIT_EXPENSE', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get("/api/users/:id/conversation-log", async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (Number.isNaN(userId)) return res.status(400).json({ error: 'invalid_user_id' });
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  try {
    const { rows } = await pool.query(
      `SELECT id, message_text, response_text, intent_type, source, confidence,
              created_at
         FROM conversation_logs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    res.json({ messages: rows });
  } catch (error) {
    console.error('Error fetching support conversation log:', error);
    logError('admin-api', 'SUPPORT_CONVERSATION_LOG', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post("/api/users/:id/subscription/refund", async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (Number.isNaN(userId)) return res.status(400).json({ error: 'invalid_user_id' });
  const { paymentId, amountArs, reason } = req.body || {};
  if (!paymentId) return res.status(400).json({ error: 'paymentId requerido (ID del pago en MercadoPago)' });
  try {
    const { MercadoPagoProvider } = await import('../domain/billing/mercadopago.provider.js');
    const provider = new MercadoPagoProvider();
    const configured = await provider.isConfigured();
    if (!configured) {
      return res.status(503).json({ error: 'MercadoPago no está configurado.' });
    }
    if (typeof provider.refund !== 'function') {
      return res.status(501).json({ error: 'El proveedor de pagos no soporta refunds.' });
    }
    const result = await provider.refund(String(paymentId), amountArs ? Number(amountArs) : undefined);
    await recordSupportAction(req.auth?.userId, userId, 'refund_payment', {
      resourceType: 'mp_payment',
      resourceId: paymentId,
      reason: reason || null,
      metadata: { amountArs: amountArs ?? null, providerResponse: result },
    });
    res.json({ ok: true, result });
  } catch (error) {
    console.error('Error refunding payment as admin:', error);
    logError('admin-api', 'SUPPORT_REFUND', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

router.get("/api/support/audit-log", async (req, res) => {
  const targetUserId = req.query.userId ? parseInt(req.query.userId, 10) : null;
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  try {
    let result;
    if (targetUserId) {
      result = await pool.query(
        `SELECT sa.*, a.name AS admin_name, a.email AS admin_email
           FROM support_audit_log sa
           LEFT JOIN users a ON sa.admin_user_id = a.id
          WHERE sa.target_user_id = $1
          ORDER BY sa.created_at DESC
          LIMIT $2`,
        [targetUserId, limit],
      );
    } else {
      result = await pool.query(
        `SELECT sa.*, a.name AS admin_name, a.email AS admin_email,
                t.name AS target_name, t.email AS target_email
           FROM support_audit_log sa
           LEFT JOIN users a ON sa.admin_user_id = a.id
           LEFT JOIN users t ON sa.target_user_id = t.id
          ORDER BY sa.created_at DESC
          LIMIT $1`,
        [limit],
      );
    }
    res.json({ entries: result.rows });
  } catch (error) {
    console.error('Error fetching support audit log:', error);
    logError('admin-api', 'SUPPORT_AUDIT_LOG_LIST', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Document stats (admin) ---
router.get("/api/documents/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE processing_status = 'processed')::int AS processed,
        count(*) FILTER (WHERE processing_status = 'error')::int AS errors,
        count(*) FILTER (WHERE linked_expense_id IS NOT NULL)::int AS linked,
        count(DISTINCT user_id)::int AS unique_users
      FROM documents WHERE deleted_at IS NULL
    `);
    const byType = await pool.query(`
      SELECT document_type, count(*)::int AS count
      FROM documents WHERE deleted_at IS NULL
      GROUP BY document_type ORDER BY count DESC
    `);
    res.json({ ...result.rows[0], byType: byType.rows });
  } catch (error) {
    console.error("Error fetching document stats:", error);
    logError('admin-api', 'DOCUMENT_STATS', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
