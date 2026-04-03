import cron from "node-cron";
import { pool } from "../config/db.js";
import { sendMessage } from "./whatsapp.js";
import { getUsersWithRainAlerts, getGlobalSettings } from "./expenses.js";
import { getForecast } from "./weather.js";
import { sendAlertWithRetry, sendAlertWithRetryMultiChannel, isDuplicate, recordDeduped } from "./alert.service.js";
import { getSettingNumber } from "./settings.service.js";
import { cleanupOldReports } from "./agro-report.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArgentinaTime() {
  const now = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Argentina/Buenos_Aires",
    })
  );
  return {
    date: now,
    day: now.getDay(), // 0 = Sunday … 6 = Saturday
    hour: now.getHours(),
    time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
  };
}

function getWeekNumber(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function getISOWeekString(date) {
  const year = date.getFullYear();
  const week = getWeekNumber(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function getMonthName(date) {
  const months = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
  ];
  return months[date.getMonth()];
}

function formatCurrency(value) {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("es-AR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

// ---------------------------------------------------------------------------
// Database queries
// ---------------------------------------------------------------------------

async function getWeeklyIncome(userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total
       FROM incomes
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND income_date >= date_trunc('week', NOW())`,
    [userId]
  );
  return Number(rows[0].total);
}

async function getWeeklyExpense(userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total
       FROM expenses
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND expense_date >= date_trunc('week', NOW())`,
    [userId]
  );
  return Number(rows[0].total);
}

async function getTopExpenseCategory(userId) {
  const { rows } = await pool.query(
    `SELECT category, SUM(amount) AS total
       FROM expenses
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND expense_date >= date_trunc('week', NOW())
      GROUP BY category
      ORDER BY total DESC
      LIMIT 1`,
    [userId]
  );
  return rows.length > 0
    ? { category: rows[0].category, total: Number(rows[0].total) }
    : null;
}

async function getTopExpenseField(userId) {
  const { rows } = await pool.query(
    `SELECT f.name, SUM(e.amount) AS total
       FROM expenses e
       JOIN fields f ON e.field_id = f.id
      WHERE e.user_id = $1
        AND e.deleted_at IS NULL
        AND e.expense_date >= date_trunc('week', NOW())
      GROUP BY f.name
      ORDER BY total DESC
      LIMIT 1`,
    [userId]
  );
  return rows.length > 0
    ? { name: rows[0].name, total: Number(rows[0].total) }
    : null;
}

async function getRainfallByField(userId) {
  const { rows } = await pool.query(
    `SELECT f.name AS field_name, SUM(r.millimeters) AS total
       FROM rainfall r
       LEFT JOIN fields f ON r.field_id = f.id AND f.deleted_at IS NULL
      WHERE r.user_id = $1
        AND r.rainfall_date >= date_trunc('week', NOW())
      GROUP BY f.name
      ORDER BY total DESC`,
    [userId]
  );
  return rows.map((r) => ({
    fieldName: r.field_name || "General",
    total: Number(r.total),
  }));
}

async function getPreviousWeekCategoryTotal(userId, category) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total
       FROM expenses
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND category = $2
        AND expense_date >= date_trunc('week', NOW()) - interval '7 days'
        AND expense_date <  date_trunc('week', NOW())`,
    [userId, category]
  );
  return Number(rows[0].total);
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

async function buildWeeklyReport(userId) {
  const argNow = getArgentinaTime().date;
  const weekNum = getWeekNumber(argNow);
  const monthName = getMonthName(argNow);

  const [income, expense, topCategory, topField, rainfall] = await Promise.all([
    getWeeklyIncome(userId),
    getWeeklyExpense(userId),
    getTopExpenseCategory(userId),
    getTopExpenseField(userId),
    getRainfallByField(userId),
  ]);

  const result = income - expense;

  let msg = `📊 *Resumen semanal — Semana ${weekNum} ${monthName}*\n\n`;
  msg += `💰 Ingresos: ${formatCurrency(income)}\n`;
  msg += `💸 Gastos: ${formatCurrency(expense)}\n`;
  msg += `📈 Resultado: ${result >= 0 ? "+" : ""}${formatCurrency(result)}\n`;

  if (topCategory) {
    msg += `\n📋 Mayor gasto: ${topCategory.category} (${formatCurrency(topCategory.total)})`;
  }
  if (topField) {
    msg += `\n📍 Lote más costoso: ${topField.name} (${formatCurrency(topField.total)})`;
  }

  if (rainfall.length > 0) {
    msg += `\n\n🌧️ Lluvia acumulada:`;
    for (const r of rainfall) {
      msg += `\n${r.fieldName}: ${r.total}mm`;
    }
  }

  if (result < 0 && topCategory) {
    const prevTotal = await getPreviousWeekCategoryTotal(userId, topCategory.category);
    let insightExtra = "";
    if (prevTotal > 0) {
      const pctIncrease = (((topCategory.total - prevTotal) / prevTotal) * 100).toFixed(0);
      if (pctIncrease > 0) {
        insightExtra = ` El gasto en ${topCategory.category} aumentó ${pctIncrease}% vs semana anterior.`;
      }
    }
    msg += `\n\n⚠️ Esta semana el resultado fue negativo (${formatCurrency(result)}).${insightExtra}`;
  }

  return msg;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

async function getMatchingUsers(day, hour) {
  const { rows } = await pool.query(
    `SELECT u.id, u.phone_number
       FROM users u
       JOIN user_settings s ON s.user_id = u.id
      WHERE s.weekly_summary = true
        AND s.weekly_summary_day  = $1
        AND s.weekly_summary_hour = $2`,
    [day, hour]
  );
  return rows;
}

async function processUser(user) {
  try {
    const report = await buildWeeklyReport(user.id);
    await sendMessage(user.phone_number, report);
    console.log(`[scheduler] Weekly summary sent to user ${user.id} (${user.phone_number})`);
  } catch (err) {
    console.error(`[scheduler] Error sending weekly summary to user ${user.id}:`, err);
  }
}

async function tick() {
  try {
    const { day, hour } = getArgentinaTime();
    console.log(`[scheduler] Tick — Argentina day=${day} hour=${hour}`);

    const users = await getMatchingUsers(day, hour);
    if (users.length === 0) return;

    console.log(`[scheduler] ${users.length} user(s) matched. Sending summaries…`);
    for (const user of users) {
      await processUser(user);
    }
  } catch (err) {
    console.error("[scheduler] Unexpected error during tick:", err);
  }
}

// ---------------------------------------------------------------------------
// Daily Weather Alert (with dedup + retry)
// ---------------------------------------------------------------------------

async function getUserFieldCities(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (city) city, name FROM fields
     WHERE (user_id = $1 OR id IN (SELECT field_id FROM field_members WHERE user_id = $1))
       AND city IS NOT NULL AND deleted_at IS NULL
     ORDER BY city, name`,
    [userId]
  );
  return rows;
}

async function checkWeatherForUser(user) {
  // Build city sources: { city -> label }
  const citySources = new Map();

  if (user.city) citySources.set(user.city, 'tu ubicación');

  const fieldRows = await getUserFieldCities(user.id);
  for (const r of fieldRows) {
    if (!citySources.has(r.city)) {
      citySources.set(r.city, r.name);
    }
  }

  if (citySources.size === 0) return;

  const threshold = user.rain_alert_mm || 10;
  const alerts = [];

  for (const [city, label] of citySources) {
    try {
      const forecastData = await getForecast(city, 2);
      for (const day of forecastData.forecast) {
        if (day.rain >= threshold) {
          const resolvedCity = forecastData.city || city;
          const dedupKey = `${resolvedCity}_${day.dayName}`;

          // Check deduplication against previous alerts
          const dup = await isDuplicate(user.id, 'weather', dedupKey, 24);
          if (dup) {
            await recordDeduped(user.id, 'weather', dedupKey);
            continue;
          }

          // Deduplicate within same message (same city+day from user city + field city)
          if (!alerts.some(a => a.dedupKey === dedupKey)) {
            alerts.push({
              city: resolvedCity,
              label,
              isUserCity: label === 'tu ubicación',
              dayName: day.dayName,
              rain: day.rain,
              icon: day.icon,
              dedupKey,
            });
          }
        }
      }
    } catch (err) {
      console.error(`[weather-alert] Error fetching forecast for ${city}:`, err.message);
    }
  }

  if (alerts.length === 0) return;

  // Sort: user location first, then campos
  alerts.sort((a, b) => (b.isUserCity ? 1 : 0) - (a.isUserCity ? 1 : 0));

  let msg = "🌧️ *Alerta de lluvia*\n";
  for (const a of alerts) {
    msg += `\n${a.icon} *${a.city}* (${a.label}) — ${a.dayName}: ${a.rain}mm estimados`;
  }
  msg += `\n\n_Umbral configurado: ${threshold}mm_`;

  // Use first alert's dedupKey as representative
  const dedupKey = alerts[0].dedupKey;

  const result = await sendAlertWithRetryMultiChannel(user.id, { phone: user.phone_number, telegramId: user.telegram_id }, msg, 'weather', {
    dedupKey,
    payload: { cities: alerts.map(a => a.city), threshold },
  });

  if (result.sent) {
    const channel = user.telegram_id ? 'telegram' : 'whatsapp';
    console.log(`[weather-alert] Rain alert sent to user ${user.id} via ${channel}`);
  } else {
    console.error(`[weather-alert] Failed to send to user ${user.id} after retries`);
  }
}

async function weatherAlertTick() {
  try {
    const globalSettings = await getGlobalSettings();
    if (!globalSettings.daily_weather_enabled) return;

    const { time } = getArgentinaTime();
    if (time !== globalSettings.daily_weather_hour) return;

    console.log(`[weather-alert] Running daily weather check at ${time}`);

    const users = await getUsersWithRainAlerts();
    if (users.length === 0) return;

    console.log(`[weather-alert] Checking weather for ${users.length} user(s)…`);
    for (const user of users) {
      await checkWeatherForUser(user);
    }
  } catch (err) {
    console.error("[weather-alert] Unexpected error:", err);
  }
}

// ---------------------------------------------------------------------------
// Monitoring Reminder (daily)
// ---------------------------------------------------------------------------

async function monitoringReminderTick() {
  try {
    const argTime = getArgentinaTime();
    const weekStr = getISOWeekString(argTime.date);

    // Find plots with sanidad/malezas observations in last 7 days
    // that have NO newer observation or treatment activity
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (ao.plot_id)
         ao.user_id, ao.plot_id, ao.category, ao.created_at AS obs_date,
         p.name AS plot_name, f.name AS field_name,
         u.phone_number,
         EXTRACT(DAY FROM NOW() - ao.created_at)::int AS days_ago
       FROM agro_observations ao
       JOIN plots p ON ao.plot_id = p.id
       JOIN fields f ON p.field_id = f.id
       JOIN users u ON ao.user_id = u.id
       WHERE ao.category IN ('sanidad', 'malezas')
         AND ao.created_at >= NOW() - INTERVAL '7 days'
         AND p.deleted_at IS NULL AND f.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM agro_observations ao2
           WHERE ao2.plot_id = ao.plot_id
             AND ao2.created_at > ao.created_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM domain_events de
           WHERE de.plot_id = ao.plot_id
             AND de.event_type IN ('fumigacion', 'pulverizacion', 'aplicacion')
             AND de.created_at > ao.created_at
         )
       ORDER BY ao.plot_id, ao.created_at DESC`
    );

    for (const row of rows) {
      const dedupKey = `${row.plot_id}_${weekStr}`;
      const dup = await isDuplicate(row.user_id, 'monitoring_reminder', dedupKey, 168); // 7 days
      if (dup) continue;

      const msg = `📋 *Recordatorio de monitoreo*\nHace ${row.days_ago} día${row.days_ago !== 1 ? 's' : ''} registraste ${row.category} en lote *${row.plot_name}* (campo ${row.field_name}). ¿Cómo está la situación?`;

      const result = await sendAlertWithRetry(row.user_id, row.phone_number, msg, 'monitoring_reminder', {
        plotId: row.plot_id,
        dedupKey,
        payload: { category: row.category, daysAgo: row.days_ago },
      });

      if (result.sent) {
        console.log(`[monitoring] Reminder sent to user ${row.user_id} for plot ${row.plot_name}`);
      }
    }
  } catch (err) {
    console.error("[monitoring] Unexpected error:", err);
  }
}

// ---------------------------------------------------------------------------
// Pest Escalation Alert (daily)
// ---------------------------------------------------------------------------

async function pestEscalationTick() {
  try {
    const argTime = getArgentinaTime();
    const weekStr = getISOWeekString(argTime.date);

    // Find plots with 3+ sanidad observations in last 14 days
    // without an intervening treatment
    const { rows } = await pool.query(
      `SELECT
         ao.user_id, ao.plot_id,
         COUNT(*) AS obs_count,
         p.name AS plot_name, f.name AS field_name,
         u.phone_number
       FROM agro_observations ao
       JOIN plots p ON ao.plot_id = p.id
       JOIN fields f ON p.field_id = f.id
       JOIN users u ON ao.user_id = u.id
       WHERE ao.category = 'sanidad'
         AND ao.created_at >= NOW() - INTERVAL '14 days'
         AND p.deleted_at IS NULL AND f.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM domain_events de
           WHERE de.plot_id = ao.plot_id
             AND de.event_type IN ('fumigacion', 'pulverizacion', 'aplicacion')
             AND de.created_at >= NOW() - INTERVAL '14 days'
         )
       GROUP BY ao.user_id, ao.plot_id, p.name, f.name, u.phone_number
       HAVING COUNT(*) >= 3`
    );

    for (const row of rows) {
      const dedupKey = `${row.plot_id}_${weekStr}`;
      const dup = await isDuplicate(row.user_id, 'pest_escalation', dedupKey, 168); // 7 days
      if (dup) continue;

      const msg = `🚨 *Alerta de plaga*\nEl lote *${row.plot_name}* (campo ${row.field_name}) tiene ${row.obs_count} reportes de sanidad en las últimas 2 semanas sin tratamiento registrado.`;

      const result = await sendAlertWithRetry(row.user_id, row.phone_number, msg, 'pest_escalation', {
        plotId: row.plot_id,
        dedupKey,
        payload: { obsCount: parseInt(row.obs_count) },
      });

      if (result.sent) {
        console.log(`[pest-alert] Escalation sent to user ${row.user_id} for plot ${row.plot_name}`);
      }
    }
  } catch (err) {
    console.error("[pest-alert] Unexpected error:", err);
  }
}

// ---------------------------------------------------------------------------
// Missing Hectares Reminder (weekly per user)
// ---------------------------------------------------------------------------

async function missingHectaresReminderTick() {
  try {
    const { rows } = await pool.query(
      `SELECT p.id AS plot_id, p.name AS plot_name, f.name AS field_name, u.id AS user_id, u.phone_number
       FROM plots p
       JOIN fields f ON p.field_id = f.id
       JOIN users u ON f.user_id = u.id
       WHERE p.area_hectares IS NULL
         AND p.deleted_at IS NULL
         AND f.deleted_at IS NULL
         AND p.created_at < NOW() - INTERVAL '24 hours'
       ORDER BY u.id, f.name, p.name`
    );

    if (rows.length === 0) return;

    // Group by user
    const byUser = new Map();
    for (const row of rows) {
      const list = byUser.get(row.user_id) || { phone: row.phone_number, plots: [] };
      list.plots.push({ plotName: row.plot_name, fieldName: row.field_name });
      byUser.set(row.user_id, list);
    }

    for (const [userId, data] of byUser) {
      const dedupKey = `user_${userId}`;
      const dup = await isDuplicate(userId, 'missing_hectares', dedupKey, 168); // 7 days
      if (dup) continue;

      const count = data.plots.length;
      let msg = `📐 *Lotes sin superficie definida*\nTenés ${count} lote${count > 1 ? 's' : ''} sin hectáreas:\n`;
      for (const p of data.plots) {
        msg += `  • *${p.plotName}* (campo ${p.fieldName})\n`;
      }
      msg += `\nPodés decirme: "el lote ${data.plots[0].plotName} tiene 120 ha"`;

      const result = await sendAlertWithRetry(userId, data.phone, msg, 'missing_hectares', {
        dedupKey,
        payload: { plotCount: count },
      });

      if (result.sent) {
        console.log(`[hectares-reminder] Sent to user ${userId} (${count} plots missing area)`);
      }
    }
  } catch (err) {
    console.error("[hectares-reminder] Unexpected error:", err);
  }
}

// ---------------------------------------------------------------------------
// Proactive Alerts Tick (monitoring + pest + hectares combined)
// ---------------------------------------------------------------------------

async function lowStockAlertTick() {
  try {
    const { StockAlertService } = await import('../domain/stock/stock-alert.service.js');
    const alertService = new StockAlertService();
    const lowStockUsers = await alertService.getLowStockUsers();

    for (const lsu of lowStockUsers) {
      const dedupKey = `user_${lsu.userId}`;
      const dup = await isDuplicate(lsu.userId, 'low_stock', dedupKey, 24); // 24h dedup
      if (dup) {
        await recordDeduped(lsu.userId, 'low_stock', dedupKey);
        continue;
      }

      const msg = alertService.formatLowStockAlert(lsu.items);
      if (!msg) continue;

      const result = await sendAlertWithRetryMultiChannel(
        lsu.userId,
        { phone: lsu.phone, telegramId: lsu.telegramId },
        msg,
        'low_stock',
        { dedupKey, payload: { itemCount: lsu.items.length } },
      );

      if (result.sent) {
        const channel = lsu.telegramId ? 'telegram' : 'whatsapp';
        console.log(`[low-stock] Alert sent to user ${lsu.userId} via ${channel} (${lsu.items.length} items)`);
      }
    }
  } catch (err) {
    console.error("[low-stock] Unexpected error:", err);
  }
}

async function proactiveAlertsTick() {
  try {
    const { hour } = getArgentinaTime();
    // Run at 8 AM Argentina time (configurable via global settings in future)
    if (hour !== 8) return;

    console.log(`[proactive-alerts] Running monitoring + pest escalation + hectares reminder + low stock checks`);
    await monitoringReminderTick();
    await pestEscalationTick();
    await missingHectaresReminderTick();
    await lowStockAlertTick();
  } catch (err) {
    console.error("[proactive-alerts] Unexpected error:", err);
  }
}

// ---------------------------------------------------------------------------
// Conversation Data Cleanup (daily at 3 AM Argentina)
// ---------------------------------------------------------------------------

async function conversationLogCleanupTick() {
  const ttlDays = await getSettingNumber('CONVERSATION_LOG_TTL_DAYS');
  if (!ttlDays || ttlDays <= 0) return;

  const tables = ['conversation_logs', 'conversation_events', 'conversation_errors'];
  for (const table of tables) {
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM ${table} WHERE created_at < NOW() - make_interval(days => $1)`,
        [ttlDays]
      );
      if (rowCount > 0) {
        console.log(`[cleanup] Deleted ${rowCount} rows from ${table} (older than ${ttlDays} days)`);
      }
    } catch (err) {
      // Table may not exist — skip silently
      if (err.code !== '42P01') {
        console.error(`[cleanup] Error cleaning ${table}:`, err.message);
      }
    }
  }
}

