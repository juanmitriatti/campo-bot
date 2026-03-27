import {
  findPlotByNameAcrossFields,
  getFieldByName,
  getPlotByName,
  getPlotsByField,
  findPlotByAlias,
  addPlotAlias,
  getConversationState,
  updateConversationState,
  getPlotById,
  getUserFields,
  findAllUserPlots,
} from '../../services/expenses.js';
import { detectarLote, normalizeText } from '../../utils/parser.js';
import type { UserId, PlotDiscoveryResult } from '../../types/index.js';

export class PlotDiscoveryService {

  async resolve(userId: UserId, fieldName?: string | null, plotName?: string | null): Promise<PlotDiscoveryResult> {
    return this.resolveFromNames(userId, fieldName || null, plotName || null);
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
      const field = await getFieldByName(userId, campoName);
      if (!field) {
        return { fieldId: null, fieldName: null, plotId: null, plotName: null, autoCreated: false, notFound: { type: 'field', name: campoName } };
      }
      // Try to auto-assign plot within this field
      const fieldPlots = await getPlotsByField(field.id);
      if (fieldPlots.length === 1) {
        await updateConversationState(userId, field.id, fieldPlots[0].id);
        return { fieldId: field.id, fieldName: field.name, plotId: fieldPlots[0].id, plotName: fieldPlots[0].name, autoCreated: false };
      }
      if (fieldPlots.length === 0) {
        await updateConversationState(userId, field.id, null);
        return { fieldId: field.id, fieldName: field.name, plotId: null, plotName: null, autoCreated: false, needPlotCreation: { fieldId: field.id, fieldName: field.name } };
      }
      // 2+ plots → signal selection needed
      await updateConversationState(userId, field.id, null);
      return {
        fieldId: field.id, fieldName: field.name, plotId: null, plotName: null, autoCreated: false,
        needPlotSelection: { fieldId: field.id, fieldName: field.name, plots: fieldPlots.map(p => ({ id: p.id, name: p.name })) },
      };
    }

    // Nothing specified — auto-assign if user has exactly 1 plot total
    const allPlots = await findAllUserPlots(userId);
    if (allPlots.length === 1) {
      const plot = allPlots[0];
      const fieldForPlot = await getFieldByName(userId, plot.field_name);
      if (fieldForPlot) {
        await updateConversationState(userId, fieldForPlot.id, plot.id);
        return { fieldId: fieldForPlot.id, fieldName: fieldForPlot.name, plotId: plot.id, plotName: plot.name, autoCreated: false };
      }
    }

    // Fallback to single field — still signal plot status
    const userFields = await getUserFields(userId);
    if (userFields.length === 1) {
      const field = await getFieldByName(userId, userFields[0].name);
      if (field) {
        await updateConversationState(userId, field.id, null);
        if (allPlots.length === 0) {
          return { fieldId: field.id, fieldName: field.name, plotId: null, plotName: null, autoCreated: false, needPlotCreation: { fieldId: field.id, fieldName: field.name } };
        }
        if (allPlots.length >= 2) {
          const fieldPlots = allPlots.filter((p: any) => p.field_id === field.id);
          return {
            fieldId: field.id, fieldName: field.name, plotId: null, plotName: null, autoCreated: false,
            needPlotSelection: { fieldId: field.id, fieldName: field.name, plots: fieldPlots.map(p => ({ id: p.id, name: p.name })) },
          };
        }
        return { fieldId: field.id, fieldName: field.name, plotId: null, plotName: null, autoCreated: false };
      }
    }

    // 2+ fields with plots → signal plot selection needed (all user plots)
    if (userFields.length >= 2 && allPlots.length >= 1) {
      return {
        fieldId: null, fieldName: null, plotId: null, plotName: null, autoCreated: false,
        needPlotSelection: { fieldId: null as any, fieldName: null as any, plots: allPlots.map((p: any) => ({ id: p.id, name: p.name })) },
      };
    }

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
    const field = await getFieldByName(userId, campoName);
    if (!field) {
      return { fieldId: null, fieldName: null, plotId: null, plotName: null, autoCreated: false, notFound: { type: 'field', name: campoName } };
    }
    const plot = await getPlotByName(field.id, plotName);
    if (!plot) {
      await updateConversationState(userId, field.id, null);
      return { fieldId: field.id, fieldName: field.name, plotId: null, plotName: null, autoCreated: false, notFound: { type: 'plot', name: plotName } };
    }
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

    // 4. Not found — return notFound instead of auto-creating
    return { fieldId: null, fieldName: null, plotId: null, plotName: null, autoCreated: false, notFound: { type: 'plot', name: plotName } };
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
