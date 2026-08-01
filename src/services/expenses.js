import { pool, withTransaction } from "../config/db.js";
import { getTodayISO } from "../utils/date.js";
import { sqlNormalizedName, normalizeEntityName, stripLeadingArticle } from "../utils/entity-matcher.js";

/**
 * Helper: returns a SQL subquery fragment for accessible field IDs
 * (own fields + fields shared via field_members).
 * Usage: `WHERE f.id IN (${accessibleFieldsSql(paramIdx)})` with userId as param.
 *
 * Used to live as "only field_members" which silently blocked owners from
 * seeing their own data — many callers had to add `(user_id = $X OR ...)`
 * to compensate. Now the helper covers both cases consistently.
 */
function accessibleFieldsSql(paramIdx) {
  return `SELECT id FROM fields WHERE user_id = $${paramIdx} AND deleted_at IS NULL
          UNION
          SELECT field_id FROM field_members WHERE user_id = $${paramIdx}`;
}

export async function getOrCreateUser(phone) {
  const existing = await pool.query(
    "SELECT * FROM users WHERE phone_number=$1",
    [phone]
  );

  if (existing.rows.length > 0) return existing.rows[0];

  const newUser = await pool.query(
    "INSERT INTO users (phone_number) VALUES ($1) RETURNING *",
    [phone]
  );

  return newUser.rows[0];
}

export async function getOrCreateUserByTelegramId(telegramId, name = null) {
  const existing = await pool.query(
    "SELECT * FROM users WHERE telegram_id = $1",
    [telegramId]
  );

  if (existing.rows.length > 0) return existing.rows[0];

  // Use tg_<id> as phone_number placeholder for store compatibility
  const phonePlaceholder = `tg_${telegramId}`;
  const newUser = await pool.query(
    "INSERT INTO users (phone_number, telegram_id, name) VALUES ($1, $2, $3) RETURNING *",
    [phonePlaceholder, telegramId, name]
  );

  // Ensure user_settings row
  await pool.query(
    "INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [newUser.rows[0].id]
  );

  return newUser.rows[0];
}

export async function setUserName(userId, name) {
  await pool.query(
    "UPDATE users SET name = $1 WHERE id = $2",
    [name, userId]
  );
}

export async function setUserCity(userId, city, province = null) {
  await pool.query(
    "UPDATE users SET city = $1, province = COALESCE($3, province) WHERE id = $2",
    [city, userId, province]
  );
}

export async function setUserEmail(userId, email) {
  await pool.query(
    "UPDATE users SET email = $1 WHERE id = $2",
    [email, userId]
  );
}

// --- User settings ---

export async function getUserSettings(userId) {
  const result = await pool.query(
    "SELECT * FROM user_settings WHERE user_id = $1",
    [userId]
  );
  if (result.rows.length === 0) {
    // Return defaults
    return {
      weekly_summary: true,
      weekly_summary_day: 0,
      weekly_summary_hour: 19,
      budget_alerts: true,
      rain_alerts: true,
      confirm_before_save: true,
      claude_daily_limit: 50,
      rain_alert_mm: 10,
    };
  }
  return result.rows[0];
}

export async function updateUserSetting(userId, field, value) {
  // Whitelist allowed fields
  const allowed = [
    "weekly_summary", "weekly_summary_day", "weekly_summary_hour",
    "budget_alerts", "rain_alerts", "confirm_before_save",
    "claude_daily_limit", "rain_alert_mm", "max_fields"
  ];
  if (!allowed.includes(field)) throw new Error("Invalid setting field");

  await pool.query(
    `INSERT INTO user_settings (user_id, ${field}) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET ${field} = $2`,
    [userId, value]
  );
}

// --- Global settings ---

export async function getGlobalSettings() {
  const result = await pool.query("SELECT * FROM global_settings WHERE id = 1");
  if (result.rows.length === 0) {
    return {
      daily_weather_enabled: true,
      daily_weather_hour: '06:00',
      default_rain_alert_mm: 10,
      budget_alert_80: true,
      budget_alert_100: true,
    };
  }
  return result.rows[0];
}

export async function updateGlobalSettings(settings) {
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
      settings.daily_weather_enabled,
      settings.daily_weather_hour,
      settings.default_rain_alert_mm,
      settings.budget_alert_80,
      settings.budget_alert_100,
    ]
  );
  return result.rows[0];
}

export async function getUsersWithRainAlerts() {
  const { rows } = await pool.query(
    `SELECT u.id, u.phone_number, u.telegram_id, u.city,
            COALESCE(s.rain_alert_mm, (SELECT default_rain_alert_mm FROM global_settings WHERE id = 1), 10) AS rain_alert_mm,
            COALESCE(s.wind_alerts, true) AS wind_alerts,
            COALESCE(s.wind_alert_kmh, (SELECT default_wind_alert_kmh FROM global_settings WHERE id = 1), 20) AS wind_alert_kmh,
            COALESCE(s.dry_window_alerts, true) AS dry_window_alerts,
            COALESCE(s.dry_window_days, (SELECT default_dry_window_days FROM global_settings WHERE id = 1), 3) AS dry_window_days
     FROM users u
     JOIN user_settings s ON s.user_id = u.id
     WHERE s.rain_alerts = true OR s.wind_alerts = true OR s.dry_window_alerts = true`
  );
  return rows;
}

// --- Monthly reports ---

export async function getMonthlyReport(userId) {
  const result = await pool.query(
    `SELECT category, COALESCE(currency, 'ARS') as currency, SUM(amount) as total
     FROM expenses
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)}))
     AND deleted_at IS NULL
     AND date_trunc('month', expense_date) = date_trunc('month', NOW())
     GROUP BY category, COALESCE(currency, 'ARS')
     ORDER BY total DESC`,
    [userId]
  );
  return result.rows;
}

export async function getMonthlyReportByPlot(userId) {
  const result = await pool.query(
    `WITH accessible_fields AS (
       ${accessibleFieldsSql(1)}
     ),
     accessible_plots AS (
       SELECT p.id FROM plots p WHERE p.field_id IN (SELECT field_id FROM accessible_fields) AND p.deleted_at IS NULL
     ),
     plot_expenses AS (
       SELECT plot_id, COALESCE(currency, 'ARS') as currency, COALESCE(SUM(amount), 0) as total
       FROM expenses
       WHERE deleted_at IS NULL AND plot_id IN (SELECT id FROM accessible_plots)
       AND date_trunc('month', expense_date) = date_trunc('month', NOW())
       GROUP BY plot_id, COALESCE(currency, 'ARS')
     ),
     plot_incomes AS (
       SELECT plot_id, COALESCE(currency, 'ARS') as currency, COALESCE(SUM(amount), 0) as total
       FROM incomes
       WHERE deleted_at IS NULL AND plot_id IN (SELECT id FROM accessible_plots)
       AND date_trunc('month', income_date) = date_trunc('month', NOW())
       GROUP BY plot_id, COALESCE(currency, 'ARS')
     ),
     pairs AS (
       SELECT plot_id, currency FROM plot_expenses
       UNION
       SELECT plot_id, currency FROM plot_incomes
     )
     SELECT p.name as plot_name, f.name as field_name, pr.currency as currency,
            COALESCE(pe.total, 0) as expense_total,
            COALESCE(pi.total, 0) as income_total
     FROM pairs pr
     JOIN plots p ON pr.plot_id = p.id AND p.deleted_at IS NULL
     JOIN fields f ON p.field_id = f.id AND f.deleted_at IS NULL
     LEFT JOIN plot_expenses pe ON pe.plot_id = pr.plot_id AND pe.currency = pr.currency
     LEFT JOIN plot_incomes pi ON pi.plot_id = pr.plot_id AND pi.currency = pr.currency
     ORDER BY COALESCE(pe.total, 0) + COALESCE(pi.total, 0) DESC`,
    [userId]
  );
  return result.rows;
}

export async function getMonthlyReportForMonth(userId, month, year) {
  const result = await pool.query(
    `SELECT category, COALESCE(currency, 'ARS') as currency, SUM(amount) as total
     FROM expenses
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)}))
     AND deleted_at IS NULL
     AND EXTRACT(MONTH FROM expense_date) = $2
     AND EXTRACT(YEAR FROM expense_date) = $3
     GROUP BY category, COALESCE(currency, 'ARS')
     ORDER BY total DESC`,
    [userId, month + 1, year]
  );
  return result.rows;
}

// --- AI usage ---

export async function saveAiUsage(userId, usage) {
  const cacheRead = usage.cache_read_tokens || 0;
  const cacheWrite = usage.cache_write_tokens || 0;
  // Haiku 4.5 pricing — input 1x, cache read 0.1x, cache write 1.25x (5min TTL)
  const cost = (usage.input_tokens / 1_000_000 * 0.80) +
               (cacheRead / 1_000_000 * 0.08) +
               (cacheWrite / 1_000_000 * 1.00) +
               (usage.output_tokens / 1_000_000 * 4);

  await pool.query(
    `INSERT INTO ai_usage (user_id, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      usage.input_tokens,
      usage.output_tokens,
      usage.input_tokens + usage.output_tokens + cacheRead + cacheWrite,
      cacheRead,
      cacheWrite,
    ]
  );

  console.log(`COST: $${cost.toFixed(6)} USD (in:${usage.input_tokens} cache_r:${cacheRead} cache_w:${cacheWrite} out:${usage.output_tokens})`);
}

export async function getDailyClaudeCount(userId) {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM ai_usage
     WHERE user_id = $1
     AND created_at >= CURRENT_DATE`,
    [userId]
  );
  return parseInt(result.rows[0].count);
}

export async function getUserFinancialSummary(userId) {
  const accessCond = `(user_id = $1 OR field_id IN (${accessibleFieldsSql(1)}))`;
  const [expensesR, incomesR, expCountR, incCountR] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
       WHERE ${accessCond} AND deleted_at IS NULL
       AND date_trunc('month', expense_date) = date_trunc('month', NOW())`,
      [userId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM incomes
       WHERE ${accessCond} AND deleted_at IS NULL
       AND date_trunc('month', income_date) = date_trunc('month', NOW())`,
      [userId]
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM expenses
       WHERE ${accessCond} AND deleted_at IS NULL
       AND date_trunc('month', expense_date) = date_trunc('month', NOW())`,
      [userId]
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM incomes
       WHERE ${accessCond} AND deleted_at IS NULL
       AND date_trunc('month', income_date) = date_trunc('month', NOW())`,
      [userId]
    ),
  ]);

  const totalExpenses = parseFloat(expensesR.rows[0].total);
  const totalIncome = parseFloat(incomesR.rows[0].total);
  return {
    totalExpenses,
    totalIncome,
    balance: totalIncome - totalExpenses,
    transactionCount: parseInt(expCountR.rows[0].count) + parseInt(incCountR.rows[0].count),
  };
}

// --- AI Fallback Logs ---

export async function saveAiFallbackLog(userId, inputText, claudeResponse, usage) {
  const tokensUsed = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  // Haiku 4.5: input 0.80/M, cache read 0.08/M, cache write 1.00/M, output 4.00/M
  const costUsd = ((usage.input_tokens || 0) / 1_000_000 * 0.80) +
                  ((usage.cache_read_tokens || 0) / 1_000_000 * 0.08) +
                  ((usage.cache_write_tokens || 0) / 1_000_000 * 1.00) +
                  ((usage.output_tokens || 0) / 1_000_000 * 4);

  await pool.query(
    `INSERT INTO ai_fallback_logs (user_id, input_text, claude_response, tokens_used, cost_usd)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, inputText, JSON.stringify(claudeResponse), tokensUsed, costUsd]
  );
}

export async function getAiFallbackLogs(limit = 50, offset = 0) {
  const result = await pool.query(
    `SELECT fl.id, fl.input_text, fl.claude_response, fl.tokens_used, fl.cost_usd, fl.created_at,
            u.name, u.phone_number
     FROM ai_fallback_logs fl
     JOIN users u ON fl.user_id = u.id
     ORDER BY fl.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

export async function getAiFallbackSummary() {
  const result = await pool.query(
    `SELECT COUNT(*) AS total_calls,
            COALESCE(SUM(tokens_used), 0) AS total_tokens,
            COALESCE(SUM(cost_usd), 0) AS total_cost,
            COALESCE(AVG(cost_usd), 0) AS avg_cost
     FROM ai_fallback_logs`
  );
  const row = result.rows[0];
  return {
    totalCalls: parseInt(row.total_calls),
    totalTokens: parseInt(row.total_tokens),
    totalCost: parseFloat(row.total_cost),
    avgCost: parseFloat(row.avg_cost),
  };
}

// --- Expenses ---

export async function saveExpense(userId, data, fieldId = null, plotId = null) {
  const result = await pool.query(
    `INSERT INTO expenses
    (user_id, category, description, amount, currency, field_id, plot_id, expense_date, expense_type, product, quantity, unit, unit_price)
    VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::date, CURRENT_DATE), $9, $10, $11, $12, $13)
    RETURNING id`,
    [
      userId,
      data.category,
      data.description || "",
      data.amount,
      data.currency || "ARS",
      fieldId,
      plotId,
      data.expenseDate || null,
      data.expenseType || 'varios',
      data.product || null,
      data.quantity || null,
      data.unit || null,
      data.unit_price ?? null,
    ]
  );
  return result.rows[0];
}

// --- Incomes ---

export async function saveIncome(userId, data, fieldId = null, plotId = null) {
  const result = await pool.query(
    `INSERT INTO incomes
    (user_id, category, description, amount, currency, quantity, unit, unit_price, field_id, plot_id, income_date)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::date, CURRENT_DATE))
    RETURNING id`,
    [
      userId,
      data.category,
      data.description || "",
      data.amount,
      data.currency || "ARS",
      data.quantity || null,
      data.unit || null,
      data.unit_price || null,
      fieldId,
      plotId,
      data.incomeDate || null
    ]
  );
  return result.rows[0];
}

export async function getMonthlyIncomeReport(userId) {
  const result = await pool.query(
    `SELECT category, SUM(amount) as total
     FROM incomes
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)}))
     AND deleted_at IS NULL
     AND date_trunc('month', income_date) = date_trunc('month', NOW())
     GROUP BY category
     ORDER BY total DESC`,
    [userId]
  );
  return result.rows;
}

export async function getMonthlyIncomeForMonth(userId, month, year) {
  const result = await pool.query(
    `SELECT category, SUM(amount) as total
     FROM incomes
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)}))
     AND deleted_at IS NULL
     AND EXTRACT(MONTH FROM income_date) = $2
     AND EXTRACT(YEAR FROM income_date) = $3
     GROUP BY category
     ORDER BY total DESC`,
    [userId, month + 1, year]
  );
  return result.rows;
}

export async function getLastIncome(userId) {
  const result = await pool.query(
    `SELECT * FROM incomes
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function deleteIncome(incomeId) {
  await pool.query(
    `UPDATE incomes SET deleted_at = NOW() WHERE id = $1`,
    [incomeId]
  );
}

/** See findExpenseByCriteria — same shape, against the incomes table. */
export async function findIncomeByCriteria(userId, { amount = null, category = null, date = null } = {}) {
  if (amount == null && !category && !date) return null;
  const params = [userId];
  const conditions = ['user_id = $1', 'deleted_at IS NULL'];
  let idx = 2;
  if (amount != null) {
    const tol = Math.max(0.01, Math.abs(amount) * 0.005);
    conditions.push(`amount BETWEEN $${idx} AND $${idx + 1}`);
    params.push(amount - tol, amount + tol);
    idx += 2;
  }
  if (category) {
    conditions.push(`LOWER(category) = LOWER($${idx})`);
    params.push(category);
    idx++;
  }
  if (date) {
    conditions.push(`income_date::text = $${idx}`);
    params.push(date);
    idx++;
  }
  const result = await pool.query(
    `SELECT * FROM incomes WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 1`,
    params,
  );
  return result.rows[0] || null;
}

/** Update arbitrary editable fields of an income. Pass only what changes. */
export async function updateIncomeFields(incomeId, { amount = null, category = null, incomeDate = null, fieldId = undefined, plotId = undefined } = {}) {
  const sets = [];
  const params = [];
  let idx = 1;
  if (amount != null) { sets.push(`amount = $${idx++}`); params.push(amount); }
  if (category) { sets.push(`category = $${idx++}`); params.push(category); }
  if (incomeDate) { sets.push(`income_date = $${idx++}`); params.push(incomeDate); }
  if (fieldId !== undefined) { sets.push(`field_id = $${idx++}`); params.push(fieldId); }
  if (plotId !== undefined) { sets.push(`plot_id = $${idx++}`); params.push(plotId); }
  if (sets.length === 0) return;
  params.push(incomeId);
  await pool.query(`UPDATE incomes SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

// --- Monthly result (income - expenses) ---

export async function getMonthlyResult(userId) {
  const incomes = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) as total
     FROM incomes
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)})) AND deleted_at IS NULL
     AND date_trunc('month', income_date) = date_trunc('month', NOW())`,
    [userId]
  );
  const expenses = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) as total
     FROM expenses
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)})) AND deleted_at IS NULL
     AND date_trunc('month', expense_date) = date_trunc('month', NOW())`,
    [userId]
  );
  return {
    ingresos: Number(incomes.rows[0].total),
    gastos: Number(expenses.rows[0].total)
  };
}