async function miniMemoryExpiryTick() {
  const expiryDays = await getSettingNumber('MINI_MEMORY_EXPIRY_DAYS');
  if (!expiryDays || expiryDays <= 0) return;

  try {
    const { rowCount } = await pool.query(
      `UPDATE conversation_state
          SET last_intent = NULL,
              last_activity_type = NULL,
              last_query_type = NULL,
              last_time_reference = NULL,
              last_plot_id = NULL,
              last_field_id = NULL,
              updated_at = NOW()
        WHERE updated_at < NOW() - make_interval(days => $1)
          AND flow_state = 'idle'
          AND (last_intent IS NOT NULL
               OR last_activity_type IS NOT NULL
               OR last_query_type IS NOT NULL
               OR last_time_reference IS NOT NULL
               OR last_plot_id IS NOT NULL
               OR last_field_id IS NOT NULL)`,
      [expiryDays]
    );
    if (rowCount > 0) {
      console.log(`[cleanup] Cleared mini-memory for ${rowCount} idle user(s) (inactive > ${expiryDays} days)`);
    }
  } catch (err) {
    if (err.code !== '42P01') {
      console.error('[cleanup] Error clearing mini-memory:', err.message);
    }
  }
}

async function dailyCleanupTick() {
  try {
    const { hour } = getArgentinaTime();
    if (hour !== 3) return;

    console.log('[cleanup] Running daily cleanup (3 AM Argentina)');
    await conversationLogCleanupTick();
    await miniMemoryExpiryTick();
    const deletedReports = await cleanupOldReports(30);
    if (deletedReports > 0) {
      console.log(`[cleanup] Deleted ${deletedReports} old PDF report(s) (>30 days)`);
    }
  } catch (err) {
    console.error('[cleanup] Unexpected error:', err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startScheduler() {
  // Weekly summary — every hour at :00
  cron.schedule("0 * * * *", () => {
    tick();
  });

  // Daily weather alerts — every minute (checks global_settings.daily_weather_hour HH:MM match)
  cron.schedule("* * * * *", () => {
    weatherAlertTick();
  });

  // Proactive alerts (monitoring reminders + pest escalation) — every hour at :00 (checks hour internally)
  cron.schedule("0 * * * *", () => {
    proactiveAlertsTick();
  });

  // Daily cleanup (conversation logs TTL + mini-memory expiry) — every hour at :00 (checks hour === 3 internally)
  cron.schedule("0 * * * *", () => {
    dailyCleanupTick();
  });

  console.log("[scheduler] Cron jobs started — weekly summary + daily weather alerts + proactive alerts (incl. low stock) + daily cleanup (hourly tick)");
}
