import cron from "node-cron";
import { pool } from "../config/db.js";
import { sendMessage } from "./whatsapp.js";
import { getUsersWithRainAlerts, getGlobalSettings } from "./expenses.js";
import { getForecast, checkDryWindow, checkWindAlert } from "./weather.js";
import { sendAlertWithRetry, sendAlertWithRetryMultiChannel, isDuplicate, recordDeduped } from "./alert.service.js";
import { getSettingNumber, getSettingBool } from "./settings.service.js";
import { cleanupOldReports } from "./agro-report.js";
import { logError } from "./error-logger.js";
import { ConversationStateRepository } from "../middleware/conversation-state.repository.js";
import { buildTimeoutMessage, buildHalflifeMessage } from "../middleware/conversation-engine.js";

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

async function getPreviousWeekExpense(userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total
       FROM expenses
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND expense_date >= date_trunc('week', NOW()) - interval '7 days'
        AND expense_date <  date_trunc('week', NOW())`,
    [userId]
  );
  return Number(rows[0].total);
}

async function getPreviousWeekIncome(userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total
       FROM incomes
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND income_date >= date_trunc('week', NOW()) - interval '7 days'
        AND income_date <  date_trunc('week', NOW())`,
    [userId]
  );
  return Number(rows[0].total);
}

async function getActiveCampaigns(userId) {
  const { rows } = await pool.query(
    `SELECT pc.crop, pc.start_date, p.name AS plot_name, f.name AS field_name,
            p.area_hectares,
            COALESCE(
              (SELECT SUM(e.amount) FROM expenses e
               WHERE e.plot_id = p.id AND e.deleted_at IS NULL
               AND e.expense_date >= pc.start_date
               AND e.currency = 'ARS'), 0
            ) AS campaign_expenses_ars
       FROM plot_crops pc
       JOIN plots p ON pc.plot_id = p.id
       JOIN fields f ON p.field_id = f.id
      WHERE (f.user_id = $1 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $1))
        AND pc.end_date IS NULL
        AND p.deleted_at IS NULL AND f.deleted_at IS NULL
      ORDER BY pc.start_date ASC`,
    [userId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Monthly report queries
// ---------------------------------------------------------------------------

async function getMonthExpenses(userId, monthsAgo) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total
       FROM expenses
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND expense_date >= date_trunc('month', NOW()) - make_interval(months => $2)
        AND expense_date <  date_trunc('month', NOW()) - make_interval(months => $2 - 1)`,
    [userId, monthsAgo]
  );
  return Number(rows[0].total);
}

async function getMonthIncomes(userId, monthsAgo) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total
       FROM incomes
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND income_date >= date_trunc('month', NOW()) - make_interval(months => $2)
        AND income_date <  date_trunc('month', NOW()) - make_interval(months => $2 - 1)`,
    [userId, monthsAgo]
  );
  return Number(rows[0].total);
}

async function getMonthTopCategories(userId, monthsAgo) {
  const { rows } = await pool.query(
    `SELECT category, SUM(amount) AS total
       FROM expenses
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND expense_date >= date_trunc('month', NOW()) - make_interval(months => $2)
        AND expense_date <  date_trunc('month', NOW()) - make_interval(months => $2 - 1)
      GROUP BY category
      ORDER BY total DESC
      LIMIT 3`,
    [userId, monthsAgo]
  );
  return rows.map(r => ({ category: r.category || 'Otros', total: Number(r.total) }));
}

async function getMonthRainfall(userId, monthsAgo) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(millimeters),0) AS total
       FROM rainfall
      WHERE user_id = $1
        AND rainfall_date >= date_trunc('month', NOW()) - make_interval(months => $2)
        AND rainfall_date <  date_trunc('month', NOW()) - make_interval(months => $2 - 1)`,
    [userId, monthsAgo]
  );
  return Number(rows[0].total);
}

async function getMonthActivitiesCount(userId, monthsAgo) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total
       FROM domain_events de
       JOIN plots p ON de.plot_id = p.id
       JOIN fields f ON p.field_id = f.id
      WHERE (f.user_id = $1 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $1))
        AND de.event_date >= date_trunc('month', NOW()) - make_interval(months => $2)
        AND de.event_date <  date_trunc('month', NOW()) - make_interval(months => $2 - 1)
        AND de.deleted_at IS NULL
        AND p.deleted_at IS NULL AND f.deleted_at IS NULL`,
    [userId, monthsAgo]
  );
  return Number(rows[0].total);
}