// Currency-aware P&L for the current month. Splits ingresos/gastos by
// currency so we don't pretend USD 9000 + ARS 400000 = 409000.
export async function getMonthlyResultByCurrency(userId) {
  const incomes = await pool.query(
    `SELECT COALESCE(currency, 'ARS') AS cur, COALESCE(SUM(amount), 0)::numeric AS total
     FROM incomes
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)})) AND deleted_at IS NULL
       AND date_trunc('month', income_date) = date_trunc('month', NOW())
     GROUP BY COALESCE(currency, 'ARS')`,
    [userId]
  );
  const expenses = await pool.query(
    `SELECT COALESCE(currency, 'ARS') AS cur, COALESCE(SUM(amount), 0)::numeric AS total
     FROM expenses
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)})) AND deleted_at IS NULL
       AND date_trunc('month', expense_date) = date_trunc('month', NOW())
     GROUP BY COALESCE(currency, 'ARS')`,
    [userId]
  );
  const out = { ARS: { ingresos: 0, gastos: 0 }, USD: { ingresos: 0, gastos: 0 } };
  for (const r of incomes.rows) out[r.cur] = out[r.cur] || { ingresos: 0, gastos: 0 }, out[r.cur].ingresos = Number(r.total);
  for (const r of expenses.rows) out[r.cur] = out[r.cur] || { ingresos: 0, gastos: 0 }, out[r.cur].gastos = Number(r.total);
  return out;
}

export async function getFieldResult(userId, fieldName) {
  const incomes = await pool.query(
    `SELECT COALESCE(i.currency, 'ARS') as currency, COALESCE(SUM(i.amount), 0) as total
     FROM incomes i
     JOIN fields f ON i.field_id = f.id
     WHERE f.id IN (${accessibleFieldsSql(1)}) AND i.deleted_at IS NULL
     AND LOWER(f.name) = LOWER($2)
     AND date_trunc('month', i.income_date) = date_trunc('month', NOW())
     GROUP BY COALESCE(i.currency, 'ARS')`,
    [userId, fieldName]
  );
  const expenses = await pool.query(
    `SELECT COALESCE(e.currency, 'ARS') as currency, COALESCE(SUM(e.amount), 0) as total
     FROM expenses e
     JOIN fields f ON e.field_id = f.id
     WHERE f.id IN (${accessibleFieldsSql(1)}) AND e.deleted_at IS NULL
     AND LOWER(f.name) = LOWER($2)
     AND date_trunc('month', e.expense_date) = date_trunc('month', NOW())
     GROUP BY COALESCE(e.currency, 'ARS')`,
    [userId, fieldName]
  );
  return {
    ingresos: incomes.rows.reduce((a, r) => a + Number(r.total), 0),
    gastos: expenses.rows.reduce((a, r) => a + Number(r.total), 0),
    byCurrency: mergeResultByCurrency(incomes.rows, expenses.rows),
  };
}

// --- Budgets ---

export async function setBudget(userId, category, monthlyLimit) {
  await pool.query(
    `INSERT INTO budgets (user_id, category, monthly_limit)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, category)
     DO UPDATE SET monthly_limit = $3`,
    [userId, category, monthlyLimit]
  );
}

export async function getBudget(userId, category) {
  const result = await pool.query(
    `SELECT * FROM budgets WHERE user_id = $1 AND category = $2`,
    [userId, category]
  );
  return result.rows[0] || null;
}

export async function getCategoryMonthlyTotal(userId, category) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) as total
     FROM expenses
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)}))
     AND deleted_at IS NULL
     AND LOWER(category) = LOWER($2)
     AND date_trunc('month', expense_date) = date_trunc('month', NOW())`,
    [userId, category]
  );
  return Number(result.rows[0].total);
}

export async function getPreviousMonthCategoryTotal(userId, category) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) as total
     FROM expenses
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)}))
     AND deleted_at IS NULL
     AND LOWER(category) = LOWER($2)
     AND date_trunc('month', expense_date) = date_trunc('month', NOW() - interval '1 month')`,
    [userId, category]
  );
  return Number(result.rows[0].total);
}

export async function checkBudgetAlert(total, limit, category, userName, userId, globalSettings = null) {
  const pct = total / limit;
  const nombre = userName ? ` ${userName}` : "";

  let prevInsight = "";
  if (userId) {
    const prevTotal = await getPreviousMonthCategoryTotal(userId, category);
    if (prevTotal > 0) {
      const diff = Math.round(((total - prevTotal) / prevTotal) * 100);
      if (diff > 0) {
        prevInsight = `\n📊 ${diff}% más que el mes pasado en ${category}`;
      } else if (diff < 0) {
        prevInsight = `\n📊 ${Math.abs(diff)}% menos que el mes pasado en ${category}`;
      }
    }
  }

  if (pct > 1) {
    // Check global toggle for 100% alerts
    if (globalSettings && globalSettings.budget_alert_100 === false) return null;
    const exceso = total - limit;
    return `🔴 Atención${nombre}:\nSuperaste el presupuesto mensual de *${category}*.\n\nPresupuesto: $${limit.toLocaleString("es-AR")}\nActual: $${total.toLocaleString("es-AR")}\nExceso: $${exceso.toLocaleString("es-AR")}${prevInsight}`;
  }
  if (pct > 0.8) {
    // Check global toggle for 80% alerts
    if (globalSettings && globalSettings.budget_alert_80 === false) return null;
    const restante = limit - total;
    return `⚠️ Atención${nombre}:\nVas al ${Math.round(pct * 100)}% del presupuesto de *${category}*.\n\nPresupuesto: $${limit.toLocaleString("es-AR")}\nActual: $${total.toLocaleString("es-AR")}\nRestante: $${restante.toLocaleString("es-AR")}${prevInsight}`;
  }
  return null;
}

// --- Weekly report ---

export async function getWeeklyReport(userId) {
  const result = await pool.query(
    `SELECT category, COALESCE(currency, 'ARS') as currency, SUM(amount) as total
     FROM expenses
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)}))
     AND deleted_at IS NULL
     AND expense_date >= date_trunc('week', NOW())
     GROUP BY category, COALESCE(currency, 'ARS')
     ORDER BY total DESC`,
    [userId]
  );
  return result.rows;
}

// --- Fields ---

