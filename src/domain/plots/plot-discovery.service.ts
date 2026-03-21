import {
  getOrCreateField,
  getOrCreatePlot,
  findPlotByNameAcrossFields,
  getFieldByName,
  findPlotByAlias,
  addPlotAlias,
  getConversationState,
  updateConversationState,
  getUserSingleField,
  getPlotById,
} from '../../services/expenses.js';
import { detectarLote, detectarCampo, normalizeText } from '../../utils/parser.js';
import type { UserId, PlotDiscoveryResult } from '../../types/index.js';

const DEFAULT_FIELD_NAME = 'General';

export class PlotDiscoveryService {

  async resolve(userId: UserId, text: string, claudeField?: string | null): Promise<PlotDiscoveryResult> {
    const campoName = detectarCampo(text) || claudeField || null;
    const loteName = detectarLote(text);

    return this.resolveFromNames(userId, campoName, loteName);
  }

  async resolveFromNames(userId: UserId, campoName: string | null, plotName: string | null): Promise<PlotDiscoveryResult> {
    // Case: pronoun reference → conversation state
    if (plotName === '__last__') {
      return this._resolveFromConversationState(userId);
    }

    // Case: Both campo + plot specified
    if (campoName && plotName) {
      return this._resolveBoth(userId, campoName, plotName);
    }

    // Case: Only plot name
    if (plotName) {
      return this._resolvePlotOnly(userId, plotName);
    }

    // Case: Only campo name
    if (campoName) {
      const field = await getOrCreateField(userId, campoName);
      await updateConversationState(userId, field.id, null);
      return { fieldId: field.id, fieldName: field.name, plotId: null, plotName: null, autoCreated: false };
    }

    // Nothing
    return { fieldId: null, fieldName: null, plotId: null, plotName: null, autoCreated: false };
  }

  private async _resolveFromConversationState(userId: UserId): Promise<PlotDiscoveryResult> {
    const state = await getConversationState(userId);
    if (state?.last_plot_id) {
      const plot = await getPlotById(state.last_plot_id);
      if (plot) {
        return {
          fieldId: plot.field_id,
          fieldName: plot.field_name,
          plotId: plot.id,
          plotName: plot.name,
          autoCreated: false,
        };
      }
    }
    if (state?.last_field_id) {
      return {
        fieldId: state.last_field_id,
        fieldName: state.field_name,
        plotId: null,
        plotName: null,
        autoCreated: false,
      };
    }
    return { fieldId: null, fieldName: null, plotId: null, plotName: null, autoCreated: false };
  }

  private async _resolveBoth(userId: UserId, campoName: string, plotName: string): Promise<PlotDiscoveryResult> {
    const field = await getOrCreateField(userId, campoName);
    const plot = await getOrCreatePlot(field.id, plotName);
    await this._registerAliases(plot.id, plotName);
    await updateConversationState(userId, field.id, plot.id);
    return { fieldId: field.id, fieldName: field.name, plotId: plot.id, plotName: plot.name, autoCreated: false };
  }

  private async _resolvePlotOnly(userId: UserId, plotName: string): Promise<PlotDiscoveryResult> {
    // 1. Direct name match across fields
    const plots = await findPlotByNameAcrossFields(userId, plotName);
    if (plots.length === 1) {
      await this._registerAliases(plots[0].id, plotName);
      await updateConversationState(userId, plots[0].field_id, plots[0].id);
      return {
        fieldId: plots[0].field_id,
        fieldName: plots[0].field_name,
        plotId: plots[0].id,
        plotName: plots[0].name,
        autoCreated: false,
      };
    }

    // 2. Alias match
    const normalized = normalizeText(plotName);
    const aliasMatch = await findPlotByAlias(userId, normalized);
    if (aliasMatch) {
      await updateConversationState(userId, aliasMatch.field_id, aliasMatch.id);
      return {
        fieldId: aliasMatch.field_id,
        fieldName: aliasMatch.field_name,
        plotId: aliasMatch.id,
        plotName: aliasMatch.name,
        autoCreated: false,
      };
    }

    // 3. Backward compat: check if there's a field with this name
    const existingField = await getFieldByName(userId, plotName);
    if (existingField) {
      await updateConversationState(userId, existingField.id, null);
      return { fieldId: existingField.id, fieldName: existingField.name, plotId: null, plotName: null, autoCreated: false };
    }

    // 4. Auto-create: determine parent field
    const singleField = await getUserSingleField(userId);
    const parentField = singleField || await getOrCreateField(userId, DEFAULT_FIELD_NAME);

    const newPlot = await getOrCreatePlot(parentField.id, plotName);
    await this._registerAliases(newPlot.id, plotName);
    await updateConversationState(userId, parentField.id, newPlot.id);

    return {
      fieldId: parentField.id,
      fieldName: parentField.name,
      plotId: newPlot.id,
      plotName: newPlot.name,
      autoCreated: true,
    };
  }

  /**
   * Resolve a plot from text WITHOUT auto-creating anything.
   * Returns plotId only if an existing plot matches. Used for pending observation disambiguation.
   */
  async resolveExisting(userId: UserId, text: string): Promise<PlotDiscoveryResult> {
    const loteName = detectarLote(text);
    if (!loteName) {
      return { fieldId: null, fieldName: null, plotId: null, plotName: null, autoCreated: false };
    }

    // 1. Direct name match across fields
    const plots = await findPlotByNameAcrossFields(userId, loteName);
    if (plots.length === 1) {
      return {
        fieldId: plots[0].field_id,
        fieldName: plots[0].field_name,
        plotId: plots[0].id,
        plotName: plots[0].name,
        autoCreated: false,
      };
    }

    // 2. Alias match
    const normalized = normalizeText(loteName);
    const aliasMatch = await findPlotByAlias(userId, normalized);
    if (aliasMatch) {
      return {
        fieldId: aliasMatch.field_id,
        fieldName: aliasMatch.field_name,
        plotId: aliasMatch.id,
        plotName: aliasMatch.name,
        autoCreated: false,
      };
    }

    // No match — do NOT auto-create
    return { fieldId: null, fieldName: null, plotId: null, plotName: null, autoCreated: false };
  }

  private async _registerAliases(plotId: number, plotName: string): Promise<void> {
    const normalized = normalizeText(plotName);
    await addPlotAlias(plotId, normalized);

    // If numeric ("3"), also register "lote 3"
    if (/^\d+$/.test(normalized)) {
      await addPlotAlias(plotId, `lote ${normalized}`);
    }

    // If starts with "lote ", also register without prefix
    if (normalized.startsWith('lote ')) {
      await addPlotAlias(plotId, normalized.slice(5));
    }
  }
}
