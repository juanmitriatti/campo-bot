import cron from "node-cron";
import { pool } from "../config/db.js";
import { sendMessage } from "./whatsapp.js";
import { getUsersWithRainAlerts, getGlobalSettings } from "./expenses.js";
import { getForecast } from "./weather.js";

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
       LEFT JOIN fields f ON r.field_id = f.id
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
// Daily Weather Alert
// ---------------------------------------------------------------------------

async function getUserFieldCities(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT city FROM fields WHERE user_id = $1 AND city IS NOT NULL`,
    [userId]
  );
  return rows.map(r => r.city);
}

async function checkWeatherForUser(user) {
  const cities = new Set();

  // Add user's own city
  if (user.city) cities.add(user.city);

  // Add field cities
  const fieldCities = await getUserFieldCities(user.id);
  for (const c of fieldCities) cities.add(c);

  if (cities.size === 0) return;

  const threshold = user.rain_alert_mm || 10;
  const alerts = [];

  for (const city of cities) {
    try {
      const forecastData = await getForecast(city, 2);
      for (const day of forecastData.forecast) {
        if (day.rain >= threshold) {
          alerts.push({
            city: forecastData.city || city,
            dayName: day.dayName,
            rain: day.rain,
            icon: day.icon,
          });
        }
      }
    } catch (err) {
      console.error(`[weather-alert] Error fetching forecast for ${city}:`, err.message);
    }
  }

  if (alerts.length === 0) return;

  let msg = "🌧️ *Alerta de lluvia*\n";
  for (const a of alerts) {
    msg += `\n${a.icon} *${a.city}* — ${a.dayName}: ${a.rain}mm estimados`;
  }
  msg += `\n\n_Umbral configurado: ${threshold}mm_`;

  try {
    await sendMessage(user.phone_number, msg);
    console.log(`[weather-alert] Rain alert sent to user ${user.id} (${user.phone_number})`);
  } catch (err) {
    console.error(`[weather-alert] Error sending to user ${user.id}:`, err.message);
  }
}

async function weatherAlertTick() {
  try {
    const globalSettings = await getGlobalSettings();
    if (!globalSettings.daily_weather_enabled) return;

    const { hour } = getArgentinaTime();
    if (hour !== globalSettings.daily_weather_hour) return;

    console.log(`[weather-alert] Running daily weather check at hour ${hour}`);

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
// Public API
// ---------------------------------------------------------------------------

export function startScheduler() {
  // Weekly summary — every hour at :00
  cron.schedule("0 * * * *", () => {
    tick();
  });

  // Daily weather alerts — every hour at :00 (checks global_settings.daily_weather_hour)
  cron.schedule("0 * * * *", () => {
    weatherAlertTick();
  });

  console.log("[scheduler] Cron jobs started — weekly summary + daily weather alerts (hourly tick)");
}