export async function getOrCreateField(userId, name) {
  // Check accessible fields (owned + shared)
  const existing = await pool.query(
    `SELECT * FROM fields WHERE id IN (${accessibleFieldsSql(1)}) AND LOWER(name) = LOWER($2) AND deleted_at IS NULL`,
    [userId, name]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await pool.query(
    `INSERT INTO fields (user_id, name) VALUES ($1, $2) RETURNING *`,
    [userId, name]
  );

  // Auto-insert owner membership
  await pool.query(
    `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2) ON CONFLICT (field_id, user_id) DO NOTHING`,
    [result.rows[0].id, userId]
  );

  return result.rows[0];
}

export async function setFieldCity(userId, fieldName, city, province = null) {
  await pool.query(
    `UPDATE fields SET city = $1, province = COALESCE($4, province)
     WHERE id IN (${accessibleFieldsSql(2)}) AND LOWER(name) = LOWER($3)`,
    [city, userId, fieldName, province]
  );
}

export async function setFieldCoordinates(fieldId, lat, lng) {
  await pool.query(
    `UPDATE fields SET latitude = $1, longitude = $2, location_method = 'coordinates' WHERE id = $3`,
    [lat, lng, fieldId]
  );
}

export async function setFieldPolygon(fieldId, polygon, lat, lng, city, province) {
  await pool.query(
    `UPDATE fields SET polygon = $1, latitude = $2, longitude = $3, location_method = 'map',
     city = COALESCE(city, $4), province = COALESCE(province, $5) WHERE id = $6`,
    [JSON.stringify(polygon), lat, lng, city, province, fieldId]
  );
}

export async function getFieldByName(userId, fieldName) {
  // Match canónico (entity-matcher): case/acento/whitespace-insensitive.
  // El SQL anterior comparaba el nombre YA normalizado contra LOWER(name)
  // (con acentos) — "El Trébol" solo resolvía por el loop fuzzy O(N).
  const result = await pool.query(
    `SELECT * FROM fields WHERE id IN (${accessibleFieldsSql(1)}) AND ${sqlNormalizedName('name')} = ${sqlNormalizedName('$2::text')} AND deleted_at IS NULL`,
    [userId, fieldName]
  );
  if (result.rows[0]) return result.rows[0];

  // Fallback: artículo de apertura pelado en AMBOS lados ("Trébol" matchea
  // "El Trébol" y viceversa). Literal-primero/artículo-después, ver entity-matcher.
  const fuzzy = await pool.query(
    `SELECT * FROM fields WHERE id IN (${accessibleFieldsSql(1)}) AND deleted_at IS NULL`,
    [userId]
  );
  const target = normalizeEntityName(stripLeadingArticle(fieldName));
  for (const row of fuzzy.rows) {
    if (normalizeEntityName(stripLeadingArticle(row.name)) === target) {
      return row;
    }
  }
  return null;
}

export async function getUserFieldsWithCity(userId) {
  const result = await pool.query(
    `SELECT name, city, province FROM fields WHERE id IN (${accessibleFieldsSql(1)}) AND city IS NOT NULL AND deleted_at IS NULL`,
    [userId]
  );
  return result.rows;
}

export async function getUserFields(userId) {
  const result = await pool.query(
    `SELECT f.id, f.name, f.city, f.province, f.location_method,
            COUNT(p.id)::int AS plot_count,
            COALESCE(SUM(p.area_hectares), 0)::numeric AS total_hectares
     FROM fields f
     LEFT JOIN plots p ON p.field_id = f.id AND p.deleted_at IS NULL
     WHERE f.id IN (${accessibleFieldsSql(1)}) AND f.deleted_at IS NULL
     GROUP BY f.id, f.name, f.city, f.province, f.location_method
     ORDER BY f.name`,
    [userId]
  );
  return result.rows;
}

export async function getUserFieldCount(userId) {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM fields WHERE id IN (${accessibleFieldsSql(1)}) AND deleted_at IS NULL`,
    [userId]
  );
  return parseInt(result.rows[0].count);
}

export async function deleteField(userId, fieldName) {
  const field = await getFieldByName(userId, fieldName);
  if (!field) return false;

  // Soft delete field
  await pool.query(
    `UPDATE fields SET deleted_at = NOW(), deleted_by = 'user' WHERE id = $1`,
    [field.id]
  );

  // Soft delete associated plots
  await pool.query(
    `UPDATE plots SET deleted_at = NOW(), deleted_by = 'cascade' WHERE field_id = $1 AND deleted_at IS NULL`,
    [field.id]
  );

  // Unlink expenses/incomes/rainfall (keep data, just remove field/plot assignment)
  const plots = await pool.query(`SELECT id FROM plots WHERE field_id = $1`, [field.id]);
  for (const plot of plots.rows) {
    await pool.query(`UPDATE expenses SET plot_id = NULL WHERE plot_id = $1`, [plot.id]);
    await pool.query(`UPDATE incomes SET plot_id = NULL WHERE plot_id = $1`, [plot.id]);
  }
  await pool.query(`UPDATE expenses SET field_id = NULL WHERE field_id = $1`, [field.id]);
  await pool.query(`UPDATE incomes SET field_id = NULL WHERE field_id = $1`, [field.id]);
  await pool.query(`UPDATE rainfall SET field_id = NULL WHERE field_id = $1`, [field.id]);

  // Log deletion
  await pool.query(
    `INSERT INTO deletion_log (user_id, entity_type, entity_id, entity_name, metadata)
     VALUES ($1, 'field', $2, $3, $4)`,
    [userId, field.id, field.name, JSON.stringify({ city: field.city })]
  );

  return true;
}

export async function restoreField(userId, fieldName) {
  // Only owner can restore — check field_members for owner role on deleted fields
  const result = await pool.query(
    `UPDATE fields SET deleted_at = NULL, deleted_by = NULL
     WHERE id IN (SELECT fm.field_id FROM field_members fm WHERE fm.user_id = $1 AND fm.role = 'owner')
     AND LOWER(name) = LOWER($2) AND deleted_at IS NOT NULL
     RETURNING *`,
    [userId, fieldName]
  );
  if (result.rows.length === 0) return null;

  // Restore cascade-deleted plots
  await pool.query(
    `UPDATE plots SET deleted_at = NULL, deleted_by = NULL
     WHERE field_id = $1 AND deleted_by = 'cascade'`,
    [result.rows[0].id]
  );

  // Log restoration
  await pool.query(
    `UPDATE deletion_log SET restored_at = NOW()
     WHERE entity_type = 'field' AND entity_id = $1 AND restored_at IS NULL`,
    [result.rows[0].id]
  );

  return result.rows[0];
}

export async function renameField(userId, oldName, newName) {
  const field = await getFieldByName(userId, oldName);
  if (!field) return false;
  await pool.query(
    `UPDATE fields SET name = $1 WHERE id = $2`,
    [newName, field.id]
  );
  return true;
}

export async function renamePlot(userId, oldName, newName, fieldName) {
  const plots = await findPlotByNameAcrossFields(userId, oldName);
  if (!fieldName) {
    if (plots.length === 0) return null;
    // Auto-resolve if only one match
    const plot = plots[0];
    await pool.query(`UPDATE plots SET name = $1 WHERE id = $2`, [newName, plot.id]);
    return { id: plot.id, oldName: plot.name, newName, fieldName: plot.field_name };
  }
  const field = await getFieldByName(userId, fieldName);
  if (!field) return null;
  const plot = plots.find(p => p.field_id === field.id);
  if (!plot) return null;
  await pool.query(`UPDATE plots SET name = $1 WHERE id = $2`, [newName, plot.id]);
  return { id: plot.id, oldName: plot.name, newName, fieldName: field.name };
}

export async function getFieldInfo(userId, fieldName) {
  const field = await getFieldByName(userId, fieldName);
  if (!field) return null;

  const [expensesR, incomesR, rainfallR, plotsR, observationsR] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
       FROM expenses WHERE field_id = $1 AND deleted_at IS NULL
       AND date_trunc('month', expense_date) = date_trunc('month', NOW())`,
      [field.id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
       FROM incomes WHERE field_id = $1 AND deleted_at IS NULL
       AND date_trunc('month', income_date) = date_trunc('month', NOW())`,
      [field.id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(millimeters), 0) as total, COUNT(*) as count
       FROM rainfall WHERE field_id = $1
       AND date_trunc('month', rainfall_date) = date_trunc('month', NOW())`,
      [field.id]
    ),
    pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(area_hectares), 0) as total_hectares FROM plots WHERE field_id = $1 AND deleted_at IS NULL`,
      [field.id]
    ),
    pool.query(
      `SELECT ao.observation_text, ao.category, ao.created_at, p.name as plot_name
       FROM agro_observations ao
       LEFT JOIN plots p ON ao.plot_id = p.id
       WHERE ao.field_id = $1 AND ao.created_at >= NOW() - INTERVAL '30 days'
       ORDER BY ao.created_at DESC LIMIT 5`,
      [field.id]
    ),
  ]);

  return {
    name: field.name,
    city: field.city,
    province: field.province || null,
    expenses: { total: Number(expensesR.rows[0].total), count: parseInt(expensesR.rows[0].count) },
    incomes: { total: Number(incomesR.rows[0].total), count: parseInt(incomesR.rows[0].count) },
    rainfall: { total: Number(rainfallR.rows[0].total), count: parseInt(rainfallR.rows[0].count) },
    plotCount: parseInt(plotsR.rows[0].count),
    totalHectares: Number(plotsR.rows[0].total_hectares),
    observations: observationsR.rows,
  };
}

export async function getFieldReport(userId, fieldName) {
  const result = await pool.query(
    `SELECT e.category, COALESCE(e.currency, 'ARS') as currency, SUM(e.amount) as total
     FROM expenses e
     JOIN fields f ON e.field_id = f.id
     WHERE f.id IN (${accessibleFieldsSql(1)})
     AND e.deleted_at IS NULL
     AND f.deleted_at IS NULL
     AND LOWER(f.name) = LOWER($2)
     AND date_trunc('month', e.expense_date) = date_trunc('month', NOW())
     GROUP BY e.category, COALESCE(e.currency, 'ARS')
     ORDER BY total DESC`,
    [userId, fieldName]
  );
  return result.rows;
}

export async function getPlotReport(userId, plotName) {
  const plots = await findPlotByNameAcrossFields(userId, plotName);
  if (plots.length === 0) return null;
  const plot = plots[0];
  const [expenseResult, incomeResult] = await Promise.all([
    pool.query(
      `SELECT e.category, COALESCE(e.currency, 'ARS') as currency, SUM(e.amount) as total
       FROM expenses e
       WHERE e.plot_id = $1
       AND e.deleted_at IS NULL
       AND date_trunc('month', e.expense_date) = date_trunc('month', NOW())
       GROUP BY e.category, COALESCE(e.currency, 'ARS') ORDER BY total DESC`,
      [plot.id]
    ),
    pool.query(
      `SELECT COALESCE(i.currency, 'ARS') as currency, COALESCE(SUM(i.amount), 0) as total
       FROM incomes i
       WHERE i.plot_id = $1
       AND i.deleted_at IS NULL
       AND date_trunc('month', i.income_date) = date_trunc('month', NOW())
       GROUP BY COALESCE(i.currency, 'ARS')`,
      [plot.id]
    ),
  ]);
  const incomeByCurrency = {};
  for (const r of incomeResult.rows) incomeByCurrency[r.currency] = Number(r.total);
  return {
    rows: expenseResult.rows,
    plotName: plot.name,
    fieldName: plot.field_name,
    incomeTotal: incomeResult.rows.reduce((a, r) => a + Number(r.total), 0),
    incomeByCurrency,
  };
}

export async function getPlotResult(userId, plotName) {
  const plots = await findPlotByNameAcrossFields(userId, plotName);
  if (plots.length === 0) return null;
  const plot = plots[0];
  const incomes = await pool.query(
    `SELECT COALESCE(i.currency, 'ARS') as currency, COALESCE(SUM(i.amount), 0) as total
     FROM incomes i
     WHERE i.plot_id = $1
     AND i.deleted_at IS NULL
     AND date_trunc('month', i.income_date) = date_trunc('month', NOW())
     GROUP BY COALESCE(i.currency, 'ARS')`,
    [plot.id]
  );
  const expenses = await pool.query(
    `SELECT COALESCE(e.currency, 'ARS') as currency, COALESCE(SUM(e.amount), 0) as total
     FROM expenses e
     WHERE e.plot_id = $1
     AND e.deleted_at IS NULL
     AND date_trunc('month', e.expense_date) = date_trunc('month', NOW())
     GROUP BY COALESCE(e.currency, 'ARS')`,
    [plot.id]
  );
  const byCurrency = mergeResultByCurrency(incomes.rows, expenses.rows);
  return {
    ingresos: incomes.rows.reduce((a, r) => a + Number(r.total), 0),
    gastos: expenses.rows.reduce((a, r) => a + Number(r.total), 0),
    byCurrency,
    plotName: plot.name,
    fieldName: plot.field_name,
  };
}

/** Merge per-currency income/expense rows into { ARS:{ingresos,gastos}, USD:{...} }. */
function mergeResultByCurrency(incomeRows, expenseRows) {
  const out = {};
  const ensure = (c) => (out[c] ??= { ingresos: 0, gastos: 0 });
  for (const r of incomeRows) ensure(r.currency).ingresos = Number(r.total);
  for (const r of expenseRows) ensure(r.currency).gastos = Number(r.total);
  return out;
}

// --- Plots ---

export async function getOrCreatePlot(fieldId, name) {
  // Check de existencia con la MISMA normalización canónica que getPlotByName
  // (antes era LOWER plano: "El  Bajo" y "el bajo" creaban lotes duplicados).
  const existing = await pool.query(
    `SELECT * FROM plots WHERE field_id = $1 AND ${sqlNormalizedName('name')} = ${sqlNormalizedName('$2::text')} AND deleted_at IS NULL`,
    [fieldId, name]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await pool.query(
    `INSERT INTO plots (field_id, name) VALUES ($1, $2) RETURNING *`,
    [fieldId, name]
  );
  const inserted = result.rows[0];
  // Registrar aliases para resolución flexible — antes solo lo hacía
  // plotDiscovery en algunas rutas, y los lotes creados por add_plot quedaban
  // sin alias ("Lote Norte" no resolvía por "norte"). Best-effort.
  // OJO: normalizeEntityName (SIN acentos) — antes era trim().toLowerCase()
  // (CON acentos) y findPlotByAlias buscaba sin acentos → "Ñandú" registraba
  // un alias que jamás matcheaba su propia búsqueda.
  try {
    const norm = normalizeEntityName(name);
    await addPlotAlias(inserted.id, norm);
    if (norm.startsWith('lote ')) await addPlotAlias(inserted.id, norm.slice(5));
    if (/^\d+$/.test(norm)) await addPlotAlias(inserted.id, `lote ${norm}`);
  } catch { /* alias best-effort, no bloquea la creación */ }
  return inserted;
}

export async function getPlotByName(fieldId, plotName) {
  // Normalización canónica (entity-matcher): case/acento/whitespace-insensitive,
  // así "11 d"="11D" y "La Cañada"="la canada". Antes solo colapsaba espacios
  // (sin acentos) — divergía de getFieldByName y del validador.
  const result = await pool.query(
    `SELECT * FROM plots WHERE field_id = $1
       AND ${sqlNormalizedName('name')} = ${sqlNormalizedName('$2::text')}
       AND deleted_at IS NULL`,
    [fieldId, plotName]
  );
  return result.rows[0] || null;
}

export async function getPlotsByField(fieldId) {
  const result = await pool.query(
    `SELECT * FROM plots WHERE field_id = $1 AND deleted_at IS NULL ORDER BY name`,
    [fieldId]
  );
  return result.rows;
}

export async function findPlotByNameAcrossFields(userId, plotName) {
  // Whitespace-insensitive match (see getPlotByName) + convención "Lote X":
  // un lote guardado como "Lote Norte" matchea la consulta "norte" (el usuario
  // omite naturalmente el prefijo "lote"). El OR es estrictamente aditivo y
  // acotado — "norte" matchea "lotenorte" SOLO porque "lotenorte" = "lote" +
  // "norte", no es un substring difuso. Bug visto live (Jun 2026): "fumigué el
  // norte" no resolvía a "Lote Norte" y preguntaba "¿en qué lote?".
  const result = await pool.query(
    `SELECT p.*, f.name as field_name, f.id as field_id
     FROM plots p
     JOIN fields f ON p.field_id = f.id
     WHERE f.id IN (${accessibleFieldsSql(1)})
       AND (
         ${sqlNormalizedName('p.name')} = ${sqlNormalizedName('$2::text')}
         OR ${sqlNormalizedName('p.name')} = 'lote' || ${sqlNormalizedName('$2::text')}
       )
       AND p.deleted_at IS NULL AND f.deleted_at IS NULL`,
    [userId, plotName]
  );
  return result.rows;
}

export async function findAllUserPlots(userId) {
  const result = await pool.query(
    `SELECT p.id, p.name, p.field_id, p.area_hectares, f.name AS field_name
     FROM plots p JOIN fields f ON p.field_id = f.id
     WHERE f.id IN (${accessibleFieldsSql(1)}) AND p.deleted_at IS NULL AND f.deleted_at IS NULL
     ORDER BY f.name, p.name`,
    [userId]
  );
  return result.rows;
}

export async function deletePlot(plotId, userId = null) {
  // Soft delete plot
  await pool.query(
    `UPDATE plots SET deleted_at = NOW(), deleted_by = 'user' WHERE id = $1`,
    [plotId]
  );

  // Unlink expenses/incomes
  await pool.query(`UPDATE expenses SET plot_id = NULL WHERE plot_id = $1`, [plotId]);
  await pool.query(`UPDATE incomes SET plot_id = NULL WHERE plot_id = $1`, [plotId]);

  // Log deletion if userId provided
  if (userId) {
    const plotResult = await pool.query(`SELECT p.name, f.name as field_name FROM plots p JOIN fields f ON p.field_id = f.id WHERE p.id = $1`, [plotId]);
    if (plotResult.rows[0]) {
      await pool.query(
        `INSERT INTO deletion_log (user_id, entity_type, entity_id, entity_name, parent_name)
         VALUES ($1, 'plot', $2, $3, $4)`,
        [userId, plotId, plotResult.rows[0].name, plotResult.rows[0].field_name]
      );
    }
  }

  return true;
}

export async function restorePlot(userId, plotName, fieldName) {
  const result = await pool.query(
    `UPDATE plots SET deleted_at = NULL, deleted_by = NULL
     WHERE id IN (
       SELECT p.id FROM plots p
       JOIN fields f ON p.field_id = f.id
       WHERE f.id IN (${accessibleFieldsSql(1)}) AND LOWER(p.name) = LOWER($2)
         AND LOWER(f.name) = LOWER($3) AND p.deleted_at IS NOT NULL
     )
     RETURNING *`,
    [userId, plotName, fieldName]
  );
  if (result.rows.length === 0) return null;

  // Log restoration
  await pool.query(
    `UPDATE deletion_log SET restored_at = NOW()
     WHERE entity_type = 'plot' AND entity_id = $1 AND restored_at IS NULL`,
    [result.rows[0].id]
  );

  return result.rows[0];
}

export async function setPlotArea(plotId, hectares) {
  await pool.query(
    `UPDATE plots SET area_hectares = $1 WHERE id = $2`,
    [hectares, plotId]
  );
}

export async function setPlotGrupo(plotId, grupo) {
  await pool.query(
    `UPDATE plots SET grupo = $1 WHERE id = $2`,
    [grupo, plotId]
  );
}

export async function findPlotsByGrupo(userId, grupo) {
  const result = await pool.query(
    `SELECT p.*, f.name AS field_name
     FROM plots p
     JOIN fields f ON p.field_id = f.id
     WHERE LOWER(p.grupo) LIKE '%' || LOWER($2) || '%'
       AND p.deleted_at IS NULL AND f.deleted_at IS NULL
       AND f.id IN (${accessibleFieldsSql(1)})
     ORDER BY f.name, p.name`,
    [userId, grupo]
  );
  return result.rows;
}

export async function getPlotInfo(userId, plotName) {
  const plots = await findPlotByNameAcrossFields(userId, plotName);
  if (plots.length === 0) return null;
  const plot = plots[0];

  const [expensesR, incomesR, rainfallR, observationsR, activeCropR, recentActivitiesR] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
       FROM expenses WHERE plot_id = $1 AND deleted_at IS NULL
       AND date_trunc('month', expense_date) = date_trunc('month', NOW())`,
      [plot.id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
       FROM incomes WHERE plot_id = $1 AND deleted_at IS NULL
       AND date_trunc('month', income_date) = date_trunc('month', NOW())`,
      [plot.id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(millimeters), 0) as total, COUNT(*) as count
       FROM rainfall WHERE field_id = $1
       AND date_trunc('month', rainfall_date) = date_trunc('month', NOW())`,
      [plot.field_id]
    ),
    pool.query(
      `SELECT observation_text, category, created_at
       FROM agro_observations WHERE plot_id = $1
       AND created_at >= NOW() - INTERVAL '30 days'
       ORDER BY created_at DESC LIMIT 5`,
      [plot.id]
    ),
    pool.query(
      `SELECT crop, season_year FROM plot_crops
       WHERE plot_id = $1 AND end_date IS NULL
       ORDER BY start_date DESC LIMIT 1`,
      [plot.id]
    ),
    pool.query(
      `SELECT event_type, event_date, product, crop
       FROM domain_events WHERE plot_id = $1
         AND deleted_at IS NULL
       ORDER BY event_date DESC LIMIT 3`,
      [plot.id]
    ),
  ]);

  return {
    name: plot.name,
    field_name: plot.field_name,
    area_hectares: plot.area_hectares ? Number(plot.area_hectares) : null,
    soil_type: plot.soil_type,
    expenses: { total: Number(expensesR.rows[0].total), count: parseInt(expensesR.rows[0].count) },
    incomes: { total: Number(incomesR.rows[0].total), count: parseInt(incomesR.rows[0].count) },
    rainfall: { total: Number(rainfallR.rows[0].total), count: parseInt(rainfallR.rows[0].count) },
    observations: observationsR.rows,
    activeCrop: activeCropR.rows.length > 0 ? activeCropR.rows[0] : null,
    recentActivities: recentActivitiesR.rows,
  };
}

// --- Plot aliases & conversation state ---

export async function findPlotByAlias(userId, normalizedAlias) {
  // Normalizamos TAMBIÉN el lado columna: hay aliases legacy escritos con
  // acentos (el write-site viejo usaba trim().toLowerCase() sin NFD) que un
  // lookup exacto jamás matchearía. Ver entity-matcher.
  const result = await pool.query(
    `SELECT p.*, f.name as field_name, f.id as field_id
     FROM plot_aliases pa
     JOIN plots p ON pa.plot_id = p.id
     JOIN fields f ON p.field_id = f.id
     WHERE f.id IN (${accessibleFieldsSql(1)}) AND ${sqlNormalizedName('pa.alias')} = ${sqlNormalizedName('$2::text')}
       AND p.deleted_at IS NULL AND f.deleted_at IS NULL`,
    [userId, normalizedAlias]
  );
  return result.rows[0] || null;
}

export async function addPlotAlias(plotId, normalizedAlias) {
  await pool.query(
    `INSERT INTO plot_aliases (plot_id, alias) VALUES ($1, $2)
     ON CONFLICT (plot_id, alias) DO NOTHING`,
    [plotId, normalizedAlias]
  );
}

