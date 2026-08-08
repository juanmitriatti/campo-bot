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
import { stripLeadingArticle, normalizeEntityName } from '../../utils/entity-matcher.js';
import type { UserId, PlotDiscoveryResult } from '../../types/index.js';

export class PlotDiscoveryService {

  async resolve(userId: UserId, fieldName?: string | null, plotName?: string | null): Promise<PlotDiscoveryResult> {
    return this.resolveFromNames(userId, fieldName || null, plotName || null);
  }

  /**
   * Same as resolveFromNames but, if NEITHER campo nor plot is specified
   * AND the standard auto-resolution returns no plot, falls back to the
   * most recently used plot from conversation_state. Use for context-aware
   * commands like "cerrar campaña" or "promedio?" where the user expects
   * the bot to remember what they were just talking about.
   */
  async resolveFromNamesWithContext(
    userId: UserId,
    campoName: string | null,
    plotName: string | null,
  ): Promise<PlotDiscoveryResult> {
    const result = await this.resolveFromNames(userId, campoName, plotName);
    if (result.plotId) return result;
    // Fall back to recent context_stack when:
    //   (a) nothing was specified, OR
    //   (b) what was specified didn't resolve (e.g. Whisper transcribed "A2"
    //       as "a dos" and the plot lookup failed). Previously we only fell
    //       back in case (a), so users hit dead-end "no encontré el lote"
    //       prompts even when bot just talked about that plot a turn ago.
    if (!result.plotId) {
      const fromState = await this._resolveFromConversationState(userId);
      if (fromState.plotId) return fromState;
    }
    return result;
  }

