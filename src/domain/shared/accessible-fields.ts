/**
 * accessible-fields.ts — FUENTE ÚNICA del subquery "qué campos puede ver este
 * usuario".
 *
 * Por qué existe: esta función estaba copiada textualmente en
 * `livestock.repository.ts`, `feedlot.repository.ts` y `stock.repository.ts`, y
 * las TRES copias llevan el mismo comentario de cicatriz: una versión anterior
 * miraba solo `field_members` y dejaba al DUEÑO sin ver sus propios datos
 * (hacienda vacía, corrales invisibles, stock vacío). El mismo bug hubo que
 * arreglarlo tres veces porque la regla estaba en tres lados.
 *
 * Regla: todo repositorio que filtre por campo accesible usa ESTO. No copiar el
 * subquery de nuevo.
 */

/**
 * Subquery que devuelve los ids de campo accesibles: los propios (no borrados)
 * MÁS los compartidos vía `field_members`.
 *
 * `paramIdx` es la posición del `user_id` en la lista de parámetros de la query
 * que lo embebe. El mismo índice se usa dos veces a propósito — es un solo
 * parámetro.
 */
export function accessibleFieldsSql(paramIdx: number): string {
  return `SELECT id FROM fields WHERE user_id = $${paramIdx} AND deleted_at IS NULL
          UNION
          SELECT field_id FROM field_members WHERE user_id = $${paramIdx}`;
}