export async function getConversationState(userId) {
  const result = await pool.query(
    `SELECT cs.*, p.name as plot_name, f.name as field_name
     FROM conversation_state cs
     LEFT JOIN plots p ON cs.last_plot_id = p.id AND p.deleted_at IS NULL
     LEFT JOIN fields f ON cs.last_field_id = f.id AND f.deleted_at IS NULL
     WHERE cs.user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function updateConversationState(userId, fieldId, plotId) {
  // Read current stack, push new entry (dedup + max 3 LIFO), then write back
  const existing = await pool.query(
    `SELECT context_stack FROM conversation_state WHERE user_id = $1`,
    [userId],
  );
  const oldStack = existing.rows[0]?.context_stack ?? [];
  const newEntry = { field_id: fieldId, plot_id: plotId, ts: new Date().toISOString() };
  // Remove duplicate (same field+plot), prepend new entry, keep max 3
  const deduped = oldStack.filter(
    e => !(e.field_id === fieldId && e.plot_id === plotId)
  );
  const newStack = [newEntry, ...deduped].slice(0, 3);

  await pool.query(
    `INSERT INTO conversation_state (user_id, last_field_id, last_plot_id, context_stack, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       last_field_id = $2, last_plot_id = $3, context_stack = $4::jsonb, updated_at = NOW()`,
    [userId, fieldId, plotId, JSON.stringify(newStack)]
  );
}

export async function updateConversationMiniMemory(userId, { lastIntent, lastActivityType, lastQueryType, lastTimeReference }) {
  await pool.query(
    `INSERT INTO conversation_state (user_id, last_intent, last_activity_type, last_query_type, last_time_reference, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       last_intent = COALESCE($2, conversation_state.last_intent),
       last_activity_type = COALESCE($3, conversation_state.last_activity_type),
       last_query_type = COALESCE($4, conversation_state.last_query_type),
       last_time_reference = COALESCE($5, conversation_state.last_time_reference),
       updated_at = NOW()`,
    [userId, lastIntent || null, lastActivityType || null, lastQueryType || null, lastTimeReference || null]
  );
}

export async function getUserSingleField(userId) {
  const result = await pool.query(
    `SELECT * FROM fields WHERE id IN (${accessibleFieldsSql(1)}) AND deleted_at IS NULL`,
    [userId]
  );
  if (result.rows.length === 1) return result.rows[0];
  return null;
}

export async function getPlotById(plotId, userId = null) {
  const result = await pool.query(
    `SELECT p.*, f.name as field_name, f.user_id
     FROM plots p
     JOIN fields f ON p.field_id = f.id
     WHERE p.id = $1`,
    [plotId]
  );
  const row = result.rows[0] || null;
  if (row && userId !== null) {
    // Check access via field_members instead of direct user_id
    const { rows: access } = await pool.query(
      `SELECT 1 FROM field_members WHERE user_id = $1 AND field_id = $2 LIMIT 1`,
      [userId, row.field_id]
    );
    if (access.length === 0) return null;
  }
  return row;
}

// --- Edit / Delete ---

export async function getLastExpense(userId) {
  const result = await pool.query(
    `SELECT * FROM expenses
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function deleteExpense(expenseId) {
  await pool.query(
    `UPDATE expenses SET deleted_at = NOW() WHERE id = $1`,
    [expenseId]
  );
}

export async function updateExpenseAmount(expenseId, newAmount) {
  await pool.query(
    `UPDATE expenses SET amount = $1 WHERE id = $2`,
    [newAmount, expenseId]
  );
}

export async function findExpenseByFilter(userId, filter) {
  // Search by category or description keywords
  const result = await pool.query(
    `SELECT * FROM expenses
     WHERE user_id = $1 AND deleted_at IS NULL
     AND (LOWER(category) LIKE $2 OR LOWER(description) LIKE $2)
     ORDER BY created_at DESC LIMIT 1`,
    [userId, `%${filter.toLowerCase()}%`]
  );
  return result.rows[0] || null;
}

/**
 * Find an expense by structured criteria (any combination of amount + category
 * + date). At least one criterion must be present. Returns the MOST RECENT
 * match. amount uses ±0.5% tolerance so "el de 0.5" matches a $0.50 expense
 * stored as 0.500000 etc.
 *
 * Use this for the user-flow "borra el gasto de X" / "edita el de Y a Z" —
 * findExpenseByFilter is for fuzzy text search; this one is for typed slots.
 */
export async function findExpenseByCriteria(userId, { amount = null, category = null, date = null } = {}) {
  if (amount == null && !category && !date) return null;
  const params = [userId];
  const conditions = ['user_id = $1', 'deleted_at IS NULL'];
  let idx = 2;
  if (amount != null) {
    const tol = Math.max(0.01, Math.abs(amount) * 0.005);
    conditions.push(`amount BETWEEN $${idx} AND $${idx + 1}`);
    params.push(amount - tol, amount + tol);
    idx += 2;
  }
  if (category) {
    conditions.push(`LOWER(category) = LOWER($${idx})`);
    params.push(category);
    idx++;
  }
  if (date) {
    conditions.push(`expense_date::text = $${idx}`);
    params.push(date);
    idx++;
  }
  const result = await pool.query(
    `SELECT * FROM expenses WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 1`,
    params,
  );
  return result.rows[0] || null;
}

/** Update arbitrary editable fields of an expense. Pass only what changes. */
export async function updateExpenseFields(expenseId, { amount = null, category = null, expenseDate = null, fieldId = undefined, plotId = undefined, currency = null } = {}) {
  const sets = [];
  const params = [];
  let idx = 1;
  if (amount != null) { sets.push(`amount = $${idx++}`); params.push(amount); }
  if (category) { sets.push(`category = $${idx++}`); params.push(category); }
  if (expenseDate) { sets.push(`expense_date = $${idx++}`); params.push(expenseDate); }
  if (fieldId !== undefined) { sets.push(`field_id = $${idx++}`); params.push(fieldId); }
  if (plotId !== undefined) { sets.push(`plot_id = $${idx++}`); params.push(plotId); }
  if (currency === 'ARS' || currency === 'USD') { sets.push(`currency = $${idx++}`); params.push(currency); }
  if (sets.length === 0) return;
  params.push(expenseId);
  await pool.query(`UPDATE expenses SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

// --- Date range report (flexible: optional field, plot, category filters) ---

export async function getDateRangeReport(userId, desde, hasta, { fieldName = null, plotName = null, category = null, type = 'both' } = {}) {
  const params = [userId, desde, hasta];
  let idx = 4;

  // Build dynamic filters
  let fieldJoin = '';
  let fieldFilter = '';
  if (fieldName) {
    fieldJoin = 'LEFT JOIN fields f ON e.field_id = f.id';
    fieldFilter = `AND LOWER(f.name) = LOWER($${idx}) AND f.deleted_at IS NULL`;
    params.push(fieldName);
    idx++;
  }

  let plotJoin = '';
  let plotFilter = '';
  if (plotName) {
    plotJoin = 'LEFT JOIN plots p ON e.plot_id = p.id';
    plotFilter = `AND LOWER(p.name) = LOWER($${idx}) AND p.deleted_at IS NULL`;
    params.push(plotName);
    idx++;
  }

  let categoryFilter = '';
  if (category) {
    categoryFilter = `AND LOWER(e.category) = LOWER($${idx})`;
    params.push(category);
    idx++;
  }

  // Access filter: user's own data OR data on fields they have access to
  const accessFilter = `(e.user_id = $1 OR e.field_id IN (${accessibleFieldsSql(1)}))`;

  const results = { expenses: [], incomes: [], expenseTotal: 0, incomeTotal: 0 };

  if (type === 'expenses' || type === 'both') {
    const expQ = `SELECT e.category, SUM(e.amount) as total, e.currency
     FROM expenses e
     ${fieldJoin}
     ${plotJoin}
     WHERE ${accessFilter}
     AND e.deleted_at IS NULL
     AND e.expense_date >= $2
     AND e.expense_date <= $3
     ${fieldFilter} ${plotFilter} ${categoryFilter}
     GROUP BY e.category, e.currency
     ORDER BY total DESC`;
    const expR = await pool.query(expQ, params);
    results.expenses = expR.rows;
    results.expenseTotal = expR.rows.reduce((sum, r) => sum + (r.currency === 'USD' ? 0 : parseFloat(r.total)), 0);
  }

  if (type === 'incomes' || type === 'both') {
    // Rebuild params for incomes (same structure but different table/columns)
    const incParams = [userId, desde, hasta];
    let incIdx = 4;
    let incFieldJoin = '';
    let incFieldFilter = '';
    if (fieldName) {
      incFieldJoin = 'LEFT JOIN fields f ON i.field_id = f.id';
      incFieldFilter = `AND LOWER(f.name) = LOWER($${incIdx}) AND f.deleted_at IS NULL`;
      incParams.push(fieldName);
      incIdx++;
    }
    let incPlotJoin = '';
    let incPlotFilter = '';
    if (plotName) {
      incPlotJoin = 'LEFT JOIN plots p ON i.plot_id = p.id';
      incPlotFilter = `AND LOWER(p.name) = LOWER($${incIdx}) AND p.deleted_at IS NULL`;
      incParams.push(plotName);
      incIdx++;
    }
    let incCategoryFilter = '';
    if (category) {
      incCategoryFilter = `AND LOWER(i.category) = LOWER($${incIdx})`;
      incParams.push(category);
      incIdx++;
    }

    const incAccessFilter = `(i.user_id = $1 OR i.field_id IN (${accessibleFieldsSql(1)}))`;

    const incQ = `SELECT i.category, SUM(i.amount) as total, i.currency
     FROM incomes i
     ${incFieldJoin}
     ${incPlotJoin}
     WHERE ${incAccessFilter}
     AND i.deleted_at IS NULL
     AND i.income_date >= $2
     AND i.income_date <= $3
     ${incFieldFilter} ${incPlotFilter} ${incCategoryFilter}
     GROUP BY i.category, i.currency
     ORDER BY total DESC`;
    const incR = await pool.query(incQ, incParams);
    results.incomes = incR.rows;
    results.incomeTotal = incR.rows.reduce((sum, r) => sum + (r.currency === 'USD' ? 0 : parseFloat(r.total)), 0);
  }

  return results;
}

// --- Generic financial query builder ---
//
// One SQL builder that handles every dimension the user can throw at us:
// scope (field/plot), period (desde/hasta), category (in/not in), currency,
// amount range, description LIKE, sort, limit. The handler dispatches the
// rendering (detail / aggregate / max / compare) on top of this raw row set.
//
// IMPORTANT: never sums across currencies — callers split totals by currency.

function buildMovementFilters(prefix, params, opts) {
  // prefix: 'e' or 'i'. Returns "AND ..." fragment that the caller appends.
  let idx = params.length + 1;
  const fragments = [];
  const dateCol = prefix === 'e' ? 'expense_date' : 'income_date';

  if (opts.desde) {
    fragments.push(`${prefix}.${dateCol} >= $${idx}::date`);
    params.push(opts.desde);
    idx++;
  }
  if (opts.hasta) {
    fragments.push(`${prefix}.${dateCol} <= $${idx}::date`);
    params.push(opts.hasta);
    idx++;
  }
  if (opts.fieldName) {
    fragments.push(`LOWER(f.name) = LOWER($${idx})`);
    params.push(opts.fieldName);
    idx++;
  }
  if (opts.plotName) {
    fragments.push(`LOWER(p.name) = LOWER($${idx})`);
    params.push(opts.plotName);
    idx++;
  }
  if (opts.category) {
    fragments.push(`LOWER(${prefix}.category) = LOWER($${idx})`);
    params.push(opts.category);
    idx++;
  }
  if (opts.categories && opts.categories.length > 0) {
    // Multi-category include (OR). Used by "cereales" / "frutos secos" buckets.
    const placeholders = opts.categories.map(() => {
      const ph = `$${idx}`;
      idx++;
      return ph;
    });
    fragments.push(`LOWER(${prefix}.category) IN (${placeholders.map(p => `LOWER(${p})`).join(', ')})`);
    params.push(...opts.categories);
  }
  if (opts.excludeCategories && opts.excludeCategories.length > 0) {
    const placeholders = opts.excludeCategories.map(() => {
      const ph = `$${idx}`;
      idx++;
      return ph;
    });
    fragments.push(`LOWER(${prefix}.category) NOT IN (${placeholders.map(p => `LOWER(${p})`).join(', ')})`);
    params.push(...opts.excludeCategories);
  }
  if (opts.currency) {
    fragments.push(`${prefix}.currency = $${idx}`);
    params.push(opts.currency);
    idx++;
  }
  if (opts.amountMin != null) {
    fragments.push(`${prefix}.amount >= $${idx}`);
    params.push(opts.amountMin);
    idx++;
  }
  if (opts.amountMax != null) {
    fragments.push(`${prefix}.amount <= $${idx}`);
    params.push(opts.amountMax);
    idx++;
  }
  if (opts.descriptionSearch) {
    // Match against description AND product (some expenses store the product there, e.g. "glifosato").
    // incomes table doesn't have a `product` column — only expenses does. Conditional on prefix.
    if (prefix === 'e') {
      fragments.push(`(LOWER(${prefix}.description) LIKE LOWER($${idx}) OR LOWER(COALESCE(${prefix}.product, '')) LIKE LOWER($${idx}))`);
    } else {
      fragments.push(`LOWER(${prefix}.description) LIKE LOWER($${idx})`);
    }
    params.push(`%${opts.descriptionSearch}%`);
    idx++;
  }
  return fragments.length > 0 ? ' AND ' + fragments.join(' AND ') : '';
}

export async function queryMovements(userId, opts = {}) {
  const {
    type = 'both',
    sortBy = 'date',
    sortDesc = true,
    limit = 200,
  } = opts;
  const orderDir = sortDesc ? 'DESC' : 'ASC';
  const out = { expenses: [], incomes: [] };

  if (type === 'expenses' || type === 'both') {
    const params = [userId];
    const filtersSql = buildMovementFilters('e', params, { ...opts });
    params.push(limit);
    const limitIdx = params.length;
    const expOrderCol = sortBy === 'amount' ? 'amount' : 'expense_date';
    const sql = `
      SELECT e.id, e.expense_date AS date, e.category,
             COALESCE(NULLIF(e.description, ''), e.product) AS description,
             e.product, e.amount, e.currency,
             e.quantity, e.unit,
             f.name AS field_name, p.name AS plot_name
      FROM expenses e
      LEFT JOIN fields f ON e.field_id = f.id
      LEFT JOIN plots p ON e.plot_id = p.id
      WHERE (e.user_id = $1 OR e.field_id IN (${accessibleFieldsSql(1)}))
        AND e.deleted_at IS NULL
        ${filtersSql}
      ORDER BY e.${expOrderCol} ${orderDir}, e.id DESC
      LIMIT $${limitIdx}
    `;
    const res = await pool.query(sql, params);
    out.expenses = res.rows;
  }

  if (type === 'incomes' || type === 'both') {
    const params = [userId];
    const filtersSql = buildMovementFilters('i', params, { ...opts });
    params.push(limit);
    const limitIdx = params.length;
    const incOrderCol = sortBy === 'amount' ? 'amount' : 'income_date';
    const sql = `
      SELECT i.id, i.income_date AS date, i.category, i.description,
             NULL::text AS product, i.amount, i.currency,
             i.quantity, i.unit,
             f.name AS field_name, p.name AS plot_name
      FROM incomes i
      LEFT JOIN fields f ON i.field_id = f.id
      LEFT JOIN plots p ON i.plot_id = p.id
      WHERE (i.user_id = $1 OR i.field_id IN (${accessibleFieldsSql(1)}))
        AND i.deleted_at IS NULL
        ${filtersSql}
      ORDER BY i.${incOrderCol} ${orderDir}, i.id DESC
      LIMIT $${limitIdx}
    `;
    const res = await pool.query(sql, params);
    out.incomes = res.rows;
  }

  return out;
}

// --- Detailed movements list (used when the user asks "todos los gastos de X") ---

export async function getMovementsInRange(userId, desde, hasta, { fieldName = null, plotName = null, category = null, type = 'both', limit = 200 } = {}) {
  const out = { expenses: [], incomes: [] };

  if (type === 'expenses' || type === 'both') {
    const expParams = [userId, desde, hasta];
    let idx = 4;
    const filters = [];
    let join = '';
    if (fieldName) {
      filters.push(`LOWER(f.name) = LOWER($${idx})`);
      expParams.push(fieldName);
      idx++;
      join += ' LEFT JOIN fields f ON e.field_id = f.id';
    } else {
      join += ' LEFT JOIN fields f ON e.field_id = f.id';
    }
    if (plotName) {
      filters.push(`LOWER(p.name) = LOWER($${idx})`);
      expParams.push(plotName);
      idx++;
      join += ' LEFT JOIN plots p ON e.plot_id = p.id';
    } else {
      join += ' LEFT JOIN plots p ON e.plot_id = p.id';
    }
    if (category) {
      filters.push(`LOWER(e.category) = LOWER($${idx})`);
      expParams.push(category);
      idx++;
    }
    const where = filters.length ? ' AND ' + filters.join(' AND ') : '';
    expParams.push(limit);
    const expR = await pool.query(
      `SELECT e.id, e.expense_date AS date, e.category, e.description, e.amount, e.currency,
              f.name AS field_name, p.name AS plot_name
       FROM expenses e ${join}
       WHERE (e.user_id = $1 OR e.field_id IN (${accessibleFieldsSql(1)}))
         AND e.deleted_at IS NULL
         AND e.expense_date >= $2 AND e.expense_date <= $3 ${where}
       ORDER BY e.expense_date DESC, e.id DESC
       LIMIT $${idx}`,
      expParams
    );
    out.expenses = expR.rows;
  }

  if (type === 'incomes' || type === 'both') {
    const incParams = [userId, desde, hasta];
    let idx = 4;
    const filters = [];
    let join = ' LEFT JOIN fields f ON i.field_id = f.id LEFT JOIN plots p ON i.plot_id = p.id';
    if (fieldName) { filters.push(`LOWER(f.name) = LOWER($${idx})`); incParams.push(fieldName); idx++; }
    if (plotName) { filters.push(`LOWER(p.name) = LOWER($${idx})`); incParams.push(plotName); idx++; }
    if (category) { filters.push(`LOWER(i.category) = LOWER($${idx})`); incParams.push(category); idx++; }
    const where = filters.length ? ' AND ' + filters.join(' AND ') : '';
    incParams.push(limit);
    const incR = await pool.query(
      `SELECT i.id, i.income_date AS date, i.category, i.description, i.amount, i.currency,
              f.name AS field_name, p.name AS plot_name
       FROM incomes i ${join}
       WHERE (i.user_id = $1 OR i.field_id IN (${accessibleFieldsSql(1)}))
         AND i.deleted_at IS NULL
         AND i.income_date >= $2 AND i.income_date <= $3 ${where}
       ORDER BY i.income_date DESC, i.id DESC
       LIMIT $${idx}`,
      incParams
    );
    out.incomes = incR.rows;
  }

  return out;
}

// --- CSV export ---

export async function getMonthlyExpenses(userId) {
  const result = await pool.query(
    `SELECT e.expense_date, e.category, e.description, e.amount, e.currency, f.name as field_name
     FROM expenses e
     LEFT JOIN fields f ON e.field_id = f.id
     WHERE (e.user_id = $1 OR e.field_id IN (${accessibleFieldsSql(1)}))
     AND e.deleted_at IS NULL
     AND date_trunc('month', e.expense_date) = date_trunc('month', NOW())
     ORDER BY e.expense_date DESC`,
    [userId]
  );
  return result.rows;
}

// --- Rainfall ---

export const RAINFALL_REJECTED_DUPLICATE = { _rejected: 'duplicate_rainfall' };

export async function saveRainfall(userId, mm, fieldId = null, rainfallDate = null) {
  const effectiveDate = rainfallDate || null; // null → CURRENT_DATE via SQL default
  const existing = await pool.query(
    `SELECT id, millimeters FROM rainfall
     WHERE user_id = $1 AND COALESCE(field_id, 0) = COALESCE($2, 0)
       AND rainfall_date = COALESCE($3::date, CURRENT_DATE)`,
    [userId, fieldId, effectiveDate]
  );
  // R01 fix: instead of rejecting duplicate, SUM the new mm into existing entry.
  // Multiple rains the same day in same field are now aggregated (e.g. morning +
  // afternoon = total daily mm). Also handles "30mm en S1 y 22mm en S2" when
  // both plots belong to same field — the field-level total becomes 52mm.
  if (existing.rows.length > 0) {
    const prev = Number(existing.rows[0].millimeters);
    const updated = prev + Number(mm);
    const upd = await pool.query(
      `UPDATE rainfall SET millimeters = $1 WHERE id = $2 RETURNING *`,
      [updated, existing.rows[0].id]
    );
    return { ...upd.rows[0], _accumulated: true, _previous_mm: prev };
  }

  if (effectiveDate) {
    const result = await pool.query(
      `INSERT INTO rainfall (user_id, field_id, millimeters, rainfall_date)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, fieldId, mm, effectiveDate]
    );
    return result.rows[0];
  }
  const result = await pool.query(
    `INSERT INTO rainfall (user_id, field_id, millimeters)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, fieldId, mm]
  );
  return result.rows[0];
}

export async function getDailyRainfallTotal(userId, fieldId = null) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(millimeters), 0) AS total
     FROM rainfall
     WHERE user_id = $1
       AND COALESCE(field_id, 0) = COALESCE($2, 0)
       AND created_at::date = CURRENT_DATE`,
    [userId, fieldId]
  );
  return parseFloat(rows[0].total);
}

export async function deleteLastRainfall(userId) {
  const last = await pool.query(
    `SELECT * FROM rainfall WHERE user_id = $1 ORDER BY rainfall_date DESC, created_at DESC, id DESC LIMIT 1`,
    [userId]
  );
  if (last.rows.length === 0) return null;
  await pool.query(`DELETE FROM rainfall WHERE id = $1`, [last.rows[0].id]);
  return last.rows[0];
}

export async function getLastRainfall(userId) {
  const result = await pool.query(
    `SELECT * FROM rainfall WHERE user_id = $1 ORDER BY rainfall_date DESC, created_at DESC, id DESC LIMIT 1`,
    [userId],
  );
  return result.rows[0] || null;
}

export async function updateRainfallFields(rainfallId, { millimeters = null, rainfallDate = null, fieldId = undefined, plotId = undefined } = {}) {
  const sets = [];
  const params = [];
  let idx = 1;
  if (millimeters != null) { sets.push(`millimeters = $${idx++}`); params.push(millimeters); }
  if (rainfallDate) { sets.push(`rainfall_date = $${idx++}`); params.push(rainfallDate); }
  if (fieldId !== undefined) { sets.push(`field_id = $${idx++}`); params.push(fieldId); }
  if (plotId !== undefined) { sets.push(`plot_id = $${idx++}`); params.push(plotId); }
  if (sets.length === 0) return;
  params.push(rainfallId);
  await pool.query(`UPDATE rainfall SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

// --- Observation last/delete/update primitives (hard delete — no soft delete in schema) ---

export async function getLastObservation(userId) {
  const result = await pool.query(
    `SELECT * FROM agro_observations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return result.rows[0] || null;
}

export async function deleteObservation(observationId) {
  await pool.query(`DELETE FROM agro_observations WHERE id = $1`, [observationId]);
}

export async function updateObservationFields(observationId, { observationText = null, observationDate = null, fieldId = undefined, plotId = undefined } = {}) {
  const sets = [];
  const params = [];
  let idx = 1;
  if (observationText != null) { sets.push(`observation_text = $${idx++}`); params.push(observationText); }
  if (observationDate) { sets.push(`observation_date = $${idx++}`); params.push(observationDate); }
  if (fieldId !== undefined) { sets.push(`field_id = $${idx++}`); params.push(fieldId); }
  if (plotId !== undefined) { sets.push(`plot_id = $${idx++}`); params.push(plotId); }
  if (sets.length === 0) return;
  sets.push('updated_at = NOW()');
  params.push(observationId);
  await pool.query(`UPDATE agro_observations SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

// --- Crop scouting last/delete/update primitives (soft delete) ---

export async function getLastScouting(userId) {
  const result = await pool.query(
    `SELECT * FROM crop_scoutings WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return result.rows[0] || null;
}

export async function deleteScouting(scoutingId) {
  await pool.query(`UPDATE crop_scoutings SET deleted_at = NOW() WHERE id = $1`, [scoutingId]);
}

function rainfallDateCondition(period) {
  switch (period) {
    case "week": return "AND r.rainfall_date >= date_trunc('week', NOW())";
    case "last_week": return "AND r.rainfall_date >= date_trunc('week', NOW()) - INTERVAL '1 week' AND r.rainfall_date < date_trunc('week', NOW())";
    case "last_month": return "AND date_trunc('month', r.rainfall_date) = date_trunc('month', NOW() - INTERVAL '1 month')";
    case "year": return "AND EXTRACT(YEAR FROM r.rainfall_date) = EXTRACT(YEAR FROM NOW())";
    default: return "AND date_trunc('month', r.rainfall_date) = date_trunc('month', NOW())";
  }
}

export async function getRainfallPeriod(userId, period, fieldId = null) {
  const fieldCond = fieldId !== null ? "AND r.field_id = $2" : "";
  const params = fieldId !== null ? [userId, fieldId] : [userId];

  const dateCond = rainfallDateCondition(period);

  const result = await pool.query(
    `SELECT COALESCE(SUM(r.millimeters), 0) as total, COUNT(*) as registros
     FROM rainfall r
     WHERE r.user_id = $1 ${dateCond} ${fieldCond}`,
    params
  );
  return { total: Number(result.rows[0].total), registros: parseInt(result.rows[0].registros) };
}

export async function getRainfallAllLocations(userId, period = "month") {
  const dateCond = rainfallDateCondition(period);

  const result = await pool.query(
    `SELECT f.name as field_name, COALESCE(SUM(r.millimeters), 0) as total, COUNT(*) as registros
     FROM rainfall r
     LEFT JOIN fields f ON r.field_id = f.id AND f.deleted_at IS NULL
     WHERE (r.user_id = $1 OR r.field_id IN (${accessibleFieldsSql(1)})) ${dateCond}
     GROUP BY f.name
     ORDER BY total DESC`,
    [userId]
  );
  return result.rows;
}

export async function getRainfallForMonth(userId, month, year, fieldId = null) {
  const fieldCond = fieldId !== null ? "AND r.field_id = $4" : "";
  const params = fieldId !== null ? [userId, month + 1, year, fieldId] : [userId, month + 1, year];

  const result = await pool.query(
    `SELECT COALESCE(SUM(r.millimeters), 0) as total, COUNT(*) as registros
     FROM rainfall r
     WHERE r.user_id = $1
     AND EXTRACT(MONTH FROM r.rainfall_date) = $2
     AND EXTRACT(YEAR FROM r.rainfall_date) = $3
     ${fieldCond}`,
    params
  );
  return { total: Number(result.rows[0].total), registros: parseInt(result.rows[0].registros) };
}

export async function getRainfallForYear(userId, year) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(r.millimeters), 0) as total, COUNT(*) as registros
     FROM rainfall r
     WHERE r.user_id = $1 AND EXTRACT(YEAR FROM r.rainfall_date) = $2`,
    [userId, year]
  );
  return { total: Number(result.rows[0].total), registros: parseInt(result.rows[0].registros) };
}

export async function getRainfallRange(userId, desde, hasta) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(r.millimeters), 0) as total, COUNT(*) as registros
     FROM rainfall r
     WHERE r.user_id = $1
     AND r.rainfall_date >= $2
     AND r.rainfall_date <= $3`,
    [userId, desde, hasta]
  );
  return { total: Number(result.rows[0].total), registros: parseInt(result.rows[0].registros) };
}

// --- Plot crops ---

export async function createPlotCrop(plotId, crop, seasonYear, seasonType, startDate = null, sowedHectares = null) {
  // Fecha ART explícita en vez de CURRENT_DATE de la DB — si la sesión de
  // Postgres está en UTC (la migración 048 de TZ no siempre aplica), de noche
  // CURRENT_DATE daba MAÑANA, dejando plot_crops.start_date desfasado del
  // domain_events.event_date del mismo registro (hallazgo QA Jun 2026).
  const result = await pool.query(
    `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date, sowed_hectares)
     VALUES ($1, $2, $3, $4, COALESCE($5, $7::date), $6)
     RETURNING *`,
    [plotId, crop, seasonYear, seasonType, startDate, sowedHectares, getTodayISO()]
  );
  return result.rows[0];
}

export async function closePlotCrop(plotCropId, endDate = null) {
  const result = await pool.query(
    `UPDATE plot_crops SET end_date = COALESCE($2, CURRENT_DATE)
     WHERE id = $1 RETURNING *`,
    [plotCropId, endDate]
  );
  return result.rows[0] || null;
}

export async function getActiveCrop(plotId) {
  const result = await pool.query(
    `SELECT * FROM plot_crops WHERE plot_id = $1 AND end_date IS NULL LIMIT 1`,
    [plotId]
  );
  return result.rows[0] || null;
}

export async function getAllActiveCrops(userId, cropFilter = null, grupo = null) {
  const params = [userId];
  let idx = 2;
  let extraConditions = '';
  if (cropFilter) {
    extraConditions += ` AND LOWER(pc.crop) = LOWER($${idx})`;
    params.push(cropFilter);
    idx++;
  }
  if (grupo) {
    extraConditions += ` AND LOWER(p.grupo) LIKE '%' || LOWER($${idx}) || '%'`;
    params.push(grupo);
    idx++;
  }
  const result = await pool.query(
    `SELECT pc.*, p.name AS plot_name, f.name AS field_name, p.area_hectares, pc.sowed_hectares,
            act.activity_count, act.last_activity_date, act.last_activity_type
     FROM plot_crops pc
     JOIN plots p ON pc.plot_id = p.id
     JOIN fields f ON p.field_id = f.id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS activity_count,
              MAX(de.event_date) AS last_activity_date,
              (ARRAY_AGG(de.event_type ORDER BY de.event_date DESC))[1] AS last_activity_type
       FROM domain_events de
       WHERE de.plot_crop_id = pc.id
         AND de.deleted_at IS NULL
     ) act ON true
     WHERE f.id IN (${accessibleFieldsSql(1)})
       AND pc.end_date IS NULL
       AND p.deleted_at IS NULL
       AND f.deleted_at IS NULL
       ${extraConditions}
     ORDER BY f.name, p.name`,
    params
  );
  return result.rows;
}

export async function getPlotCropHistory(plotId) {
  const result = await pool.query(
    `SELECT * FROM plot_crops WHERE plot_id = $1 ORDER BY season_year DESC, created_at DESC`,
    [plotId]
  );
  return result.rows;
}

export async function getPlotCropBySeason(plotId, seasonYear, crop) {
  const result = await pool.query(
    `SELECT * FROM plot_crops WHERE plot_id = $1 AND season_year = $2 AND LOWER(crop) = LOWER($3) LIMIT 1`,
    [plotId, seasonYear, crop]
  );
  return result.rows[0] || null;
}

export async function setPlotCropHarvested(cropId, harvestedAt, yieldKg = null, yieldNotes = null) {
  const result = await pool.query(
    `UPDATE plot_crops SET harvested_at = COALESCE($2, CURRENT_DATE), yield_kg = $3, yield_notes = $4
     WHERE id = $1 RETURNING *`,
    [cropId, harvestedAt, yieldKg, yieldNotes]
  );
  return result.rows[0] || null;
}

/** Update yield_kg + yield_notes only — used for retroactive yield-load on a
 * harvested campaign (active or closed). Does NOT touch dates. */
export async function updatePlotCropYield(cropId, yieldKg, yieldNotes = null) {
  const result = await pool.query(
    `UPDATE plot_crops
       SET yield_kg = $2,
           yield_notes = COALESCE($3, yield_notes)
     WHERE id = $1 RETURNING *`,
    [cropId, yieldKg, yieldNotes]
  );
  return result.rows[0] || null;
}

export async function getCampaignExpenses(plotId, startDate, endDate = null) {
  const result = await pool.query(
    `SELECT * FROM expenses WHERE plot_id = $1 AND deleted_at IS NULL
     AND expense_date >= $2 AND ($3::date IS NULL OR expense_date <= $3)
     ORDER BY expense_date`,
    [plotId, startDate, endDate]
  );
  return result.rows;
}

export async function getCampaignIncomes(plotId, startDate, endDate = null) {
  const result = await pool.query(
    `SELECT * FROM incomes WHERE plot_id = $1 AND deleted_at IS NULL
     AND income_date >= $2 AND ($3::date IS NULL OR income_date <= $3)
     ORDER BY income_date`,
    [plotId, startDate, endDate]
  );
  return result.rows;
}

export async function getCampaignActivities(plotCropId) {
  const result = await pool.query(
    `SELECT * FROM domain_events WHERE plot_crop_id = $1 AND deleted_at IS NULL ORDER BY event_date`,
    [plotCropId]
  );
  return result.rows;
}

// --- Crop scouting (structured monitoring) ---

/**
 * Persist a structured scouting record. All metric fields are optional;
 * caller passes whatever the user reported.
 */
export async function saveCropScouting(userId, data) {
  const result = await pool.query(
    `INSERT INTO crop_scoutings (
      user_id, field_id, plot_id, plot_crop_id, scouting_date,
      stage_code, weed_coverage_pct, weed_species,
      pest_species, pest_severity_1_5, pest_affected_pct,
      soil_moisture_1_5, emergence_pct, plant_density_m2,
      notes, source
    )
    VALUES (
      $1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE),
      $6, $7, $8,
      $9, $10, $11,
      $12, $13, $14,
      $15, COALESCE($16, 'text')
    )
    RETURNING *`,
    [
      userId,
      data.fieldId ?? null,
      data.plotId,
      data.plotCropId ?? null,
      data.scoutingDate ?? null,
      data.stageCode ?? null,
      data.weedCoveragePct ?? null,
      data.weedSpecies && data.weedSpecies.length ? data.weedSpecies : null,
      data.pestSpecies ?? null,
      data.pestSeverity ?? null,
      data.pestAffectedPct ?? null,
      data.soilMoisture ?? null,
      data.emergencePct ?? null,
      data.plantDensityM2 ?? null,
      data.notes ?? null,
      data.source ?? null,
    ]
  );
  return result.rows[0];
}

export async function getScoutingsForPlotCampaign(plotCropId) {
  const result = await pool.query(
    `SELECT * FROM crop_scoutings WHERE plot_crop_id = $1 AND deleted_at IS NULL ORDER BY scouting_date DESC, id DESC`,
    [plotCropId]
  );
  return result.rows;
}

export async function getScoutingsForPlotInRange(plotId, dateFrom, dateTo) {
  const result = await pool.query(
    `SELECT * FROM crop_scoutings
     WHERE plot_id = $1
       AND scouting_date BETWEEN $2 AND $3
       AND deleted_at IS NULL
     ORDER BY scouting_date DESC, id DESC`,
    [plotId, dateFrom, dateTo]
  );
  return result.rows;
}

/**
 * Unified scouting query. Same architecture as queryMovements:
 * one SQL builder + many filters; the handler dispatches the rendering.
 *
 * Supports:
 *  - scope: plotId, fieldId
 *  - period: dateFrom, dateTo
 *  - structured filters: stageCode (exact), stagePrefix (LIKE 'V%'),
 *    weedSpeciesAny[] (overlaps), pestSpecies (ILIKE), weedMinPct/weedMaxPct,
 *    emergenceMinPct/emergenceMaxPct, densityMin/densityMax, soilMoistureMin/Max,
 *    pestSeverityMin, hasPest (sev≥2 OR species present), hasWeeds (coverage>0)
 *  - sort + direction + limit
 *
 * IMPORTANT: returns raw rows. Aggregation/max/min/avg happens in the renderer
 * so we can compose them flexibly.
 */
export async function queryScoutings(opts = {}) {
  const {
    userId, plotId = null, fieldId = null,
    dateFrom = null, dateTo = null,
    minSeverity = null,           // legacy param name
    pestSeverityMin = null,
    stageCode = null, stagePrefix = null,
    weedSpeciesAny = null, pestSpecies = null,
    weedMinPct = null, weedMaxPct = null,
    emergenceMinPct = null, emergenceMaxPct = null,
    densityMin = null, densityMax = null,
    soilMoistureMin = null, soilMoistureMax = null,
    hasPest = null, hasWeeds = null,
    sortBy = 'date', sortDesc = true,
    limit = 50,
  } = opts;

  const conditions = ['s.user_id = $1', 's.deleted_at IS NULL'];
  const params = [userId];
  let i = 1;

  if (plotId) { i++; conditions.push(`s.plot_id = $${i}`); params.push(plotId); }
  if (fieldId && !plotId) {
    i++;
    conditions.push(`(s.field_id = $${i} OR s.plot_id IN (SELECT id FROM plots WHERE field_id = $${i}))`);
    params.push(fieldId);
  }
  if (dateFrom) { i++; conditions.push(`s.scouting_date >= $${i}`); params.push(dateFrom); }
  if (dateTo) { i++; conditions.push(`s.scouting_date <= $${i}`); params.push(dateTo); }

  // Pest filters
  const effectiveSeverityMin = pestSeverityMin ?? minSeverity;
  if (effectiveSeverityMin != null) { i++; conditions.push(`s.pest_severity_1_5 >= $${i}`); params.push(effectiveSeverityMin); }
  if (pestSpecies) { i++; conditions.push(`LOWER(s.pest_species) LIKE LOWER($${i})`); params.push(`%${pestSpecies}%`); }
  if (hasPest === true) { conditions.push(`(s.pest_species IS NOT NULL OR s.pest_severity_1_5 >= 2)`); }
  if (hasPest === false) { conditions.push(`(s.pest_species IS NULL AND (s.pest_severity_1_5 IS NULL OR s.pest_severity_1_5 < 2))`); }

  // Weed filters
  if (Array.isArray(weedSpeciesAny) && weedSpeciesAny.length > 0) {
    // any-overlap with the text[] column, case-insensitive
    const placeholders = weedSpeciesAny.map(w => { i++; params.push(w.toLowerCase()); return `$${i}`; });
    conditions.push(`EXISTS (SELECT 1 FROM unnest(s.weed_species) AS w WHERE LOWER(w) = ANY(ARRAY[${placeholders.join(',')}]::text[]))`);
  }
  if (weedMinPct != null) { i++; conditions.push(`s.weed_coverage_pct >= $${i}`); params.push(weedMinPct); }
  if (weedMaxPct != null) { i++; conditions.push(`s.weed_coverage_pct <= $${i}`); params.push(weedMaxPct); }
  if (hasWeeds === true) { conditions.push(`(s.weed_coverage_pct > 0 OR (s.weed_species IS NOT NULL AND array_length(s.weed_species,1) > 0))`); }
  if (hasWeeds === false) { conditions.push(`(COALESCE(s.weed_coverage_pct,0) = 0 AND (s.weed_species IS NULL OR array_length(s.weed_species,1) IS NULL))`); }

  // Emergence / density
  if (emergenceMinPct != null) { i++; conditions.push(`s.emergence_pct >= $${i}`); params.push(emergenceMinPct); }
  if (emergenceMaxPct != null) { i++; conditions.push(`s.emergence_pct <= $${i}`); params.push(emergenceMaxPct); }
  if (densityMin != null) { i++; conditions.push(`s.plant_density_m2 >= $${i}`); params.push(densityMin); }
  if (densityMax != null) { i++; conditions.push(`s.plant_density_m2 <= $${i}`); params.push(densityMax); }

  // Soil moisture
  if (soilMoistureMin != null) { i++; conditions.push(`s.soil_moisture_1_5 >= $${i}`); params.push(soilMoistureMin); }
  if (soilMoistureMax != null) { i++; conditions.push(`s.soil_moisture_1_5 <= $${i}`); params.push(soilMoistureMax); }

  // Stage
  if (stageCode) { i++; conditions.push(`s.stage_code = $${i}`); params.push(stageCode.toUpperCase()); }
  if (stagePrefix && !stageCode) { i++; conditions.push(`s.stage_code LIKE $${i}`); params.push(`${stagePrefix.toUpperCase()}%`); }

  // Sort
  const sortColumn = sortBy === 'weed_coverage_pct' ? 's.weed_coverage_pct'
    : sortBy === 'pest_severity' ? 's.pest_severity_1_5'
    : sortBy === 'emergence_pct' ? 's.emergence_pct'
    : sortBy === 'plant_density_m2' ? 's.plant_density_m2'
    : sortBy === 'soil_moisture' ? 's.soil_moisture_1_5'
    : 's.scouting_date';
  const direction = sortDesc ? 'DESC' : 'ASC';

  i++; const limitParam = `$${i}`;
  params.push(Math.min(Math.max(limit, 1), 100));

  const result = await pool.query(
    `SELECT s.*, p.name AS plot_name, f.name AS field_name, pc.crop AS crop
     FROM crop_scoutings s
     LEFT JOIN plots p ON p.id = s.plot_id
     LEFT JOIN fields f ON f.id = s.field_id
     LEFT JOIN plot_crops pc ON pc.id = s.plot_crop_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY ${sortColumn} ${direction} NULLS LAST, s.id DESC
     LIMIT ${limitParam}`,
    params
  );
  return result.rows;
}

export async function getCampaignObservations(plotId, startDate, endDate = null) {
  const result = await pool.query(
    `SELECT * FROM agro_observations WHERE plot_id = $1
     AND observation_date >= $2 AND ($3::date IS NULL OR observation_date <= $3)
     ORDER BY observation_date`,
    [plotId, startDate, endDate]
  );
  return result.rows;
}

// --- Domain events ---

export async function saveDomainEvent(userId, data) {
  const result = await pool.query(
    `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop, product, product_type, quantity, unit, implement, notes, pregnant_count, open_count, uncertain_count, corral_id, animal_category, animals_affected)
     VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *`,
    [userId, data.plotId || null, data.plotCropId || null, data.eventType, data.eventDate || null,
     data.crop || null, data.product || null, data.productType || null,
     data.quantity || null, data.unit || null, data.implement || null, data.notes || null,
     data.pregnantCount ?? null, data.openCount ?? null, data.uncertainCount ?? null,
     data.corralId || null, data.animalCategory || null, data.animalsAffected ?? null]
  );
  return result.rows[0];
}

/**
 * Query livestock-related domain events (health_event, repro_event, weighing).
 * Returns rows with plot_name, field_name, corral info joined.
 */
export async function queryLivestockEvents(userId, eventType, { fieldId = null, plotId = null, corralId = null, category = null, subtype = null, desde = null, hasta = null, limit = 30 } = {}) {
  const conditions = ['de.user_id = $1', 'de.event_type = $2', 'de.deleted_at IS NULL'];
  const params = [userId, eventType];
  let idx = 3;

  if (fieldId) { conditions.push(`p.field_id = $${idx++}`); params.push(fieldId); }
  if (plotId) { conditions.push(`de.plot_id = $${idx++}`); params.push(plotId); }
  if (corralId) { conditions.push(`de.corral_id = $${idx++}`); params.push(corralId); }
  if (category) { conditions.push(`de.animal_category = $${idx++}`); params.push(category); }
  if (subtype) { conditions.push(`de.product_type = $${idx++}`); params.push(subtype); }
  if (desde) { conditions.push(`de.event_date >= $${idx++}::date`); params.push(desde); }
  if (hasta) { conditions.push(`de.event_date <= $${idx++}::date`); params.push(hasta); }

  const result = await pool.query(
    `SELECT de.*, p.name as plot_name, f.name as field_name,
            c.name as corral_name, fl.name as feedlot_name
     FROM domain_events de
     LEFT JOIN plots p ON de.plot_id = p.id
     LEFT JOIN fields f ON p.field_id = f.id
     LEFT JOIN corrals c ON de.corral_id = c.id
     LEFT JOIN feedlots fl ON c.feedlot_id = fl.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY de.event_date DESC, de.created_at DESC
     LIMIT $${idx}`,
    [...params, limit]
  );
  return result.rows;
}

/**
 * Update avg_weight_kg on a matching livestock_group.
 * Matches by userId + category + (plotId or corralId).
 */
export async function updateLivestockGroupWeight(userId, { category, plotId = null, corralId = null, avgWeightKg }) {
  const conditions = ['user_id = $1', 'category = $2', 'deleted_at IS NULL'];
  const params = [userId, category];
  let idx = 3;

  if (corralId) {
    conditions.push(`corral_id = $${idx++}`);
    params.push(corralId);
  } else if (plotId) {
    conditions.push(`plot_id = $${idx++}`);
    params.push(plotId);
  } else {
    return null; // Need at least one location
  }

  params.push(avgWeightKg);
  const result = await pool.query(
    `UPDATE livestock_groups SET avg_weight_kg = $${idx++}, updated_at = NOW()
     WHERE ${conditions.join(' AND ')}
     RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

export async function getDomainEventsByPlot(plotId, limit = 20) {
  const result = await pool.query(
    `SELECT de.*, p.name as plot_name, f.name as field_name
     FROM domain_events de
     LEFT JOIN plots p ON de.plot_id = p.id
     LEFT JOIN fields f ON p.field_id = f.id
     WHERE de.plot_id = $1
       AND de.deleted_at IS NULL
     ORDER BY de.event_date DESC, de.created_at DESC
     LIMIT $2`,
    [plotId, limit]
  );
  return result.rows;
}

export async function getDomainEventsByUser(userId, limit = 20) {
  const result = await pool.query(
    `SELECT de.*, p.name as plot_name, f.name as field_name
     FROM domain_events de
     LEFT JOIN plots p ON de.plot_id = p.id
     LEFT JOIN fields f ON p.field_id = f.id
     WHERE de.user_id = $1
       AND de.deleted_at IS NULL
     ORDER BY de.event_date DESC, de.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

export async function getDomainEventsByFieldDateRange(fieldId, desde, hasta) {
  const result = await pool.query(
    `SELECT de.*, p.name as plot_name, f.name as field_name
     FROM domain_events de
     LEFT JOIN plots p ON de.plot_id = p.id
     LEFT JOIN fields f ON p.field_id = f.id
     WHERE p.field_id = $1
       AND de.event_date >= $2::date
       AND de.event_date <= $3::date
       AND de.deleted_at IS NULL
     ORDER BY de.event_date DESC, de.created_at DESC`,
    [fieldId, desde, hasta]
  );
  return result.rows;
}

export async function getDomainEventsByPlotDateRange(plotId, desde, hasta) {
  const result = await pool.query(
    `SELECT de.*, p.name as plot_name, f.name as field_name
     FROM domain_events de
     LEFT JOIN plots p ON de.plot_id = p.id
     LEFT JOIN fields f ON p.field_id = f.id
     WHERE de.plot_id = $1
       AND de.event_date >= $2::date
       AND de.event_date <= $3::date
       AND de.deleted_at IS NULL
     ORDER BY de.event_date DESC, de.created_at DESC`,
    [plotId, desde, hasta]
  );
  return result.rows;
}

export async function getLastDomainEvent(userId) {
  const result = await pool.query(
    `SELECT de.*, p.name as plot_name, f.name as field_name
     FROM domain_events de
     LEFT JOIN plots p ON de.plot_id = p.id
     LEFT JOIN fields f ON p.field_id = f.id
     WHERE de.user_id = $1
       AND de.deleted_at IS NULL
     ORDER BY de.created_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function findLastDomainEventFiltered(userId, filters = {}) {
  const conditions = ['de.user_id = $1', 'de.deleted_at IS NULL'];
  const params = [userId];
  let idx = 1;

  if (filters.eventType) {
    idx++;
    conditions.push(`de.event_type = $${idx}`);
    params.push(filters.eventType);
  }
  if (filters.crop) {
    idx++;
    conditions.push(`de.crop ILIKE $${idx}`);
    params.push(`%${filters.crop}%`);
  }
  // Narrow by the plot the user named ("la cosecha del lote 3") so corrections
  // and deletes hit the referenced record instead of blindly the most recent.
  if (filters.plotId) {
    idx++;
    conditions.push(`de.plot_id = $${idx}`);
    params.push(filters.plotId);
  }

  const result = await pool.query(
    `SELECT de.*, p.name as plot_name, f.name as field_name, p.field_id
     FROM domain_events de
     LEFT JOIN plots p ON de.plot_id = p.id
     LEFT JOIN fields f ON p.field_id = f.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY de.created_at DESC
     LIMIT 1`,
    params
  );
  return result.rows[0] || null;
}

export async function updateDomainEventPlot(eventId, plotId, editedBy, extraFields = {}) {
  const sets = ['updated_at = NOW()', 'edited_by = $1'];
  const params = [editedBy];
  let idx = 1;

  if (plotId != null) { idx++; sets.push(`plot_id = $${idx}`); params.push(plotId); }
  if (extraFields.crop !== undefined) { idx++; sets.push(`crop = $${idx}`); params.push(extraFields.crop); }
  if (extraFields.eventDate !== undefined) { idx++; sets.push(`event_date = $${idx}`); params.push(extraFields.eventDate); }
  if (extraFields.eventType !== undefined) { idx++; sets.push(`event_type = $${idx}`); params.push(extraFields.eventType); }
  if (extraFields.quantity !== undefined) { idx++; sets.push(`quantity = $${idx}`); params.push(extraFields.quantity); }
  if (extraFields.unit !== undefined) { idx++; sets.push(`unit = $${idx}`); params.push(extraFields.unit); }

  idx++;
  const result = await pool.query(
    `UPDATE domain_events SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    [...params, eventId]
  );
  return result.rows[0] || null;
}

/**
 * Keep plot_crops in sync when a planting event's crop or plot is corrected via
 * edit_last_activity. Without this, "la siembra de soja era trigo" updated the
 * domain_event but left plot_crops (the active campaign / "cultivo activo")
 * showing soja — an inconsistency the user sees immediately.
 */
export async function syncPlotCropFromEdit(plotCropId, { crop = null, plotId = null, sowedHectares = null } = {}) {
  if (!plotCropId) return null;
  const sets = [];
  const params = [];
  let idx = 0;
  if (crop != null) { idx++; sets.push(`crop = $${idx}`); params.push(crop); }
  if (plotId != null) { idx++; sets.push(`plot_id = $${idx}`); params.push(plotId); }
  if (sowedHectares != null) { idx++; sets.push(`sowed_hectares = $${idx}`); params.push(sowedHectares); }
  if (sets.length === 0) return null;
  idx++;
  const result = await pool.query(
    `UPDATE plot_crops SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    [...params, plotCropId]
  );
  return result.rows[0] || null;
}

/**
 * Soft-delete a domain_event and keep dependent state consistent.
 *
 * Previously this hard-deleted the row, which (a) violated the harvest_loads FK
 * for cosechas with cargas → 500, and (b) left plot_crops out of sync (a deleted
 * siembra still showed as "cultivo activo", a deleted cosecha left the campaign
 * marked harvested). Now we run a single transaction that:
 *   - harvest  → removes its harvest_loads and re-opens the plot_crop
 *                (harvested_at / yield_kg / yield_notes / end_date cleared) so
 *                the campaign returns to "activa".
 *   - planting → deletes the plot_crop it created (only if not yet harvested),
 *                freeing the unique-active slot so the lote can be re-sown.
 *   - any type → sets deleted_at so it disappears from every query.
 * The cleanup is keyed off the event itself, so it generalises to any future
 * event type that links to dependent rows.
 */
export async function deleteDomainEvent(eventId) {
  return withTransaction(async () => {
    const { rows } = await pool.query(
      `SELECT * FROM domain_events WHERE id = $1 AND deleted_at IS NULL`,
      [eventId]
    );
    const event = rows[0];
    if (!event) return null;

    if (event.event_type === 'harvest') {
      // Cargas son datos hoja de la cosecha → se borran con ella.
      await pool.query(`DELETE FROM harvest_loads WHERE domain_event_id = $1`, [eventId]);
      if (event.plot_crop_id) {
        await pool.query(
          `UPDATE plot_crops
              SET harvested_at = NULL, yield_kg = NULL, yield_notes = NULL,
                  end_date = NULL
            WHERE id = $1`,
          [event.plot_crop_id]
        );
      }
    } else if (event.event_type === 'planting' && event.plot_crop_id) {
      // Una siembra borrada libera el lote SOLO si todavía no se cosechó; si ya
      // hay cosecha encima, dejamos la campaña intacta y solo borramos el evento.
      await pool.query(
        `DELETE FROM plot_crops WHERE id = $1 AND harvested_at IS NULL`,
        [event.plot_crop_id]
      );
    }

    const result = await pool.query(
      `UPDATE domain_events SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
      [eventId]
    );
    return result.rows[0] || null;
  });
}

// --- Audio transcription logs ---

export async function saveAudioTranscriptionLog(userId, { durationSeconds, provider, model, costUsd }) {
  await pool.query(
    `INSERT INTO audio_transcription_logs (user_id, audio_duration_seconds, provider, model, cost_usd)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, durationSeconds, provider, model, costUsd]
  );
}

export async function getHourlyAudioCount(userId) {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM audio_transcription_logs
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId]
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}

// --- Unparsed messages ---

export async function saveUnparsedMessage(userId, message) {
  await pool.query(
    `INSERT INTO unparsed_messages (user_id, message) VALUES ($1, $2)`,
    [userId, message]
  );
}

export async function getUnparsedMessages(limit = 50, offset = 0) {
  const result = await pool.query(
    `SELECT um.id, um.message, um.created_at, u.name, u.phone_number
     FROM unparsed_messages um
     JOIN users u ON um.user_id = u.id
     ORDER BY um.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

export async function getParseMetrics() {
  const [unparsedWeekR, unparsedTotalR, aiWeekR] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) as count FROM unparsed_messages
       WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`
    ),
    pool.query(
      `SELECT COUNT(*) as count FROM unparsed_messages`
    ),
    pool.query(
      `SELECT COUNT(*) as count FROM ai_usage
       WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'`
    ),
  ]);

  return {
    unparsedWeek: parseInt(unparsedWeekR.rows[0].count),
    unparsedTotal: parseInt(unparsedTotalR.rows[0].count),
    claudeFallbacksWeek: parseInt(aiWeekR.rows[0].count),
  };
}