  async resolveFromNames(
    userId: UserId,
    campoName: string | null,
    plotName: string | null,
    options?: { allowContextStackFallback?: boolean },
  ): Promise<PlotDiscoveryResult> {
    // Case: pronoun reference → conversation state
    if (plotName === '__last__') {
      return this._resolveFromConversationState(userId);
    }

    // NOTE: el pelado de artículo de apertura ("el norte" → "norte") se hace
    // AHORA como FALLBACK dentro de _lookupPlotByName / _resolvePlotOnly, NO acá
    // arriba mutando el nombre. Pelarlo de entrada rompía lotes cuyo nombre
    // REAL arranca con artículo ("El Bajo", "La Loma", "El Monte", "Los Álamos"
    // — nombres de lote comunísimos en el campo argentino): "El Bajo" se
    // convertía en "Bajo" y no matcheaba el lote guardado "El Bajo". Bug de
    // pérdida silenciosa de datos en compounds de siembra (Jun 2026).

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

    // Nothing specified — fall back to recent context_stack ONLY when the
    // caller opts in (options.allowContextStackFallback === true). This is
    // the bedrock of conversational memory: when the user just talked about
    // lote Norte and now says "y otros 50000 en sueldos" (continuation,
    // signaled by the leading "y"), inheriting Norte is correct.
    //
    // But: silently inheriting on FRESH messages with no continuation signal
    // ("Gaste 1 peso en girasoles") guesses wrong — see user 30, 2026-05-28.
    // The handler decides via hasPlotContextSignal(originalText). When the
    // signal is absent and the user has multiple plots, we fall through to
    // needPlotSelection (asks the user).
    if (options?.allowContextStackFallback !== false) {
      const fromStack = await this._resolveFromConversationState(userId);
      if (fromStack.plotId) {
        return fromStack;
      }
    }

    // Then auto-assign if user has exactly 1 plot total
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
      // getPlotById NO filtra deleted_at (otros callers necesitan lotes
      // borrados, ej. restore). Acá SÍ: heredar un lote borrado del contexto
      // asignaba el gasto a un plot_id soft-deleted → invisible en TODOS los
      // reportes (agujero negro de datos, auditoría Jul 2026).
      if (plot && !(plot as { deleted_at?: Date | null }).deleted_at) {
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

  /**
   * Buscar un lote por nombre dentro de un campo, probando PRIMERO el nombre tal
   * cual ("El Bajo") y, SOLO si no matchea, el nombre sin artículo de apertura
   * ("el norte" → "norte", combinado con la convención "Lote X" del repo). Así
   * preservamos nombres literales con artículo y seguimos resolviendo "el norte".
   */
  private async _lookupPlotByName(fieldId: number, plotName: string): Promise<Awaited<ReturnType<typeof getPlotByName>>> {
    const direct = await getPlotByName(fieldId, plotName);
    if (direct) return direct;
    const stripped = stripLeadingArticle(plotName);
    if (stripped !== plotName) {
      return getPlotByName(fieldId, stripped);
    }
    return null;
  }

  private async _resolveBoth(userId: UserId, campoName: string, plotName: string): Promise<PlotDiscoveryResult> {
    const field = await getFieldByName(userId, campoName);
    if (!field) {
      return { fieldId: null, fieldName: null, plotId: null, plotName: null, autoCreated: false, notFound: { type: 'field', name: campoName } };
    }
    const plot = await this._lookupPlotByName(field.id, plotName);
    if (!plot) {
      // If field has exactly 1 plot, auto-resolve to it (agent may have hallucinated field name as plot)
      const fieldPlots = await getPlotsByField(field.id);
      if (fieldPlots.length === 1) {
        await updateConversationState(userId, field.id, fieldPlots[0].id);
        return { fieldId: field.id, fieldName: field.name, plotId: fieldPlots[0].id, plotName: fieldPlots[0].name, autoCreated: false };
      }
      await updateConversationState(userId, field.id, null);
      return { fieldId: field.id, fieldName: field.name, plotId: null, plotName: null, autoCreated: false, notFound: { type: 'plot', name: plotName } };
    }
    await this._registerAliases(plot.id, plotName);
    await updateConversationState(userId, field.id, plot.id);
    return { fieldId: field.id, fieldName: field.name, plotId: plot.id, plotName: plot.name, autoCreated: false };
  }

  private async _resolvePlotOnly(userId: UserId, plotName: string): Promise<PlotDiscoveryResult> {
    // 1. Direct name match across fields — probamos el nombre tal cual primero
    // ("El Bajo") y, si no hay match, sin artículo de apertura ("el norte" →
    // "norte"). Ver _lookupPlotByName para el porqué.
    let plots = await findPlotByNameAcrossFields(userId, plotName);
    if (plots.length === 0) {
      const stripped = stripLeadingArticle(plotName);
      if (stripped !== plotName) {
        plots = await findPlotByNameAcrossFields(userId, stripped);
      }
    }
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

    // 1b. Multiple matches (same name in different campos) — SIEMPRE preguntar.
    // Antes se heredaba el campo del conversation_state ("venías trabajando en
    // La Esperanza → asumo ese Norte"), pero con un nombre ambiguo explícito eso
    // agarraba el lote equivocado en silencio y hasta ofrecía pisar el cultivo
    // del otro (bug live Ago 2026: 2 lotes "Norte"). Decisión de producto:
    // nombre ambiguo + sin campo = pregunta cuál (invariante 5), aunque haya
    // contexto reciente. El deíctico exacto ("ahí mismo") sigue resolviendo por
    // _resolveFromConversationState (path sin nombre de lote), no por acá.
    if (plots.length > 1) {
      // Can't auto-resolve → return needPlotSelection with campo-tagged names
      return {
        fieldId: null, fieldName: null, plotId: null, plotName: null, autoCreated: false,
        needPlotSelection: {
          fieldId: null as any, fieldName: null as any,
          plots: plots.map((p: any) => ({ id: p.id, name: `${p.name} (${p.field_name})` })),
        },
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
      // Fallback: try the raw text as a direct plot name (handles button taps like "norte")
      const trimmed = text.trim();
      if (trimmed.length > 0 && trimmed.length < 100) {
        const directMatch = await findPlotByNameAcrossFields(userId, trimmed);
        if (directMatch.length === 1) {
          return {
            fieldId: directMatch[0].field_id,
            fieldName: directMatch[0].field_name,
            plotId: directMatch[0].id,
            plotName: directMatch[0].name,
            autoCreated: false,
          };
        }
        // Try alias
        const normalized = normalizeText(trimmed);
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
      }
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

    // 1b. Multiple matches (duplicate names across fields) — try to extract field hint from full text
    if (plots.length > 1) {
      const resolved = this._disambiguateByFieldHint(text, plots);
      if (resolved) {
        return {
          fieldId: resolved.field_id,
          fieldName: resolved.field_name,
          plotId: resolved.id,
          plotName: resolved.name,
          autoCreated: false,
        };
      }
      // Still ambiguous — return null so caller re-asks
      return { fieldId: null, fieldName: null, plotId: null, plotName: null, autoCreated: false };
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

  /**
   * Try to disambiguate duplicate plot matches by extracting a field name from the user's text.
   * E.g., "1a la esperanza" → matches "1a" in field "La Esperanza"
   */
  private _disambiguateByFieldHint(
    text: string,
    plots: { id: number; field_id: number; field_name: string; name: string }[],
  ): { id: number; field_id: number; field_name: string; name: string } | null {
    const norm = (s: string) => s.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const input = norm(text);
    const fieldNames = [...new Set(plots.map(p => p.field_name))];

    for (const fn of fieldNames) {
      const normField = norm(fn);
      // Check if input contains the field name (as suffix, after "en"/"de", or in parens)
      const patterns = [
        ` ${normField}`,           // suffix: "1a la esperanza"
        ` en ${normField}`,        // "1a en la esperanza"
        ` de ${normField}`,        // "1a de don pedro"
        `(${normField})`,          // "1a (la esperanza)"
        `campo ${normField}`,      // "campo don pedro 1a"
      ];

      for (const pat of patterns) {
        if (input.includes(pat)) {
          const match = plots.find(p => p.field_name === fn);
          if (match) return match;
        }
      }
    }

    return null;
  }

  private async _registerAliases(plotId: number, plotName: string): Promise<void> {
    // normalizeEntityName (entity-matcher) — la MISMA normalización que usa
    // getOrCreatePlot al escribir y findPlotByAlias al leer. No usar otra.
    const normalized = normalizeEntityName(plotName);
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
