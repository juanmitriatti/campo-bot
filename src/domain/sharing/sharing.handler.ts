import { FieldSharingService } from './field-sharing.service.js';
import { getFieldByName } from '../../services/expenses.js';
import type { UserId, User, UserSettings, ParsedCommand, HandlerResponse } from '../../types/index.js';

export class SharingHandler {
  private sharingService: FieldSharingService;

  constructor(sharingService?: FieldSharingService) {
    this.sharingService = sharingService ?? new FieldSharingService();
  }

  async handleCommand(
    cmd: ParsedCommand,
    userId: UserId,
    user: User,
    _settings: UserSettings
  ): Promise<HandlerResponse | null> {
    switch (cmd.command) {
      case 'share_field':
        return this.handleShareField(cmd, userId);

      case 'accept_invite':
        return this.handleAcceptInvite(cmd, userId);

      case 'list_field_members':
        return this.handleListMembers(cmd, userId);

      case 'remove_field_member':
        return this.handleRemoveMember(cmd, userId);

      default:
        return null;
    }
  }

  private async handleShareField(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const fieldName = cmd.fieldName as string;

    if (!fieldName) {
      return { messages: ['Para compartir un campo necesito el nombre del campo.\nEj: "compartir campo Norte"'] };
    }

    const field = await getFieldByName(userId, fieldName);
    if (!field) {
      return { messages: [`No encontré el campo *${fieldName}*.\nEscribí *mis campos* para ver los que tenés.`] };
    }

    const result = await this.sharingService.createInvite(userId, field.id);
    if (!result.success) {
      return { messages: [result.message] };
    }

    return {
      messages: [
        `🔗 *Código de invitación para ${field.name}:*\n\n` +
        `\`${result.code}\`\n\n` +
        `Compartí este código con quien quieras darle acceso. ` +
        `La otra persona debe escribir:\n*unirme ${result.code}*\n\n` +
        `⏳ El código vence en 7 días.`
      ],
    };
  }

  private async handleAcceptInvite(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const code = cmd.code as string;

    if (!code) {
      return { messages: ['Necesito el código de invitación.\nEj: "unirme ABC123"'] };
    }

    const result = await this.sharingService.acceptInvite(userId, code);
    if (!result.success) {
      return { messages: [result.message] };
    }

    return {
      messages: [
        `🤝 ${result.message}\nPodés registrar gastos, ingresos, actividades y ver reportes de este campo.`
      ],
    };
  }

  private async handleListMembers(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const fieldName = cmd.fieldName as string;

    if (!fieldName) {
      return { messages: ['Indicá el nombre del campo.\nEj: "miembros campo Norte"'] };
    }

    const field = await getFieldByName(userId, fieldName);
    if (!field) {
      return { messages: [`No encontré el campo *${fieldName}*.`] };
    }

    const members = await this.sharingService.listMembers(userId, field.id);
    if (members.length === 0) {
      return { messages: [`No tenés acceso al campo *${field.name}*.`] };
    }

    let msg = `👥 *Miembros de ${field.name}:*\n`;
    for (const m of members) {
      const name = m.user_name || m.phone_number;
      const role = m.role === 'owner' ? '👑 Dueño' : '👤 Miembro';
      msg += `\n${role}: ${name}`;
      if (m.role === 'member') {
        const date = new Date(m.created_at).toLocaleDateString('es-AR');
        msg += ` (desde ${date})`;
      }
    }

    return { messages: [msg] };
  }

  private async handleRemoveMember(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const fieldName = cmd.fieldName as string;
    const identifier = (cmd.memberName || cmd.phone) as string;

    if (!fieldName || !identifier) {
      return { messages: ['Para quitar un miembro necesito el nombre del campo y el nombre o teléfono del miembro.\nEj: "quitar a Juan de campo Norte"'] };
    }

    const field = await getFieldByName(userId, fieldName);
    if (!field) {
      return { messages: [`No encontré el campo *${fieldName}*.`] };
    }

    const result = await this.sharingService.removeMemberByIdentifier(userId, field.id, identifier);
    return { messages: [result.message] };
  }
}
