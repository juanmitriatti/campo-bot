import { pool } from "../config/db.js";

/**
 * Helper: returns a SQL subquery fragment for accessible field IDs via field_members.
 * Usage: `WHERE f.id IN (${accessibleFieldsSql(paramIdx)})` with userId as param.
 */
function accessibleFieldsSql(paramIdx) {
  return `SELECT field_id FROM field_members WHERE user_id = $${paramIdx}`;
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
      daily_weather_hour: 6,
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
            COALESCE(s.rain_alert_mm, (SELECT default_rain_alert_mm FROM global_settings WHERE id = 1), 10) AS rain_alert_mm
     FROM users u
     JOIN user_settings s ON s.user_id = u.id
     WHERE s.rain_alerts = true`
  );
  return rows;
}

// --- Monthly reports ---

export async function getMonthlyReport(userId) {
  const result = await pool.query(
    `SELECT category, SUM(amount) as total
     FROM expenses
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)}))
     AND deleted_at IS NULL
     AND date_trunc('month', expense_date) = date_trunc('month', NOW())
     GROUP BY category
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
       SELECT plot_id, COALESCE(SUM(amount), 0) as total
       FROM expenses
       WHERE deleted_at IS NULL AND plot_id IN (SELECT id FROM accessible_plots)
       AND date_trunc('month', expense_date) = date_trunc('month', NOW())
       GROUP BY plot_id
     ),
     plot_incomes AS (
       SELECT plot_id, COALESCE(SUM(amount), 0) as total
       FROM incomes
       WHERE deleted_at IS NULL AND plot_id IN (SELECT id FROM accessible_plots)
       AND date_trunc('month', income_date) = date_trunc('month', NOW())
       GROUP BY plot_id
     ),
     all_plots AS (
       SELECT plot_id FROM plot_expenses
       UNION
       SELECT plot_id FROM plot_incomes
     )
     SELECT p.name as plot_name, f.name as field_name,
            COALESCE(pe.total, 0) as expense_total,
            COALESCE(pi.total, 0) as income_total
     FROM all_plots ap
     JOIN plots p ON ap.plot_id = p.id AND p.deleted_at IS NULL
     JOIN fields f ON p.field_id = f.id AND f.deleted_at IS NULL
     LEFT JOIN plot_expenses pe ON pe.plot_id = ap.plot_id
     LEFT JOIN plot_incomes pi ON pi.plot_id = ap.plot_id
     ORDER BY COALESCE(pe.total, 0) + COALESCE(pi.total, 0) DESC`,
    [userId]
  );
  return result.rows;
}

export async function getMonthlyReportForMonth(userId, month, year) {
  const result = await pool.query(
    `SELECT category, SUM(amount) as total
     FROM expenses
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)}))
     AND deleted_at IS NULL
     AND EXTRACT(MONTH FROM expense_date) = $2
     AND EXTRACT(YEAR FROM expense_date) = $3
     GROUP BY category
     ORDER BY total DESC`,
    [userId, month + 1, year]
  );
  return result.rows;
}

// --- AI usage ---

export async function saveAiUsage(userId, usage) {
  const cost = (usage.input_tokens / 1_000_000 * 0.80) +
               (usage.output_tokens / 1_000_000 * 4);

  await pool.query(
    `INSERT INTO ai_usage (user_id, input_tokens, output_tokens, total_tokens)
     VALUES ($1, $2, $3, $4)`,
    [userId, usage.input_tokens, usage.output_tokens, usage.input_tokens + usage.output_tokens]
  );

  console.log(`COST: $${cost.toFixed(6)} USD (in:${usage.input_tokens} out:${usage.output_tokens})`);
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
  const costUsd = ((usage.input_tokens || 0) / 1_000_000 * 0.80) +
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
    (user_id, category, description, amount, currency, field_id, plot_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id`,
    [
      userId,
      data.category,
      data.description || "",
      data.amount,
      data.currency || "ARS",
      fieldId,
      plotId
    ]
  );
  return result.rows[0];
}

// --- Incomes ---

