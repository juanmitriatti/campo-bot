import type { InteractiveButton } from '../../types/index.js';

export type LvOpKind = 'add' | 'remove' | 'transfer' | 'weigh' | 'health' | 'repro';

export interface PostActionContext {
  groupId?: string;
  movementId?: string;
  eventId?: number;
  plotId?: number | null;
  corralId?: number | null;
  isSale?: boolean;
}

export function buildPostActionButtons(op: LvOpKind, ctx: PostActionContext): InteractiveButton[] {
  const locTag = `${ctx.plotId ?? 'null'}_${ctx.corralId ?? 'null'}`;
  switch (op) {
    case 'add':
      return [
        { id: `lv_post_stock_${locTag}`, title: '📊 Ver stock' },
        ...(ctx.groupId ? [{ id: `lv_post_weigh_${ctx.groupId}`, title: '⚖️ Pesar grupo' }] : []),
        ...(ctx.movementId ? [{ id: `lv_post_undo_movement_${ctx.movementId}`, title: '↩️ Borrar' }] : []),
      ];
    case 'remove': {
      const buttons: InteractiveButton[] = [
        { id: `lv_post_stock_${locTag}`, title: '📊 Ver stock' },
        ...(ctx.movementId ? [{ id: `lv_post_undo_movement_${ctx.movementId}`, title: '↩️ Borrar' }] : []),
      ];
      if (ctx.isSale) buttons.push({ id: 'lv_post_resumen_mes', title: '💰 Resumen mes' });
      return buttons;
    }
    case 'transfer':
      return [
        { id: `lv_post_stock_${locTag}`, title: '📊 Stock destino' },
        ...(ctx.groupId ? [{ id: `lv_post_weigh_${ctx.groupId}`, title: '⚖️ Pesar grupo' }] : []),
        ...(ctx.movementId ? [{ id: `lv_post_undo_movement_${ctx.movementId}`, title: '↩️ Borrar' }] : []),
      ];
    case 'weigh':
      return [
        ...(ctx.groupId ? [{ id: `lv_post_gdpv_${ctx.groupId}`, title: '📈 GDPV grupo' }] : []),
        ...(ctx.groupId ? [{ id: `lv_post_health_hist_${ctx.groupId}`, title: '💉 Sanidad' }] : []),
        ...(ctx.eventId ? [{ id: `lv_post_undo_event_${ctx.eventId}`, title: '↩️ Borrar' }] : []),
      ];
    case 'health':
      return [
        ...(ctx.groupId ? [{ id: `lv_post_health_hist_${ctx.groupId}`, title: '💉 Historial sanitario' }] : []),
        ...(ctx.groupId ? [{ id: `lv_post_new_event_${ctx.groupId}_health`, title: '➕ Otro evento' }] : []),
        ...(ctx.eventId ? [{ id: `lv_post_undo_event_${ctx.eventId}`, title: '↩️ Borrar' }] : []),
      ];
    case 'repro':
      return [
        ...(ctx.groupId ? [{ id: `lv_post_repro_hist_${ctx.groupId}`, title: '🐂 Historial repro' }] : []),
        ...(ctx.groupId ? [{ id: `lv_post_new_event_${ctx.groupId}_repro`, title: '➕ Otro evento' }] : []),
        ...(ctx.eventId ? [{ id: `lv_post_undo_event_${ctx.eventId}`, title: '↩️ Borrar' }] : []),
      ];
  }
}