// --- Plot history query ---

/**
 * Unified rainfall query — clean SQL builder on rainfall table.
 * Same architecture as queryMovements/queryScoutings/etc.
 * Returns raw rows; aggregation happens in renderers.
 */
export async function queryRainfall(opts = {}) {
  const {
    userId, fieldId = null, plotId = null,
    desde = null, hasta = null,
    mmMin = null, mmMax = null,
    sortBy = 'date', sortDesc = true, limit = 365,
  } = opts;

  const conditions = [
    `r.user_id = $1`,
    `(f.user_id = $1 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $1))`,
  ];
  const params = [userId];
  let idx = 2;

  // When querying by plot, ALSO include field-level rainfalls (plot_id IS NULL)
  // because rainfall is often registered at the field level — a "lluvia en lote A1"
  // query should surface lluvias del campo La Esperanza even if no plot was tagged.
  if (plotId && fieldId) {
    conditions.push(`(r.plot_id = $${idx} OR (r.plot_id IS NULL AND r.field_id = $${idx + 1}))`);
    params.push(plotId);
    params.push(fieldId);
    idx += 2;
  } else if (plotId) {
    conditions.push(`r.plot_id = $${idx}`); params.push(plotId); idx++;
  } else if (fieldId) {
    conditions.push(`r.field_id = $${idx}`); params.push(fieldId); idx++;
  }

  if (desde) { conditions.push(`r.rainfall_date >= $${idx}::date`); params.push(desde); idx++; }
  if (hasta) { conditions.push(`r.rainfall_date <= $${idx}::date`); params.push(hasta); idx++; }
  if (mmMin != null) { conditions.push(`r.millimeters >= $${idx}`); params.push(mmMin); idx++; }
  if (mmMax != null) { conditions.push(`r.millimeters <= $${idx}`); params.push(mmMax); idx++; }

  const sortCol = sortBy === 'mm' ? 'r.millimeters' : 'r.rainfall_date';
  const direction = sortDesc ? 'DESC' : 'ASC';

  const limitParam = `$${idx}`;
  params.push(Math.min(Math.max(limit, 1), 1000));

  const sql = `
    SELECT r.id, r.rainfall_date AS event_date, r.millimeters AS mm,
           r.field_id, r.plot_id, f.name AS field_name, p.name AS plot_name
    FROM rainfall r
    LEFT JOIN fields f ON r.field_id = f.id
    LEFT JOIN plots p ON r.plot_id = p.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${sortCol} ${direction}, r.id DESC
    LIMIT ${limitParam}
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Unified activity query — clean SQL builder on domain_events ONLY.
 * Same architecture as queryMovements/queryScoutings/queryHarvestLoads/queryStock.
 * Returns raw rows; aggregation happens in renderers.
 *
 * Activity event_types: planting, spraying, fertilization, harvest, tillage, irrigation.
 * Filters: plot, field, crop, product (LIKE), activity_types (array), date range, qty range.
 */
export async function queryActivities(opts = {}) {
  const {
    userId, plotId = null, fieldId = null, crop = null,
    activityTypes = null, productSearch = null,
    desde = null, hasta = null,
    quantityMin = null, quantityMax = null,
    sortBy = 'date', sortDesc = true, limit = 200,
  } = opts;

  const conditions = [
    `de.user_id = $1`,
    `de.event_type IN ('planting','spraying','fertilization','harvest','tillage','irrigation')`,
    `(f.user_id = $1 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $1))`,
    `de.deleted_at IS NULL`,
  ];
  const params = [userId];
  let idx = 2;

  if (plotId) { conditions.push(`de.plot_id = $${idx}`); params.push(plotId); idx++; }
  else if (fieldId) { conditions.push(`p.field_id = $${idx}`); params.push(fieldId); idx++; }

  if (crop) {
    // Accent-insensitive crop match
    conditions.push(`TRANSLATE(LOWER(de.crop), 'áéíóúñ', 'aeioun') = TRANSLATE(LOWER($${idx}), 'áéíóúñ', 'aeioun')`);
    params.push(crop); idx++;
  }

  if (Array.isArray(activityTypes) && activityTypes.length > 0) {
    const placeholders = activityTypes.map(() => { const p = `$${idx}`; idx++; return p; });
    conditions.push(`de.event_type IN (${placeholders.join(',')})`);
    params.push(...activityTypes);
  }

  if (productSearch) {
    conditions.push(`LOWER(de.product) LIKE '%' || LOWER($${idx}) || '%'`);
    params.push(productSearch); idx++;
  }

  if (desde) { conditions.push(`de.event_date >= $${idx}::date`); params.push(desde); idx++; }
  if (hasta) { conditions.push(`de.event_date <= $${idx}::date`); params.push(hasta); idx++; }

  if (quantityMin != null) { conditions.push(`de.quantity >= $${idx}`); params.push(quantityMin); idx++; }
  if (quantityMax != null) { conditions.push(`de.quantity <= $${idx}`); params.push(quantityMax); idx++; }

  const sortCol = sortBy === 'quantity' ? 'de.quantity'
    : sortBy === 'type' ? 'de.event_type'
    : 'de.event_date';
  const direction = sortDesc ? 'DESC' : 'ASC';

  const limitParam = `$${idx}`;
  params.push(Math.min(Math.max(limit, 1), 500));

  const sql = `
    SELECT de.id, de.event_type, de.event_date, de.crop, de.product, de.product_type,
           de.quantity, de.unit, de.implement, de.notes, de.plot_id,
           p.name AS plot_name, f.name AS field_name, f.id AS field_id
    FROM domain_events de
    LEFT JOIN plots p ON de.plot_id = p.id
    LEFT JOIN fields f ON p.field_id = f.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${sortCol} ${direction} NULLS LAST, de.id DESC
    LIMIT ${limitParam}
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function queryPlotHistory(userId, { plotId = null, fieldId = null, desde = null, hasta = null, activityFilter = null, crop = null, limit = 20 } = {}) {
  const params = [userId];
  let idx = 2;

  // Build shared conditions
  let locationFilter = '';
  if (plotId) {
    locationFilter = `AND de.plot_id = $${idx}`;
    params.push(plotId);
    idx++;
  } else if (fieldId) {
    locationFilter = `AND p.field_id = $${idx}`;
    params.push(fieldId);
    idx++;
  }

  let dateFilter = '';
  const desdeIdx = idx;
  if (desde && hasta) {
    dateFilter = `AND event_date BETWEEN $${idx} AND $${idx + 1}`;
    params.push(desde, hasta);
    idx += 2;
  }

  let actFilter = '';
  if (activityFilter && activityFilter !== 'observation' && activityFilter !== 'rainfall') {
    actFilter = `AND de.event_type = $${idx}`;
    params.push(activityFilter);
    idx++;
  }

  // Build observation location filter using same param refs
  let obsLocationFilter = '';
  if (plotId) {
    obsLocationFilter = `AND o.plot_id = $${plotId === params[1] ? 2 : 2}`;
  } else if (fieldId) {
    obsLocationFilter = `AND COALESCE(p2.field_id, o.field_id) = $${fieldId === params[1] ? 2 : 2}`;
  }

  // Build rainfall location filter
  let rainLocationFilter = '';
  if (fieldId) {
    rainLocationFilter = `AND r.field_id = $${fieldId === params[1] ? 2 : 2}`;
  }

  // Rebuild with clean positional params to avoid confusion
  // Determine which subqueries will run FIRST, then build params accordingly
  const skipDe = (activityFilter === 'observation' || activityFilter === 'rainfall');
  const skipObs = (activityFilter && activityFilter !== 'observation');
  const skipRain = (activityFilter && activityFilter !== 'rainfall');

  const qParams = [userId];
  let qIdx = 2;

  // Location param — only push if at least one active subquery will reference it
  // Note: rainfall only filters by fieldId (not plotId), so plotId-only + rain-only = no loc usage
  const deNeedsLoc = !skipDe && (plotId || fieldId);
  const obsNeedsLoc = !skipObs && (plotId || fieldId);
  const rainNeedsLoc = !skipRain && fieldId;
  const anyNeedsLoc = deNeedsLoc || obsNeedsLoc || rainNeedsLoc;

  let locParamRef = null;
  if (anyNeedsLoc && (plotId || fieldId)) {
    qParams.push(plotId || fieldId);
    locParamRef = `$${qIdx}`;
    qIdx++;
  }

  // Date params
  let dateParamRefs = null;
  if (desde && hasta) {
    qParams.push(desde, hasta);
    dateParamRefs = { desde: `$${qIdx}`, hasta: `$${qIdx + 1}` };
    qIdx += 2;
  }

  // Activity param — only push if domain_events subquery is active and needs event_type filter
  const needsActParam = !skipDe && activityFilter && activityFilter !== 'observation' && activityFilter !== 'rainfall';
  let actParamRef = null;
  if (needsActParam) {
    qParams.push(activityFilter);
    actParamRef = `$${qIdx}`;
    qIdx++;
  }

  // Crop param — filter domain_events by crop name (case-insensitive)
  let cropParamRef = null;
  if (!skipDe && crop) {
    qParams.push(crop.toLowerCase());
    cropParamRef = `$${qIdx}`;
    qIdx++;
  }

  // Domain events subquery filters
  const deLoc = locParamRef ? (plotId ? `AND de.plot_id = ${locParamRef}` : `AND p.field_id = ${locParamRef}`) : '';
  const deDate = dateParamRefs ? `AND de.event_date BETWEEN ${dateParamRefs.desde} AND ${dateParamRefs.hasta}` : '';
  const deAct = actParamRef ? `AND de.event_type = ${actParamRef}` : '';
  const deCrop = cropParamRef ? `AND LOWER(de.crop) = ${cropParamRef}` : '';

  // Observations subquery filters
  const obsLoc = locParamRef ? (plotId ? `AND o.plot_id = ${locParamRef}` : `AND COALESCE(p2.field_id, o.field_id) = ${locParamRef}`) : '';
  const obsDate = dateParamRefs ? `AND o.created_at::date BETWEEN ${dateParamRefs.desde} AND ${dateParamRefs.hasta}` : '';

  // Rainfall subquery filters (rainfall only filters by fieldId, not plotId)
  const rainLoc = (locParamRef && fieldId) ? `AND r.field_id = ${locParamRef}` : '';
  const rainDate = dateParamRefs ? `AND r.rainfall_date BETWEEN ${dateParamRefs.desde} AND ${dateParamRefs.hasta}` : '';

  const parts = [];

  if (!skipDe) {
    parts.push(`
      SELECT 'activity' as source, de.id, de.event_type as type, de.event_date as date,
             de.product as detail, de.quantity, de.unit, de.crop, de.plot_id,
             p.name as plot_name, f.name as field_name
      FROM domain_events de
      LEFT JOIN plots p ON de.plot_id = p.id
      LEFT JOIN fields f ON p.field_id = f.id
      WHERE de.user_id = $1 AND de.deleted_at IS NULL ${deLoc} ${deDate} ${deAct} ${deCrop}
    `);
  }

  if (!skipObs) {
    parts.push(`
      SELECT 'observation' as source, o.id, o.category as type, o.created_at::date as date,
             o.observation_text as detail, NULL::numeric as quantity, NULL::text as unit, NULL::text as crop, o.plot_id,
             p2.name as plot_name, f2.name as field_name
      FROM agro_observations o
      LEFT JOIN plots p2 ON o.plot_id = p2.id
      LEFT JOIN fields f2 ON COALESCE(p2.field_id, o.field_id) = f2.id
      WHERE o.user_id = $1 ${obsLoc} ${obsDate}
    `);
  }

  if (!skipRain) {
    parts.push(`
      SELECT 'rainfall' as source, r.id, 'rainfall' as type, r.rainfall_date as date,
             r.millimeters::text as detail, r.millimeters as quantity, 'mm'::text as unit, NULL::text as crop, NULL::integer as plot_id,
             NULL::text as plot_name, f3.name as field_name
      FROM rainfall r
      LEFT JOIN fields f3 ON r.field_id = f3.id AND f3.deleted_at IS NULL
      WHERE r.user_id = $1 ${rainLoc} ${rainDate}
    `);
  }

  if (parts.length === 0) {
    return [];
  }

  // Priority: activities (0) > rainfall (1) > observations (2), then by date DESC
  // Wrap in subquery so we can reference the 'source' alias in ORDER BY
  const inner = parts.join('\nUNION ALL\n');
  const sql = `SELECT * FROM (${inner}) AS h ORDER BY CASE h.source WHEN 'activity' THEN 0 WHEN 'rainfall' THEN 1 ELSE 2 END, h.date DESC LIMIT ${parseInt(limit)}`;
  const result = await pool.query(sql, qParams);
  return result.rows;
}

