import { FeedlotRepository } from './feedlot.repository.js';
import type { FeedlotRow, CorralRow } from './feedlot.types.js';
import { getFieldByName, getUserFields } from '../../services/expenses.js';
import type { UserId } from '../../types/index.js';

export interface ResolvedCorralRef {
  fieldId: number;
  fieldName: string;
  feedlotId: number;
  feedlotName: string;
  corralId: number;
  corralName: string;
}

export class FeedlotService {
  private repo: FeedlotRepository;

  constructor(repo?: FeedlotRepository) {
    this.repo = repo ?? new FeedlotRepository();
  }

  // ========================
  // FEEDLOTS
  // ========================

  async createFeedlot(
    userId: UserId,
    fieldName: string,
    feedlotName: string,
    opts: { capacity?: number | null; notes?: string | null } = {}
  ): Promise<FeedlotRow> {
    if (!fieldName) throw new Error('Necesito saber en qué campo crear el feedlot.');

    const field = await getFieldByName(userId, fieldName);
    if (!field) throw new Error(`No encontré el campo "${fieldName}".`);

    const existing = await this.repo.getFeedlotByFieldId(field.id);
    if (existing) throw new Error(`El campo "${fieldName}" ya tiene un feedlot: "${existing.name}".`);

    const feedlot = await this.repo.createFeedlot(Number(userId), field.id, feedlotName, opts);
    feedlot.field_name = field.name;
    return feedlot;
  }

  async listFeedlots(userId: UserId): Promise<(FeedlotRow & { corral_count: number })[]> {
    return this.repo.listFeedlots(Number(userId));
  }

  async deleteFeedlot(userId: UserId, fieldName: string): Promise<FeedlotRow> {
    if (!fieldName) throw new Error('Decime de qué campo querés borrar el feedlot.');

    const field = await getFieldByName(userId, fieldName);
    if (!field) throw new Error(`No encontré el campo "${fieldName}".`);

    const feedlot = await this.repo.getFeedlotByFieldId(field.id);
    if (!feedlot) throw new Error(`El campo "${fieldName}" no tiene feedlot.`);

    await this.repo.deleteFeedlot(feedlot.id);
    feedlot.field_name = field.name;
    return feedlot;
  }

  // ========================
  // CORRALS
  // ========================

  async createCorral(
    userId: UserId,
    corralName: string,
    fieldName?: string | null,
    opts: { capacity?: number | null; notes?: string | null } = {}
  ): Promise<CorralRow & { field_name: string; feedlot_name: string }> {
    if (!corralName) throw new Error('Necesito el nombre del corral.');

    const feedlot = await this.resolveFeedlot(userId, fieldName);

    // Check for duplicate name
    const existing = await this.repo.getCorralByName(feedlot.id, corralName);
    if (existing) throw new Error(`Ya existe un corral "${corralName}" en el feedlot "${feedlot.name}".`);

    const corral = await this.repo.createCorral(feedlot.id, corralName, opts);
    return {
      ...corral,
      feedlot_name: feedlot.name,
      field_name: feedlot.field_name || '',
      field_id: feedlot.field_id,
    };
  }

  async listCorrals(userId: UserId, fieldName?: string | null): Promise<CorralRow[]> {
    if (fieldName) {
      const field = await getFieldByName(userId, fieldName);
      if (!field) throw new Error(`No encontré el campo "${fieldName}".`);
      const feedlot = await this.repo.getFeedlotByFieldId(field.id);
      if (!feedlot) throw new Error(`El campo "${fieldName}" no tiene feedlot.`);
      return this.repo.listCorrals(feedlot.id);
    }
    return this.repo.listCorralsByUser(Number(userId));
  }

  async deleteCorral(userId: UserId, corralName: string, fieldName?: string | null): Promise<CorralRow> {
    const ref = await this.resolveCorral(userId, corralName, fieldName);
    const corral = await this.repo.getCorralById(ref.corralId);
    if (!corral) throw new Error(`No encontré el corral "${corralName}".`);
    await this.repo.deleteCorral(ref.corralId);
    return corral;
  }

  async renameCorral(
    userId: UserId,
    oldName: string,
    newName: string,
    fieldName?: string | null
  ): Promise<CorralRow> {
    if (!oldName || !newName) throw new Error('Necesito el nombre actual y el nuevo nombre del corral.');
    const ref = await this.resolveCorral(userId, oldName, fieldName);
    await this.repo.updateCorral(ref.corralId, { name: newName });
    const updated = await this.repo.getCorralById(ref.corralId);
    return updated!;
  }

  // ========================
  // RESOLUTION
  // ========================

  /**
   * Resolve a feedlot for the user. If fieldName is given, find that field's feedlot.
   * If not given and user has exactly 1 feedlot, auto-resolve.
   */
  async resolveFeedlot(userId: UserId, fieldName?: string | null): Promise<FeedlotRow> {
    if (fieldName) {
      const field = await getFieldByName(userId, fieldName);
      if (!field) throw new Error(`No encontré el campo "${fieldName}".`);
      const feedlot = await this.repo.getFeedlotByFieldId(field.id);
      if (!feedlot) throw new Error(`El campo "${fieldName}" no tiene feedlot. Creá uno con "crear feedlot en ${fieldName}".`);
      feedlot.field_name = field.name;
      return feedlot;
    }

    const feedlots = await this.repo.listFeedlots(Number(userId));
    if (feedlots.length === 0) throw new Error('No tenés feedlots. Creá uno con "crear feedlot en campo X".');
    if (feedlots.length === 1) return feedlots[0];
    const names = feedlots.map(fl => `${fl.name} (${fl.field_name})`).join(', ');
    throw new Error(`Tenés varios feedlots: ${names}. Decime en qué campo.`);
  }

  /**
   * Resolve a corral by name across user's feedlots.
   * If fieldName given, restricts to that field's feedlot.
   */
  async resolveCorral(
    userId: UserId,
    corralName: string,
    fieldName?: string | null
  ): Promise<ResolvedCorralRef> {
    if (!corralName) throw new Error('Necesito el nombre del corral.');

    if (fieldName) {
      const feedlot = await this.resolveFeedlot(userId, fieldName);
      const corral = await this.repo.getCorralByName(feedlot.id, corralName);
      if (!corral) throw new Error(`No encontré el corral "${corralName}" en el feedlot "${feedlot.name}".`);
      return {
        fieldId: feedlot.field_id,
        fieldName: feedlot.field_name || '',
        feedlotId: feedlot.id,
        feedlotName: feedlot.name,
        corralId: corral.id,
        corralName: corral.name,
      };
    }

    // Search across all user feedlots
    const allCorrals = await this.repo.listCorralsByUser(Number(userId));
    const matches = allCorrals.filter(c => c.name.toLowerCase() === corralName.toLowerCase());

    if (matches.length === 0) throw new Error(`No encontré el corral "${corralName}".`);
    if (matches.length === 1) {
      const c = matches[0];
      return {
        fieldId: c.field_id!,
        fieldName: c.field_name || '',
        feedlotId: c.feedlot_id,
        feedlotName: c.feedlot_name || '',
        corralId: c.id,
        corralName: c.name,
      };
    }

    // Ambiguous — multiple corrals with same name in different feedlots
    const options = matches.map(c => `${c.name} en ${c.field_name}`).join(', ');
    throw new Error(`Hay varios corrales "${corralName}": ${options}. Decime en qué campo.`);
  }
}
