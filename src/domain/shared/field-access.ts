/**
 * field-access.ts — guards de acceso a un campo para las rutas del dashboard.
 *
 * Por qué existe: el chequeo de acceso del dashboard estaba en TRES estados a
 * la vez. La mayoría de las rutas de escritura filtraban `user_id = $1` a secas
 * (un miembro de un campo compartido no podía tocar nada), tres casos de
 * hacienda usaban `FieldSharingService.isFieldAccessible` —que mira SOLO
 * `field_members`, y el dueño aparece ahí únicamente porque `getOrCreateField`
 * le inserta la fila `owner`, o sea que depende de un efecto colateral— y el
 * resto no chequeaba nada porque el `WHERE user_id` alcanzaba.
 *
 * Acá la pregunta se contesta una sola vez, contra `accessibleFieldsSql()`, que
 * cubre al dueño por `fields.user_id` Y por membresía.
 */

import { pool } from '../../config/db.js';
import { accessibleFieldsSql } from './accessible-fields.js';

export class FieldAccessError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'FieldAccessError';
  }
}

/**
 * Fila `owner` de un campo recién creado. ÚNICO lugar que la escribe.
 *
 * Vivía copiada dentro de `getOrCreateField` (expenses.js) mientras
 * `FieldSharingService.ensureOwnerMembership` existía sin llamadores. Que la
 * membresía del dueño se cree como efecto colateral de crear un campo es
 * justamente por lo que varias queries que miraban SOLO `field_members` (y
 * dejaban al dueño afuera) parecían funcionar.
 *
 * Vive acá, y no en `FieldSharingService`, para que `expenses.js` la pueda
 * importar sin arrastrar `PlanRepository` y armar un ciclo.
 */
export async function ensureOwnerMembership(userId: number, fieldId: number): Promise<void> {
  await pool.query(
    `INSERT INTO field_members (field_id, user_id, role, invited_by)
     VALUES ($1, $2, 'owner', $2)
     ON CONFLICT (field_id, user_id) DO NOTHING`,
    [fieldId, userId],
  );
}

/** ¿Este usuario puede VER/escribir en este campo? (dueño o miembro) */
export async function canAccessField(userId: number, fieldId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM (${accessibleFieldsSql(1)}) AS acc(id) WHERE acc.id = $2 LIMIT 1`,
    [userId, fieldId],
  );
  return rows.length > 0;
}

/** ¿Es el DUEÑO? Solo el dueño borra, renombra y comparte. */
export async function isFieldOwner(userId: number, fieldId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1
       FROM fields f
      WHERE f.id = $2
        AND f.deleted_at IS NULL
        AND (
          f.user_id = $1
          OR EXISTS (
            SELECT 1 FROM field_members fm
             WHERE fm.field_id = f.id AND fm.user_id = $1 AND fm.role = 'owner'
          )
        )
      LIMIT 1`,
    [userId, fieldId],
  );
  return rows.length > 0;
}

/**
 * 404 y no 403 cuando el campo no es accesible: contestar "no tenés permiso"
 * confirma que el campo existe y de quién es. Para quien no tiene acceso, el
 * campo simplemente no existe.
 */
export async function assertFieldAccess(userId: number, fieldId: number): Promise<void> {
  if (!(await canAccessField(userId, fieldId))) {
    throw new FieldAccessError(404, 'FIELD_NOT_FOUND', 'Campo no encontrado');
  }
}

/**
 * Para operaciones destructivas o de administración. Si el usuario ni siquiera
 * ve el campo devuelve 404; si lo ve pero no es el dueño, 403 con el motivo —
 * ahí sí puede saber que existe, porque ya tiene acceso.
 */
export async function assertFieldOwner(userId: number, fieldId: number): Promise<void> {
  if (!(await canAccessField(userId, fieldId))) {
    throw new FieldAccessError(404, 'FIELD_NOT_FOUND', 'Campo no encontrado');
  }
  if (!(await isFieldOwner(userId, fieldId))) {
    throw new FieldAccessError(403, 'NOT_FIELD_OWNER', 'Solo el dueño del campo puede hacer esto.');
  }
}

/** Ids de ubicación que llegan de afuera: un botón, un payload, un body REST. */
export interface LocationIds {
  fieldId?: number | string | null;
  plotId?: number | string | null;
  corralId?: number | string | null;
  groupId?: string | null;
  warehouseId?: number | string | null;
}

const LOCATION_CHECKS: Array<{ key: keyof LocationIds; what: string; sql: (acc: string) => string }> = [
  { key: 'fieldId', what: 'campo', sql: (acc) => `SELECT 1 FROM fields f WHERE f.id = $1 AND f.deleted_at IS NULL AND f.id IN (${acc})` },
  { key: 'plotId', what: 'lote', sql: (acc) => `SELECT 1 FROM plots p WHERE p.id = $1 AND p.deleted_at IS NULL AND p.field_id IN (${acc})` },
  {
    key: 'corralId', what: 'corral', sql: (acc) =>
      `SELECT 1 FROM corrals c JOIN feedlots fl ON fl.id = c.feedlot_id
        WHERE c.id = $1 AND c.deleted_at IS NULL AND fl.deleted_at IS NULL AND fl.field_id IN (${acc})`,
  },
  {
    key: 'groupId', what: 'grupo', sql: (acc) =>
      `SELECT 1 FROM livestock_groups lg
         LEFT JOIN plots p ON p.id = lg.plot_id
         LEFT JOIN corrals c ON c.id = lg.corral_id
         LEFT JOIN feedlots fl ON fl.id = c.feedlot_id
        WHERE lg.id = $1 AND lg.deleted_at IS NULL
          AND (lg.user_id = $2 OR COALESCE(lg.field_id, p.field_id, fl.field_id) IN (${acc}))`,
  },
  { key: 'warehouseId', what: 'galpón', sql: (acc) => `SELECT 1 FROM warehouses w WHERE w.id = $1 AND w.deleted_at IS NULL AND w.field_id IN (${acc})` },
];

/**
 * Devuelve qué id NO es accesible para el usuario ('campo', 'lote', 'corral',
 * 'grupo', 'galpón') o `null` si todos lo son. Los ids ausentes no se chequean.
 *
 * Todo id que llega de afuera (un botón, un payload de botón, un body del
 * dashboard) pasa por acá ANTES de escribir: un botón armado a mano guardaba un
 * gasto, un evento de hacienda o stock en el campo de otro usuario
 * (auditoría oct 2026, AIS-1..4 y AIS-12). Un id que no es número válido cuenta
 * como inaccesible, nunca llega a la query. El llamador loguea y decide qué
 * contestar — para el usuario ese lugar no existe.
 */
export async function findInaccessibleLocation(userId: number, loc: LocationIds): Promise<string | null> {
  const acc = accessibleFieldsSql(2);
  for (const c of LOCATION_CHECKS) {
    const id = loc[c.key];
    if (id == null || id === '') continue;
    if (c.key !== 'groupId' && !/^\d+$/.test(String(id))) return c.what;
    const { rows } = await pool.query(c.sql(acc), [id, userId]);
    if (rows.length === 0) return c.what;
  }
  return null;
}