export async function getTactoSummary(userId, { fieldId = null, plotId = null, corralId = null, desde = null, hasta = null } = {}) {
  const params = [userId];
  let idx = 2;
  const conditions = [`de.user_id = $1`, `de.event_type = 'tacto'`, `de.deleted_at IS NULL`];

  if (corralId) {
    conditions.push(`de.corral_id = $${idx}`);
    params.push(corralId);
    idx++;
  } else if (plotId) {
    conditions.push(`de.plot_id = $${idx}`);
    params.push(plotId);
    idx++;
  } else if (fieldId) {
    conditions.push(`(p.field_id = $${idx} OR fl.field_id = $${idx})`);
    params.push(fieldId);
    idx++;
  }

  if (desde) {
    conditions.push(`de.event_date >= $${idx}`);
    params.push(desde);
    idx++;
  }
  if (hasta) {
    conditions.push(`de.event_date <= $${idx}`);
    params.push(hasta);
    idx++;
  }

  const sql = `
    SELECT
      de.plot_id,
      p.name as plot_name,
      f.name as field_name,
      de.corral_id,
      c.name as corral_name,
      fl.name as feedlot_name,
      de.event_date,
      de.product as category,
      SUM(COALESCE(de.pregnant_count, 0)) as total_pregnant,
      SUM(COALESCE(de.open_count, 0)) as total_open,
      SUM(COALESCE(de.uncertain_count, 0)) as total_uncertain,
      SUM(COALESCE(de.quantity, 0)) as total_checked,
      COUNT(*) as record_count
    FROM domain_events de
    LEFT JOIN plots p ON de.plot_id = p.id
    LEFT JOIN fields f ON p.field_id = f.id
    LEFT JOIN corrals c ON de.corral_id = c.id
    LEFT JOIN feedlots fl ON c.feedlot_id = fl.id
    WHERE ${conditions.join(' AND ')}
    GROUP BY de.plot_id, p.name, f.name, de.corral_id, c.name, fl.name, de.event_date, de.product
    ORDER BY de.event_date DESC
  `;

  const result = await pool.query(sql, params);
  return result.rows;
}

