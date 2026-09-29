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