function getMonthNameByOffset(offset) {
  const d = new Date();
  d.setMonth(d.getMonth() - offset);
  return getMonthName(d);
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

  // Previous week comparison
  const [prevExpense, prevIncome] = await Promise.all([
    getPreviousWeekExpense(userId),
    getPreviousWeekIncome(userId),
  ]);

  if (prevExpense > 0 || prevIncome > 0) {
    msg += `\n\n📊 *vs semana anterior:*`;
    if (prevExpense > 0) {
      const expPct = ((expense - prevExpense) / prevExpense * 100).toFixed(0);
      const expSign = Number(expPct) >= 0 ? '+' : '';
      msg += `\n💸 Gastos: ${expSign}${expPct}%`;
    }
    if (prevIncome > 0) {
      const incPct = ((income - prevIncome) / prevIncome * 100).toFixed(0);
      const incSign = Number(incPct) >= 0 ? '+' : '';
      msg += `\n💰 Ingresos: ${incSign}${incPct}%`;
    }
  }

  // Active campaigns
  const campaigns = await getActiveCampaigns(userId);
  if (campaigns.length > 0) {
    msg += `\n\n🌱 *Campañas activas:*`;
    for (const c of campaigns) {
      const daysSince = Math.ceil((Date.now() - new Date(c.start_date).getTime()) / (1000 * 60 * 60 * 24));
      let campLine = `\n${c.crop} en ${c.plot_name} — ${daysSince} días`;
      if (c.area_hectares && Number(c.campaign_expenses_ars) > 0) {
        const costHa = Math.round(Number(c.campaign_expenses_ars) / Number(c.area_hectares));
        campLine += ` | $${costHa.toLocaleString('es-AR')}/ha`;
      }
      msg += campLine;
    }
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
    logError('scheduler', 'WEEKLY_SUMMARY_SEND', err, { userId: user.id });
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
    logError('scheduler', 'WEEKLY_TICK_ERROR', err);
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

  const defaultRainMm = (await getSettingNumber('DEFAULT_RAIN_ALERT_MM')) ?? 10;
  const rainThreshold = user.rain_alert_mm || defaultRainMm;
  const windThreshold = user.wind_alert_kmh || 20;
  const dryDays = user.dry_window_days || 3;
  const rainAlerts = [];
  const windAlerts = [];
  const dryAlerts = [];

  // Fetch forecast once per city and run all three checks (rain, wind, dry window).
  // includeToday: true — 6am run still has the whole day ahead, so today's rain/wind matters.
  for (const [city, label] of citySources) {
    try {
      const forecastData = await getForecast(city, 3, { includeToday: true });
      const resolvedCity = forecastData.city || city;
      const isUserCity = label === 'tu ubicación';

      // --- Rain per-day ---
      for (const day of forecastData.forecast) {
        if (day.rain >= rainThreshold) {
          const dedupKey = `rain_${resolvedCity}_${day.dayName}`;
          const dup = await isDuplicate(user.id, 'weather', dedupKey, 24);
          if (dup) {
            await recordDeduped(user.id, 'weather', dedupKey);
            continue;
          }
          if (!rainAlerts.some(a => a.dedupKey === dedupKey)) {
            rainAlerts.push({
              city: resolvedCity, label, isUserCity,
              dayName: day.dayName, rain: day.rain, icon: day.icon, dedupKey,
            });
          }
        }
      }

      // --- Wind (single message per city per day-run) ---
      if (user.wind_alerts) {
        const windMsg = checkWindAlert(forecastData, windThreshold);
        if (windMsg) {
          const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
          const dedupKey = `wind_${resolvedCity}_${today}`;
          const dup = await isDuplicate(user.id, 'weather', dedupKey, 24);
          if (dup) {
            await recordDeduped(user.id, 'weather', dedupKey);
          } else if (!windAlerts.some(a => a.dedupKey === dedupKey)) {
            windAlerts.push({ city: resolvedCity, label, isUserCity, body: windMsg, dedupKey });
          }
        }
      }

      // --- Dry window (single message per city per day-run) ---
      if (user.dry_window_alerts) {
        const dryMsg = checkDryWindow(forecastData, dryDays);
        if (dryMsg) {
          const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
          const dedupKey = `dry_${resolvedCity}_${today}`;
          const dup = await isDuplicate(user.id, 'weather', dedupKey, 24);
          if (dup) {
            await recordDeduped(user.id, 'weather', dedupKey);
          } else if (!dryAlerts.some(a => a.dedupKey === dedupKey)) {
            dryAlerts.push({ city: resolvedCity, label, isUserCity, body: dryMsg, dedupKey });
          }
        }
      }
    } catch (err) {
      console.error(`[weather-alert] Error fetching forecast for ${city}:`, err.message);
      logError('scheduler', 'WEATHER_FORECAST_FETCH', err, { userId: user.id, context: { city } });
    }
  }

  await sendRainAlertBundle(user, rainAlerts, rainThreshold);
  await sendCityAlertBundle(user, windAlerts, '🌬️ *Alerta de viento*', 'wind');
  await sendCityAlertBundle(user, dryAlerts, '☀️ *Ventana seca*', 'dry');
}

async function sendRainAlertBundle(user, alerts, threshold) {
  if (alerts.length === 0) return;
  alerts.sort((a, b) => (b.isUserCity ? 1 : 0) - (a.isUserCity ? 1 : 0));

  let msg = "🌧️ *Alerta de lluvia*\n";
  for (const a of alerts) {
    msg += `\n${a.icon} *${a.city}* (${a.label}) — ${a.dayName}: ${a.rain}mm estimados`;
  }
  msg += `\n\n_Umbral configurado: ${threshold}mm. Es un pronóstico, puede cambiar._`;

  const dedupKey = alerts[0].dedupKey;
  const result = await sendAlertWithRetryMultiChannel(user.id, { phone: user.phone_number, telegramId: user.telegram_id }, msg, 'weather', {
    dedupKey,
    payload: { cities: alerts.map(a => a.city), threshold },
  });
  if (result.sent) {
    const channel = user.telegram_id ? 'telegram' : 'whatsapp';
    console.log(`[weather-alert] Rain alert sent to user ${user.id} via ${channel}`);
  } else {
    console.error(`[weather-alert] Failed to send rain alert to user ${user.id} after retries`);
    logError('scheduler', 'WEATHER_ALERT_SEND', `Failed to send rain alert after retries`, { userId: user.id });
  }
}

async function sendCityAlertBundle(user, alerts, header, kind) {
  if (alerts.length === 0) return;
  alerts.sort((a, b) => (b.isUserCity ? 1 : 0) - (a.isUserCity ? 1 : 0));

  let msg = `${header}\n`;
  for (const a of alerts) {
    msg += `\n*${a.city}* (${a.label})\n${a.body}\n`;
  }

  const dedupKey = alerts[0].dedupKey;
  const result = await sendAlertWithRetryMultiChannel(user.id, { phone: user.phone_number, telegramId: user.telegram_id }, msg, 'weather', {
    dedupKey,
    payload: { cities: alerts.map(a => a.city), kind },
  });
  if (result.sent) {
    const channel = user.telegram_id ? 'telegram' : 'whatsapp';
    console.log(`[weather-alert] ${kind} alert sent to user ${user.id} via ${channel}`);
  } else {
    console.error(`[weather-alert] Failed to send ${kind} alert to user ${user.id} after retries`);
    logError('scheduler', 'WEATHER_ALERT_SEND', `Failed to send ${kind} alert after retries`, { userId: user.id });
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
    logError('scheduler', 'WEATHER_TICK_ERROR', err);
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
             AND de.deleted_at IS NULL
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
    logError('scheduler', 'MONITORING_TICK_ERROR', err);
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
             AND de.deleted_at IS NULL
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
    logError('scheduler', 'PEST_ALERT_TICK_ERROR', err);
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
    logError('scheduler', 'HECTARES_REMINDER_ERROR', err);
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
    logError('scheduler', 'LOW_STOCK_ALERT_ERROR', err);
  }
}

async function phenologyAlertTick() {
  try {
    const { PhenologyService } = await import('../domain/agronomy/phenology.service.js');
    const svc = new PhenologyService();
    const alerts = await svc.getPendingAlerts();

    for (const alert of alerts) {
      // Dedup: 7-day window per plotCrop + stageCode
      const dedupKey = `phenology_${alert.plotCropId}_${alert.stageCode}`;
      const dup = await isDuplicate(alert.userId, 'phenology', dedupKey, 168); // 7 days
      if (dup) {
        await recordDeduped(alert.userId, 'phenology', dedupKey);
        continue;
      }

      const msg = svc.formatAlert(alert);
      const result = await sendAlertWithRetryMultiChannel(
        alert.userId,
        { phone: alert.phone, telegramId: alert.telegramId },
        msg,
        'phenology',
        { dedupKey, payload: { crop: alert.crop, stage: alert.stageCode } }
      );

      if (result.sent) {
        console.log(`[phenology] Alert sent to user ${alert.userId}: ${alert.crop} ${alert.stageCode} in ${alert.plotName}`);
      }
    }
  } catch (err) {
    // Table may not exist yet — skip silently
    if (err.code === '42P01') return;
    console.error('[phenology] Error:', err);
    logError('scheduler', 'PHENOLOGY_ALERT_ERROR', err);
  }
}

async function proactiveAlertsTick() {
  try {
    const { hour } = getArgentinaTime();
    // Run at 8 AM Argentina time (configurable via global settings in future)
    if (hour !== 8) return;

    console.log(`[proactive-alerts] Running monitoring + pest escalation + hectares reminder + low stock + phenology checks`);
    await monitoringReminderTick();
    await pestEscalationTick();
    await missingHectaresReminderTick();
    await lowStockAlertTick();
    await phenologyAlertTick();
  } catch (err) {
    console.error("[proactive-alerts] Unexpected error:", err);
    logError('scheduler', 'PROACTIVE_ALERTS_ERROR', err);
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
        logError('scheduler', 'CLEANUP_TABLE_ERROR', err, { context: { table } });
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
      logError('scheduler', 'CLEANUP_MINI_MEMORY', err);
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
    logError('scheduler', 'DAILY_CLEANUP_ERROR', err);
  }
}

// ---------------------------------------------------------------------------
// Flow Reminder Tick (every minute)
// ---------------------------------------------------------------------------
// - Sends "¿seguís ahí?" half-life warnings for active flows past halflife
// - Sends "cerré el formulario" notifications for expired flows (catches users
//   who never came back, complementing the inline notification in controllers)
// ---------------------------------------------------------------------------

const conversationStateRepoForReminder = new ConversationStateRepository();

async function flowReminderTick() {
  try {
    const timeoutNotifyEnabled = (await getSettingBool('FLOW_TIMEOUT_NOTIFICATION_ENABLED')) ?? true;
    const halflifeEnabled = (await getSettingBool('FLOW_HALFLIFE_WARNING_ENABLED')) ?? true;
    const halflifeMs = (await getSettingNumber('FLOW_HALFLIFE_WARNING_MS')) ?? 300000;

    if (!timeoutNotifyEnabled && !halflifeEnabled) return;

    const activeFlows = await conversationStateRepoForReminder.findActiveFlowsForReminder();
    if (activeFlows.length === 0) return;

    const now = Date.now();

    for (const flow of activeFlows) {
      const expiresAtMs = flow.flowExpiresAt ? new Date(flow.flowExpiresAt).getTime() : null;
      const startedAtMs = flow.flowStartedAt ? new Date(flow.flowStartedAt).getTime() : null;
      if (!startedAtMs) continue;

      // 1. Expired flow → send timeout notification and clear
      if (expiresAtMs && now >= expiresAtMs) {
        if (!timeoutNotifyEnabled) {
          await conversationStateRepoForReminder.clearFlow(flow.userId);
          continue;
        }
        try {
          await sendAlertWithRetryMultiChannel(
            flow.userId,
            { phone: flow.phone, telegramId: flow.telegramId },
            buildTimeoutMessage(flow.flowState),
            'flow_timeout',
            { dedupKey: `flow_timeout_${flow.userId}_${startedAtMs}` }
          );
          console.log(`[flow-reminder] Timeout notice sent to user ${flow.userId} (flow: ${flow.flowState})`);
        } catch (err) {
          console.error(`[flow-reminder] Failed to send timeout notice to user ${flow.userId}:`, err.message);
        }
        await conversationStateRepoForReminder.clearFlow(flow.userId);
        continue;
      }

      // 2. Half-life reached → send "still there?" warning (once per flow)
      if (!halflifeEnabled) continue;
      if (flow.halflifeNotifiedAt) continue; // Already notified
      const halflifeAtMs = startedAtMs + halflifeMs;
      if (now < halflifeAtMs) continue; // Too early

      try {
        await sendAlertWithRetryMultiChannel(
          flow.userId,
          { phone: flow.phone, telegramId: flow.telegramId },
          buildHalflifeMessage(flow.flowState),
          'flow_halflife',
          { dedupKey: `flow_halflife_${flow.userId}_${startedAtMs}` }
        );
        await conversationStateRepoForReminder.markHalflifeNotified(flow.userId);
        console.log(`[flow-reminder] Halflife warning sent to user ${flow.userId} (flow: ${flow.flowState})`);
      } catch (err) {
        console.error(`[flow-reminder] Failed to send halflife warning to user ${flow.userId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[flow-reminder] Unexpected error:', err);
    logError('scheduler', 'FLOW_REMINDER_ERROR', err);
  }
}

// ---------------------------------------------------------------------------
// Monthly Summary
// ---------------------------------------------------------------------------

async function buildMonthlyReport(userId) {
  const prevMonth = getMonthNameByOffset(1);

  const [expense, prevExpense, income, prevIncome, topCats, rainfall, prevRainfall, actCount] = await Promise.all([
    getMonthExpenses(userId, 1),
    getMonthExpenses(userId, 2),
    getMonthIncomes(userId, 1),
    getMonthIncomes(userId, 2),
    getMonthTopCategories(userId, 1),
    getMonthRainfall(userId, 1),
    getMonthRainfall(userId, 2),
    getMonthActivitiesCount(userId, 1),
  ]);

  const result = income - expense;

  let msg = `📊 *Resumen mensual — ${prevMonth}*\n\n`;
  msg += `💸 Gastos: ${formatCurrency(expense)}`;
  if (prevExpense > 0) {
    const pct = ((expense - prevExpense) / prevExpense * 100).toFixed(0);
    msg += ` (${Number(pct) >= 0 ? '+' : ''}${pct}% vs mes anterior)`;
  }
  msg += `\n💰 Ingresos: ${formatCurrency(income)}`;
  if (prevIncome > 0) {
    const pct = ((income - prevIncome) / prevIncome * 100).toFixed(0);
    msg += ` (${Number(pct) >= 0 ? '+' : ''}${pct}% vs mes anterior)`;
  }
  msg += `\n📈 Resultado: ${result >= 0 ? '+' : ''}${formatCurrency(result)}`;

  if (topCats.length > 0) {
    msg += `\n\n📋 *Top gastos:*`;
    for (const c of topCats) {
      msg += `\n• ${c.category}: ${formatCurrency(c.total)}`;
    }
  }

  if (rainfall > 0) {
    msg += `\n\n🌧️ Lluvia: ${rainfall}mm`;
    if (prevRainfall > 0) {
      msg += ` (anterior: ${prevRainfall}mm)`;
    }
  }

  if (actCount > 0) {
    msg += `\n🌱 Actividades: ${actCount}`;
  }

  return msg;
}

async function getMatchingMonthlyUsers() {
  const { rows } = await pool.query(
    `SELECT u.id, u.phone_number, u.telegram_id
       FROM users u
       JOIN user_settings s ON s.user_id = u.id
      WHERE s.monthly_summary = true`
  );
  return rows;
}

async function monthlyTick() {
  try {
    const { date, hour } = getArgentinaTime();
    const monthlyHour = (await getSettingNumber('MONTHLY_SUMMARY_HOUR')) ?? 8;

    // Only run on 1st of month at configured hour
    if (date.getDate() !== 1 || hour !== monthlyHour) return;

    console.log(`[scheduler] Running monthly summaries at hour ${hour}`);
    const users = await getMatchingMonthlyUsers();
    if (users.length === 0) return;

    console.log(`[scheduler] ${users.length} user(s) matched for monthly summary`);
    for (const user of users) {
      try {
        const report = await buildMonthlyReport(user.id);
        await sendAlertWithRetryMultiChannel(
          user.id,
          { phone: user.phone_number, telegramId: user.telegram_id },
          report,
          'monthly_summary',
          { dedupKey: `monthly_${user.id}_${date.getFullYear()}_${date.getMonth()}` }
        );
        console.log(`[scheduler] Monthly summary sent to user ${user.id}`);
      } catch (err) {
        console.error(`[scheduler] Error sending monthly summary to user ${user.id}:`, err);
        logError('scheduler', 'MONTHLY_SUMMARY_SEND', err, { userId: user.id });
      }
    }
  } catch (err) {
    console.error("[scheduler] Monthly tick error:", err);
    logError('scheduler', 'MONTHLY_TICK_ERROR', err);
  }
}

// ---------------------------------------------------------------------------
// Expense Templates (recurring expenses)
// ---------------------------------------------------------------------------

async function expenseTemplateTick() {
  try {
    const { hour } = getArgentinaTime();
    if (hour !== 7) return;

    const { ExpenseTemplateService } = await import('../domain/financial/expense-template.service.js');
    const svc = new ExpenseTemplateService();
    const processed = await svc.processTemplates();
    if (processed > 0) {
      console.log(`[expense-templates] Processed ${processed} recurring expense(s)`);
    }
  } catch (err) {
    console.error('[expense-templates] Error:', err);
    logError('scheduler', 'EXPENSE_TEMPLATE_ERROR', err);
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

  // Monthly summary — every hour at :00 (checks date.getDate() === 1 && hour internally)
  cron.schedule("0 * * * *", () => {
    monthlyTick();
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

  // Flow reminder tick — every minute, checks active flows for halflife warning + timeout notification
  cron.schedule("* * * * *", () => {
    flowReminderTick();
  });

  // Expense templates — every hour at :00 (checks hour === 7 internally)
  cron.schedule("0 * * * *", () => {
    expenseTemplateTick();
  });

  // Subscription sweep (trial expiry + past_due downgrade) — every hour at :15
  cron.schedule("15 * * * *", () => {
    subscriptionSweepTick().catch(err => console.error("[scheduler] subscription sweep failed:", err));
  });

  console.log("[scheduler] Cron jobs started — weekly summary + monthly summary + daily weather alerts + proactive alerts (incl. low stock, phenology) + daily cleanup + flow reminders + expense templates + subscription sweep");
}

async function subscriptionSweepTick() {
  // Only run once per day around 03:15 AR to avoid hammering the DB hourly.
  const argTzNow = new Date();
  if (argTzNow.toLocaleString('es-AR', { hour: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }) !== '03') {
    return;
  }
  try {
    const { SubscriptionService } = await import("../domain/billing/subscription.service.js");
    const svc = new SubscriptionService();
    const r = await svc.sweepExpired();
    if (r.trialExpired || r.pastDueCancelled || r.cancelledDowngraded) {
      console.log(`[scheduler] subscription sweep — trialExpired=${r.trialExpired} pastDueCancelled=${r.pastDueCancelled} cancelledDowngraded=${r.cancelledDowngraded}`);
    }
  } catch (err) {
    console.error("[scheduler] subscriptionSweepTick error:", err);
  }
}