// --- Activity stats (aggregated counts by type) ---

export async function getActivityStats(userId, { fieldId = null, plotId = null, activityFilter = null, desde = null, hasta = null, grupo = null } = {}) {
  const params = [userId];
  let idx = 2;
  const conditions = [`de.user_id = $1`, `de.event_type != 'tacto'`, `de.deleted_at IS NULL`];

  if (activityFilter) {
    conditions.push(`de.event_type = $${idx}`);
    params.push(activityFilter);
    idx++;
  }
  if (plotId) {
    conditions.push(`de.plot_id = $${idx}`);
    params.push(plotId);
    idx++;
  } else if (fieldId) {
    conditions.push(`p.field_id = $${idx}`);
    params.push(fieldId);
    idx++;
  }
  if (grupo) {
    conditions.push(`LOWER(p.grupo) LIKE '%' || LOWER($${idx}) || '%'`);
    params.push(grupo);
    idx++;
  }
  if (desde) {
    conditions.push(`de.event_date >= $${idx}`);
    params.push(desde);
    idx++;
  }
  if (hasta) {
    conditions.push(`de.event_date <= $${idx}`);
    params.push(hasta);
    idx++;
  }

  const sql = `
    SELECT
      de.event_type,
      COUNT(*)::int as count,
      MIN(de.event_date) as earliest,
      MAX(de.event_date) as latest,
      p.name as plot_name,
      f.name as field_name
    FROM domain_events de
    LEFT JOIN plots p ON de.plot_id = p.id
    LEFT JOIN fields f ON p.field_id = f.id
    JOIN field_members fm ON f.id = fm.field_id AND fm.user_id = $1
    WHERE ${conditions.join(' AND ')}
    GROUP BY de.event_type, p.name, f.name
    ORDER BY count DESC
  `;

  const result = await pool.query(sql, params);
  return result.rows;
}

