/**
 * accessible-fields.ts — FUENTE ÚNICA del subquery "qué campos puede ver este
 * usuario" y del predicado "esta fila le corresponde".
 *
 * Por qué existe: esta función estaba copiada textualmente en
 * `livestock.repository.ts`, `feedlot.repository.ts` y `stock.repository.ts`, y
 * las TRES copias llevan el mismo comentario de cicatriz: una versión anterior
 * miraba solo `field_members` y dejaba al DUEÑO sin ver sus propios datos
 * (hacienda vacía, corrales invisibles, stock vacío). El mismo bug hubo que
 * arreglarlo tres veces porque la regla estaba en tres lados.
 *
 * La cicatriz volvió a aparecer igual: al revisar campos compartidos (Sep 2026)
 * la regla estaba escrita de TRES formas distintas en ~20 archivos —
 * `accessibleFieldsSql()`, el inline `(x.user_id = $1 OR x.field_id IN (...))`,
 * y la variante SOLO-`field_members` (sin la pata del dueño) en
 * `overview.service.ts`, `data-analysis-context.service.ts`,
 * `entity-validator.ts` y `stock.service.ts`. Dentro de un MISMO archivo
 * divergían: `entity-validator.getUserPlotNames` usaba la unión y
 * `validatePlot` solo `field_members`.
 *
 * Regla: todo repositorio que filtre por campo accesible usa ESTO. No copiar el
 * subquery de nuevo.
 */

/**
 * Subquery que devuelve los ids de campo accesibles: los propios MÁS los
 * compartidos vía `field_members`.
 *
 * `paramIdx` es la posición del `user_id` en la lista de parámetros de la query
 * que lo embebe. El mismo índice se usa dos veces a propósito — es un solo
 * parámetro.
 *
 * Las dos patas filtran `deleted_at`. Antes solo lo hacía la del dueño, así que
 * un miembro seguía viendo un campo que el dueño ya había borrado salvo que la
 * query de afuera volviera a filtrar (algunas lo hacían, otras no).
 */
export function accessibleFieldsSql(paramIdx: number): string {
  return `SELECT f.id FROM fields f
           WHERE f.user_id = $${paramIdx} AND f.deleted_at IS NULL
          UNION
          SELECT fm.field_id FROM field_members fm
            JOIN fields f2 ON f2.id = fm.field_id
           WHERE fm.user_id = $${paramIdx} AND f2.deleted_at IS NULL`;
}

/**
 * Predicado de FILA para una tabla que ubica sus registros por `field_id` y/o
 * `plot_id` (expenses, incomes, agro_observations, crop_scoutings, rainfall…).
 * NO sirve para `domain_events`, que no tiene `field_id`: para esa tabla va
 * `accessibleEventSql`.
 *
 * Dos patas, y las dos hacen falta:
 *
 *   1. El campo de la fila —directo o a través del lote— es accesible. ESTA es
 *      la que faltaba en el Resumen: `getOverview` filtraba los eventos con
 *      `d.user_id = $1` a secas, así que en un campo compartido cada socio veía
 *      solo lo que había cargado él y toda la parte agronómica del otro era
 *      invisible.
 *
 *   2. La fila es del propio usuario. Se conserva a propósito como red de
 *      seguridad: el bot guarda muchísimas filas con `field_id` NULL (solo
 *      `plot_id`, o ninguno de los dos), y también quedan filas colgando de un
 *      campo borrado. Sin esta pata, arreglar el scoping ESCONDERÍA datos
 *      propios que hoy se ven — que es peor que el bug que estamos arreglando.
 *
 * `alias` es el alias de la tabla en la query (`e`, `i`, `d`…).
 */
/**
 * Predicado de FILA para `domain_events`, que se ubica por `plot_id` o
 * `corral_id` y NO tiene `field_id`. Usar `accessibleRowSql` acá rompía la
 * query ("column de.field_id does not exist"): la pestaña Actividades del
 * dashboard devolvía 500 para todos (auditoría oct 2026). Mismas dos patas
 * que `accessibleRowSql` y que el `eventScope` del Resumen.
 */
export function accessibleEventSql(alias: string, paramIdx: number): string {
  return `(
    COALESCE(
      (SELECT p_acc.field_id FROM plots p_acc WHERE p_acc.id = ${alias}.plot_id),
      (SELECT fl_acc.field_id FROM corrals c_acc JOIN feedlots fl_acc ON fl_acc.id = c_acc.feedlot_id
        WHERE c_acc.id = ${alias}.corral_id)
    ) IN (${accessibleFieldsSql(paramIdx)})
    OR ${alias}.user_id = $${paramIdx}
  )`;
}

export function accessibleRowSql(alias: string, paramIdx: number): string {
  return `(
    COALESCE(${alias}.field_id, (SELECT p_acc.field_id FROM plots p_acc WHERE p_acc.id = ${alias}.plot_id))
      IN (${accessibleFieldsSql(paramIdx)})
    OR ${alias}.user_id = $${paramIdx}
  )`;
}
