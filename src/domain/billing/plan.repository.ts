import { pool } from '../../config/db.js';
import type { UserId, PlanRow, FeatureRow, FeatureKey, PlanName } from '../../types/index.js';

export class PlanRepository {
  async getAllPlans(): Promise<PlanRow[]> {
    const { rows } = await pool.query(
      `SELECT * FROM plans WHERE is_active = true ORDER BY price_ars ASC`
    );
    return rows.map((r: PlanRow) => ({ ...r, price_ars: Number(r.price_ars) }));
  }

  async getPlanByName(name: PlanName): Promise<PlanRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM plans WHERE name = $1`,
      [name]
    );
    if (rows.length === 0) return null;
    return { ...rows[0], price_ars: Number(rows[0].price_ars) };
  }

  async getPlanById(planId: number): Promise<PlanRow | null> {
    const { rows } = await pool.query(
      `SELECT * FROM plans WHERE id = $1`,
      [planId]
    );
    if (rows.length === 0) return null;
    return { ...rows[0], price_ars: Number(rows[0].price_ars) };
  }

  async getUserPlan(userId: UserId): Promise<PlanRow | null> {
    const { rows } = await pool.query(
      `SELECT p.* FROM plans p
       JOIN users u ON u.plan_id = p.id
       WHERE u.id = $1`,
      [userId]
    );
    if (rows.length === 0) return null;
    return { ...rows[0], price_ars: Number(rows[0].price_ars) };
  }

  async setUserPlan(userId: UserId, planId: number): Promise<void> {
    await pool.query(
      `UPDATE users SET plan_id = $1 WHERE id = $2`,
      [planId, userId]
    );
  }

  async getPlanFeatures(planId: number): Promise<FeatureKey[]> {
    const { rows } = await pool.query(
      `SELECT f.key FROM features f
       JOIN plan_features pf ON pf.feature_id = f.id
       WHERE pf.plan_id = $1`,
      [planId]
    );
    return rows.map((r: { key: FeatureKey }) => r.key);
  }

  async getAllFeatures(): Promise<FeatureRow[]> {
    const { rows } = await pool.query(`SELECT * FROM features ORDER BY key`);
    return rows;
  }

  async setPlanFeatures(planId: number, featureKeys: FeatureKey[]): Promise<void> {
    // Replace all features for this plan
    await pool.query(`DELETE FROM plan_features WHERE plan_id = $1`, [planId]);
    if (featureKeys.length === 0) return;

    const values = featureKeys.map((_, i) => `($1, (SELECT id FROM features WHERE key = $${i + 2}))`).join(', ');
    await pool.query(
      `INSERT INTO plan_features (plan_id, feature_id) VALUES ${values} ON CONFLICT DO NOTHING`,
      [planId, ...featureKeys]
    );
  }

  async createPlan(name: PlanName, displayName: string, priceArs: number): Promise<PlanRow> {
    const { rows } = await pool.query(
      `INSERT INTO plans (name, display_name, price_ars) VALUES ($1, $2, $3) RETURNING *`,
      [name, displayName, priceArs]
    );
    return { ...rows[0], price_ars: Number(rows[0].price_ars) };
  }

  async getUserPlanAiLimit(userId: UserId): Promise<number | null> {
    const { rows } = await pool.query(
      `SELECT p.daily_ai_limit FROM plans p
       JOIN users u ON u.plan_id = p.id
       WHERE u.id = $1`,
      [userId]
    );
    if (rows.length === 0 || rows[0].daily_ai_limit == null) return null;
    return Number(rows[0].daily_ai_limit);
  }

  async updatePlan(planId: number, updates: { display_name?: string; price_ars?: number; is_active?: boolean }): Promise<PlanRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (updates.display_name !== undefined) {
      sets.push(`display_name = $${idx++}`);
      values.push(updates.display_name);
    }
    if (updates.price_ars !== undefined) {
      sets.push(`price_ars = $${idx++}`);
      values.push(updates.price_ars);
    }
    if (updates.is_active !== undefined) {
      sets.push(`is_active = $${idx++}`);
      values.push(updates.is_active);
    }

    if (sets.length === 0) return this.getPlanById(planId);

    values.push(planId);
    const { rows } = await pool.query(
      `UPDATE plans SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (rows.length === 0) return null;
    return { ...rows[0], price_ars: Number(rows[0].price_ars) };
  }
}