// --- Harvest loads ---

export async function saveHarvestLoads(domainEventId, plotCropId, loads) {
  if (!loads || loads.length === 0) return [];
  const values = [];
  const params = [];
  let idx = 1;
  for (const load of loads) {
    values.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6}, $${idx+7}, $${idx+8})`);
    params.push(
      domainEventId,
      plotCropId || null,
      load.driver_name,
      load.weight_kg,
      load.destination || null,
      load.destinatario || null,
      load.truck_plate || null,
      load.humidity_pct ?? null,
      load.quality_metrics ? JSON.stringify(load.quality_metrics) : null,
    );
    idx += 9;
  }
  const sql = `INSERT INTO harvest_loads (domain_event_id, plot_crop_id, driver_name, weight_kg, destination, destinatario, truck_plate, humidity_pct, quality_metrics)
    VALUES ${values.join(', ')} RETURNING *`;
  const result = await pool.query(sql, params);
  return result.rows;
}

export async function getHarvestLoads(domainEventId) {
  const result = await pool.query(
    `SELECT * FROM harvest_loads WHERE domain_event_id = $1 ORDER BY id`,
    [domainEventId]
  );
  return result.rows;
}

export async function findTodayHarvestEvent(userId, plotId) {
  const result = await pool.query(
    `SELECT * FROM domain_events
     WHERE user_id = $1 AND plot_id = $2 AND event_type = 'harvest'
       AND event_date = CURRENT_DATE
       AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId, plotId]
  );
  return result.rows[0] || null;
}

// All plots cosechados today by this user (one row per plot, with the
// most recent harvest's crop). Used to disambiguate per-truck loads when
// the user fired "Pedro 30tn" without a plot.
export async function findHarvestsToday(userId) {
  const result = await pool.query(
    `SELECT DISTINCT ON (de.plot_id)
            de.plot_id,
            p.name AS plot_name,
            f.name AS field_name,
            de.crop
     FROM domain_events de
     JOIN plots p ON p.id = de.plot_id
     JOIN fields f ON f.id = p.field_id
     WHERE de.user_id = $1
       AND de.event_type = 'harvest'
       AND de.event_date = CURRENT_DATE
       AND de.deleted_at IS NULL
       AND p.deleted_at IS NULL
       AND f.deleted_at IS NULL
     ORDER BY de.plot_id, de.created_at DESC`,
    [userId]
  );
  return result.rows;
}

export async function updateYieldFromLoads(plotCropId) {
  if (!plotCropId) return;
  await pool.query(
    `UPDATE plot_crops SET yield_kg = (
       SELECT COALESCE(SUM(weight_kg), 0) FROM harvest_loads WHERE plot_crop_id = $1
     ) WHERE id = $1`,
    [plotCropId]
  );
}

/**
 * Unified harvest-loads query. Same architecture as queryMovements and queryScoutings.
 * Returns raw rows; aggregation/max/min/avg happens in the renderer for flexibility.
 *
 * Filters: plot, field, crop, date range, exact date, driver (LIKE), destinatario (LIKE),
 *   truck_plate (LIKE), weight range (kg), humidity range, protein/oil/gluten ranges (jsonb quality).
 * Sort: date | weight | humidity | protein | oil | gluten.
 */
export async function queryHarvestLoads(userId, opts = {}) {
  const {
    plotId = null, fieldId = null, crop = null, eventDate = null,
    desde = null, hasta = null,
    driverName = null, destinatario = null, truckPlate = null,
    weightMinKg = null, weightMaxKg = null,
    humidityMinPct = null, humidityMaxPct = null,
    proteinMinPct = null, proteinMaxPct = null,
    oilMinPct = null, oilMaxPct = null,
    glutenMinPct = null, glutenMaxPct = null,
    sortBy = 'date', sortDesc = true, limit = 200,
  } = opts;
  const params = [userId];
  let idx = 2;
  const conditions = [`de.user_id = $1`, `de.event_type = 'harvest'`, `de.deleted_at IS NULL`];

  if (plotId) { conditions.push(`de.plot_id = $${idx}`); params.push(plotId); idx++; }
  else if (fieldId) { conditions.push(`p.field_id = $${idx}`); params.push(fieldId); idx++; }

  if (crop) {
    // Accent-insensitive match: "maíz" must match "maiz" (and vice versa).
    // We use unaccent-via-translate on both sides since pg's unaccent extension may not be available.
    conditions.push(`TRANSLATE(LOWER(de.crop), 'áéíóúñ', 'aeioun') = TRANSLATE(LOWER($${idx}), 'áéíóúñ', 'aeioun')`);
    params.push(crop);
    idx++;
  }
  if (eventDate) { conditions.push(`de.event_date = $${idx}::date`); params.push(eventDate); idx++; }
  if (desde) { conditions.push(`de.event_date >= $${idx}::date`); params.push(desde); idx++; }
  if (hasta) { conditions.push(`de.event_date <= $${idx}::date`); params.push(hasta); idx++; }

  // Accent-insensitive substring match on driver/destinatario (Pedro Gomez ≈ Pedro Gómez).
  const unaccent = (col) => `TRANSLATE(LOWER(${col}), 'áéíóúñ', 'aeioun')`;
  if (driverName) {
    conditions.push(`${unaccent('hl.driver_name')} LIKE '%' || ${unaccent(`$${idx}`)} || '%'`);
    params.push(driverName); idx++;
  }
  if (destinatario) {
    conditions.push(`${unaccent('hl.destinatario')} LIKE '%' || ${unaccent(`$${idx}`)} || '%'`);
    params.push(destinatario); idx++;
  }
  if (truckPlate) { conditions.push(`LOWER(hl.truck_plate) LIKE '%' || LOWER($${idx}) || '%'`); params.push(truckPlate); idx++; }

  if (weightMinKg != null) { conditions.push(`hl.weight_kg >= $${idx}`); params.push(weightMinKg); idx++; }
  if (weightMaxKg != null) { conditions.push(`hl.weight_kg <= $${idx}`); params.push(weightMaxKg); idx++; }

  if (humidityMinPct != null) { conditions.push(`hl.humidity_pct >= $${idx}`); params.push(humidityMinPct); idx++; }
  if (humidityMaxPct != null) { conditions.push(`hl.humidity_pct <= $${idx}`); params.push(humidityMaxPct); idx++; }

  // Quality metrics are stored in JSONB. Use ->>'key' to extract as text then cast to numeric.
  if (proteinMinPct != null) { conditions.push(`(hl.quality_metrics->>'protein_pct')::numeric >= $${idx}`); params.push(proteinMinPct); idx++; }
  if (proteinMaxPct != null) { conditions.push(`(hl.quality_metrics->>'protein_pct')::numeric <= $${idx}`); params.push(proteinMaxPct); idx++; }
  if (oilMinPct != null) { conditions.push(`(hl.quality_metrics->>'oil_pct')::numeric >= $${idx}`); params.push(oilMinPct); idx++; }
  if (oilMaxPct != null) { conditions.push(`(hl.quality_metrics->>'oil_pct')::numeric <= $${idx}`); params.push(oilMaxPct); idx++; }
  if (glutenMinPct != null) { conditions.push(`(hl.quality_metrics->>'gluten_pct')::numeric >= $${idx}`); params.push(glutenMinPct); idx++; }
  if (glutenMaxPct != null) { conditions.push(`(hl.quality_metrics->>'gluten_pct')::numeric <= $${idx}`); params.push(glutenMaxPct); idx++; }

  const sortCol = sortBy === 'weight' ? 'hl.weight_kg'
    : sortBy === 'humidity' ? 'hl.humidity_pct'
    : sortBy === 'protein' ? `(hl.quality_metrics->>'protein_pct')::numeric`
    : sortBy === 'oil' ? `(hl.quality_metrics->>'oil_pct')::numeric`
    : sortBy === 'gluten' ? `(hl.quality_metrics->>'gluten_pct')::numeric`
    : 'de.event_date';
  const direction = sortDesc ? 'DESC' : 'ASC';

  // limitParam = next slot (idx already points to next available)
  const limitParam = `$${idx}`;
  params.push(Math.min(Math.max(limit, 1), 500));

  // Access: own field OR shared via field_members.
  const sql = `
    SELECT hl.*, de.event_date, de.crop, de.plot_id, p.name as plot_name, f.name as field_name
    FROM harvest_loads hl
    JOIN domain_events de ON hl.domain_event_id = de.id
    LEFT JOIN plots p ON de.plot_id = p.id
    LEFT JOIN fields f ON p.field_id = f.id
    WHERE ${conditions.join(' AND ')}
      AND (f.user_id = $1 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $1))
    ORDER BY ${sortCol} ${direction} NULLS LAST, hl.id DESC
    LIMIT ${limitParam}
  `;
  const result = await pool.query(sql, params);
  return result.rows;
}

export async function getHarvestLoadsByCampaign(plotCropId) {
  const result = await pool.query(
    `SELECT hl.*, de.event_date
     FROM harvest_loads hl
     JOIN domain_events de ON hl.domain_event_id = de.id
     WHERE hl.plot_crop_id = $1
       AND de.deleted_at IS NULL
     ORDER BY de.event_date, hl.id`,
    [plotCropId]
  );
  return result.rows;
}

/**
 * Delete harvest loads matching criteria. Returns deleted rows.
 * After deletion, recalculates yield_kg for affected plot_crops.
 */
export async function deleteHarvestLoads(userId, plotId, { eventDate, driverNames, onlyWithoutDestination } = {}) {
  // Build WHERE clause
  const conditions = [
    'hl.domain_event_id = de.id',
    'de.user_id = $1',
    'de.plot_id = $2',
    "de.event_type = 'harvest'",
    'de.deleted_at IS NULL',
  ];
  const params = [userId, plotId];
  let paramIdx = 3;

  if (eventDate) {
    conditions.push(`de.event_date = $${paramIdx}::date`);
    params.push(eventDate);
    paramIdx++;
  }

  if (driverNames && driverNames.length > 0) {
    conditions.push(`LOWER(hl.driver_name) = ANY($${paramIdx}::text[])`);
    params.push(driverNames.map(d => d.toLowerCase()));
    paramIdx++;
  }

  if (onlyWithoutDestination) {
    conditions.push('(hl.destination IS NULL AND hl.destinatario IS NULL)');
  }

  // Get affected plot_crop_ids before deletion
  const affectedResult = await pool.query(
    `SELECT DISTINCT hl.plot_crop_id FROM harvest_loads hl
     JOIN domain_events de ON ${conditions.join(' AND ')}`,
    params
  );
  const affectedPlotCropIds = affectedResult.rows
    .map(r => r.plot_crop_id)
    .filter(Boolean);

  // Delete matching loads
  const deleteResult = await pool.query(
    `DELETE FROM harvest_loads hl
     USING domain_events de
     WHERE ${conditions.join(' AND ')}
     RETURNING hl.*`,
    params
  );

  // Recalculate yield for affected plot_crops
  for (const pcId of affectedPlotCropIds) {
    await updateYieldFromLoads(pcId);
  }

  return deleteResult.rows;
}
