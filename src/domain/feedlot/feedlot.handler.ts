import { FeedlotService } from './feedlot.service.js';
import type {
  UserId,
  User,
  UserSettings,
  ParsedCommand,
  HandlerResponse,
} from '../../types/index.js';

export class FeedlotHandler {
  private service: FeedlotService;

  constructor(service?: FeedlotService) {
    this.service = service ?? new FeedlotService();
  }

  async handleCommand(
    cmd: ParsedCommand,
    userId: UserId,
    _user: User,
    _settings: UserSettings,
  ): Promise<HandlerResponse> {
    try {
      switch (cmd.command) {
        case 'create_feedlot': return await this.createFeedlot(cmd, userId);
        case 'list_feedlots': return await this.listFeedlots(userId);
        case 'delete_feedlot': return await this.deleteFeedlot(cmd, userId);
        case 'create_corral': return await this.createCorral(cmd, userId);
        case 'list_corrals': return await this.listCorrals(cmd, userId);
        case 'delete_corral': return await this.deleteCorral(cmd, userId);
        case 'rename_corral': return await this.renameCorral(cmd, userId);
        default:
          return { messages: ['Comando de feedlot no reconocido.'] };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error en operación de feedlot';
      return { messages: [`❌ ${msg}`] };
    }
  }

  private async createFeedlot(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const fieldName = cmd.fieldName as string;
    const name = (cmd.feedlotName as string) || (cmd.warehouseName as string) || 'Feedlot';
    if (!fieldName) return { messages: ['Necesito saber en qué campo. Ej: "crear feedlot en campo Norte".'] };

    const feedlot = await this.service.createFeedlot(userId, fieldName, name, {
      capacity: cmd.capacity as number,
    });

    return {
      messages: [
        `🏗️ *Feedlot creado*\n\n` +
        `  📛 ${feedlot.name}\n` +
        `  📍 ${feedlot.field_name || fieldName}` +
        (feedlot.capacity ? `\n  📊 Capacidad: ${feedlot.capacity} animales` : '') +
        `\n\nCreá corrales con "crear corral 1".`,
      ],
    };
  }

  private async listFeedlots(userId: UserId): Promise<HandlerResponse> {
    const feedlots = await this.service.listFeedlots(userId);

    if (feedlots.length === 0) {
      return { messages: ['🏗️ No tenés feedlots. Creá uno con "crear feedlot en campo X".'] };
    }

    const lines = feedlots.map(fl => {
      const cap = fl.capacity ? ` (cap: ${fl.capacity})` : '';
      return `  🏗️ *${fl.name}*${cap} — ${fl.field_name || 'campo?'} — ${fl.corral_count} corrales`;
    });

    return {
      messages: [`🏗️ *Feedlots (${feedlots.length})*\n\n${lines.join('\n')}`],
    };
  }

  private async deleteFeedlot(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const fieldName = cmd.fieldName as string;
    if (!fieldName) return { messages: ['Decime de qué campo querés borrar el feedlot.'] };

    const feedlot = await this.service.deleteFeedlot(userId, fieldName);
    return {
      messages: [`🗑️ Feedlot "${feedlot.name}" del campo ${feedlot.field_name} eliminado.`],
    };
  }

  private async createCorral(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const corralName = (cmd.corralName as string) || (cmd.warehouseName as string);
    if (!corralName) return { messages: ['Necesito el nombre del corral. Ej: "crear corral 1".'] };

    const corral = await this.service.createCorral(userId, corralName, cmd.fieldName as string, {
      capacity: cmd.capacity as number,
    });

    return {
      messages: [
        `🔲 *Corral creado*\n\n` +
        `  📛 ${corral.name}\n` +
        `  🏗️ ${corral.feedlot_name} (${corral.field_name})` +
        (corral.capacity ? `\n  📊 Capacidad: ${corral.capacity}` : ''),
      ],
    };
  }

  private async listCorrals(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const corrals = await this.service.listCorrals(userId, cmd.fieldName as string);

    if (corrals.length === 0) {
      return { messages: ['🔲 No hay corrales. Creá uno con "crear corral 1".'] };
    }

    const lines = corrals.map(c => {
      const cap = c.capacity ? ` (cap: ${c.capacity})` : '';
      return `  🔲 *${c.name}*${cap} — ${c.feedlot_name || ''} (${c.field_name || ''})`;
    });

    return {
      messages: [`🔲 *Corrales (${corrals.length})*\n\n${lines.join('\n')}`],
    };
  }

  private async deleteCorral(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const corralName = cmd.corralName as string;
    if (!corralName) return { messages: ['Decime qué corral querés borrar.'] };

    const corral = await this.service.deleteCorral(userId, corralName, cmd.fieldName as string);
    return {
      messages: [`🗑️ Corral "${corral.name}" eliminado.`],
    };
  }

  private async renameCorral(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const oldName = (cmd.oldName as string) || (cmd.corralName as string);
    const newName = cmd.newName as string;
    if (!oldName || !newName) return { messages: ['Necesito el nombre actual y el nuevo. Ej: "renombrar corral 1 a Norte".'] };

    const corral = await this.service.renameCorral(userId, oldName, newName, cmd.fieldName as string);
    return {
      messages: [`✏️ Corral renombrado de "${oldName}" a "${corral.name}".`],
    };
  }
}