export async function saveIncome(userId, data, fieldId = null, plotId = null) {
  const result = await pool.query(
    `INSERT INTO incomes
    (user_id, category, description, amount, currency, quantity, unit, unit_price, field_id, plot_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
      plotId
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

export async function getFieldResult(userId, fieldName) {
  const incomes = await pool.query(
    `SELECT COALESCE(SUM(i.amount), 0) as total
     FROM incomes i
     JOIN fields f ON i.field_id = f.id
     WHERE f.id IN (${accessibleFieldsSql(1)}) AND i.deleted_at IS NULL
     AND LOWER(f.name) = LOWER($2)
     AND date_trunc('month', i.income_date) = date_trunc('month', NOW())`,
    [userId, fieldName]
  );
  const expenses = await pool.query(
    `SELECT COALESCE(SUM(e.amount), 0) as total
     FROM expenses e
     JOIN fields f ON e.field_id = f.id
     WHERE f.id IN (${accessibleFieldsSql(1)}) AND e.deleted_at IS NULL
     AND LOWER(f.name) = LOWER($2)
     AND date_trunc('month', e.expense_date) = date_trunc('month', NOW())`,
    [userId, fieldName]
  );
  return {
    ingresos: Number(incomes.rows[0].total),
    gastos: Number(expenses.rows[0].total)
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
    `SELECT category, SUM(amount) as total
     FROM expenses
     WHERE (user_id = $1 OR field_id IN (${accessibleFieldsSql(1)}))
     AND deleted_at IS NULL
     AND expense_date >= date_trunc('week', NOW())
     GROUP BY category
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

export async function getFieldByName(userId, fieldName) {
  // Normalize accents for matching (e.g., "El Trébol" → "el trebol")
  const normalized = fieldName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const result = await pool.query(
    `SELECT * FROM fields WHERE id IN (${accessibleFieldsSql(1)}) AND LOWER(name) = $2 AND deleted_at IS NULL`,
    [userId, normalized]
  );
  if (result.rows[0]) return result.rows[0];

  // Fuzzy fallback: strip Spanish articles (el/la/los/las) from both sides and retry
  const stripArticles = (s) => s.replace(/^(el|la|los|las)\s+/i, '').trim();
  const stripped = stripArticles(normalized);
  const fuzzy = await pool.query(
    `SELECT * FROM fields WHERE id IN (${accessibleFieldsSql(1)}) AND deleted_at IS NULL`,
    [userId]
  );
  for (const row of fuzzy.rows) {
    const rowNorm = row.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (rowNorm === normalized || stripArticles(rowNorm) === stripped) {
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
    `SELECT id, name, city, province FROM fields WHERE id IN (${accessibleFieldsSql(1)}) AND deleted_at IS NULL ORDER BY name`,
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
      `SELECT COUNT(*) as count FROM plots WHERE field_id = $1 AND deleted_at IS NULL`,
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
    observations: observationsR.rows,
  };
}

export async function getFieldReport(userId, fieldName) {
  const result = await pool.query(
    `SELECT e.category, SUM(e.amount) as total
     FROM expenses e
     JOIN fields f ON e.field_id = f.id
     WHERE f.id IN (${accessibleFieldsSql(1)})
     AND e.deleted_at IS NULL
     AND f.deleted_at IS NULL
     AND LOWER(f.name) = LOWER($2)
     AND date_trunc('month', e.expense_date) = date_trunc('month', NOW())
     GROUP BY e.category
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
      `SELECT e.category, SUM(e.amount) as total
       FROM expenses e
       WHERE e.plot_id = $1
       AND e.deleted_at IS NULL
       AND date_trunc('month', e.expense_date) = date_trunc('month', NOW())
       GROUP BY e.category ORDER BY total DESC`,
      [plot.id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(i.amount), 0) as total
       FROM incomes i
       WHERE i.plot_id = $1
       AND i.deleted_at IS NULL
       AND date_trunc('month', i.income_date) = date_trunc('month', NOW())`,
      [plot.id]
    ),
  ]);
  return {
    rows: expenseResult.rows,
    plotName: plot.name,
    fieldName: plot.field_name,
    incomeTotal: Number(incomeResult.rows[0].total),
  };
}

export async function getPlotResult(userId, plotName) {
  const plots = await findPlotByNameAcrossFields(userId, plotName);
  if (plots.length === 0) return null;
  const plot = plots[0];
  const incomes = await pool.query(
    `SELECT COALESCE(SUM(i.amount), 0) as total
     FROM incomes i
     WHERE i.plot_id = $1
     AND i.deleted_at IS NULL
     AND date_trunc('month', i.income_date) = date_trunc('month', NOW())`,
    [plot.id]
  );
  const expenses = await pool.query(
    `SELECT COALESCE(SUM(e.amount), 0) as total
     FROM expenses e
     WHERE e.plot_id = $1
     AND e.deleted_at IS NULL
     AND date_trunc('month', e.expense_date) = date_trunc('month', NOW())`,
    [plot.id]
  );
  return {
    ingresos: Number(incomes.rows[0].total),
    gastos: Number(expenses.rows[0].total),
    plotName: plot.name,
    fieldName: plot.field_name,
  };
}

// --- Plots ---

export async function getOrCreatePlot(fieldId, name) {
  const existing = await pool.query(
    `SELECT * FROM plots WHERE field_id = $1 AND LOWER(name) = LOWER($2) AND deleted_at IS NULL`,
    [fieldId, name]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await pool.query(
    `INSERT INTO plots (field_id, name) VALUES ($1, $2) RETURNING *`,
    [fieldId, name]
  );
  return result.rows[0];
}

export async function getPlotByName(fieldId, plotName) {
  const result = await pool.query(
    `SELECT * FROM plots WHERE field_id = $1 AND LOWER(name) = LOWER($2) AND deleted_at IS NULL`,
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
  const result = await pool.query(
    `SELECT p.*, f.name as field_name, f.id as field_id
     FROM plots p
     JOIN fields f ON p.field_id = f.id
     WHERE f.id IN (${accessibleFieldsSql(1)}) AND LOWER(p.name) = LOWER($2)
       AND p.deleted_at IS NULL AND f.deleted_at IS NULL`,
    [userId, plotName]
  );
  return result.rows;
}

export async function findAllUserPlots(userId) {
  const result = await pool.query(
    `SELECT p.id, p.name, p.field_id, f.name AS field_name
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
  const result = await pool.query(
    `SELECT p.*, f.name as field_name, f.id as field_id
     FROM plot_aliases pa
     JOIN plots p ON pa.plot_id = p.id
     JOIN fields f ON p.field_id = f.id
     WHERE f.id IN (${accessibleFieldsSql(1)}) AND pa.alias = $2
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
  await pool.query(
    `INSERT INTO conversation_state (user_id, last_field_id, last_plot_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       last_field_id = $2, last_plot_id = $3, updated_at = NOW()`,
    [userId, fieldId, plotId]
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

export async function saveRainfall(userId, mm, fieldId = null) {
  const existing = await pool.query(
    `SELECT id FROM rainfall
     WHERE user_id = $1 AND COALESCE(field_id, 0) = COALESCE($2, 0)
       AND rainfall_date = CURRENT_DATE`,
    [userId, fieldId]
  );
  if (existing.rows.length > 0) return RAINFALL_REJECTED_DUPLICATE;

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
    `SELECT * FROM rainfall WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (last.rows.length === 0) return null;
  await pool.query(`DELETE FROM rainfall WHERE id = $1`, [last.rows[0].id]);
  return last.rows[0];
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

export async function createPlotCrop(plotId, crop, seasonYear, seasonType, startDate = null) {
  const result = await pool.query(
    `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date)
     VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE))
     RETURNING *`,
    [plotId, crop, seasonYear, seasonType, startDate]
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

// --- Domain events ---

export async function saveDomainEvent(userId, data) {
  const result = await pool.query(
    `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop, product, product_type, quantity, unit, implement, notes)
     VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [userId, data.plotId || null, data.plotCropId || null, data.eventType, data.eventDate || null,
     data.crop || null, data.product || null, data.productType || null,
     data.quantity || null, data.unit || null, data.implement || null, data.notes || null]
  );
  return result.rows[0];
}

export async function getDomainEventsByPlot(plotId, limit = 20) {
  const result = await pool.query(
    `SELECT de.*, p.name as plot_name, f.name as field_name
     FROM domain_events de
     LEFT JOIN plots p ON de.plot_id = p.id
     LEFT JOIN fields f ON p.field_id = f.id
     WHERE de.plot_id = $1
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
     ORDER BY de.event_date DESC, de.created_at DESC
     LIMIT $2`,
    [userId, limit]
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
     ORDER BY de.created_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function deleteDomainEvent(eventId) {
  const result = await pool.query(
    `DELETE FROM domain_events WHERE id = $1 RETURNING *`,
    [eventId]
  );
  return result.rows[0] || null;
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
      WHERE de.user_id = $1 ${deLoc} ${deDate} ${deAct} ${deCrop}
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
