import {
  parseCommand,
  parseMensaje,
  parseMensajeIngreso,
  detectarCampoLote,
  detectarCampo,
  detectarLote,
  normalizarMonto,
  extractAmount as _extractAmount,
  hasFinancialIntent as _hasFinancialIntent,
  detectarCategoria,
  detectarCategoriaIngreso,
  parseMilimetros,
  parseSpanishDate,
  normalizeText,
  fixCommonTypos,
  expandNumbers,
  parsearObservacion,
} from '../utils/parser.js';
import { applySynonyms } from '../utils/synonyms.js';
import { normalizePlotNumbers } from '../utils/text-normalizer.js';
import type { ParsedCommand, ParsedExpense, ParsedIncome } from '../types/index.js';

export class ParserService {
  /**
   * Full text preprocessing pipeline: normalize → typo fix → number expand → synonyms
   */
  preprocess(text: string): string {
    let result = normalizeText(text);
    result = fixCommonTypos(result);
    result = expandNumbers(result);
    result = applySynonyms(result);
    result = normalizePlotNumbers(result);
    return result;
  }

  parseCommand(text: string): ParsedCommand | null {
    return parseCommand(text) as ParsedCommand | null;
  }

  parseExpense(text: string): ParsedExpense | null {
    return parseMensaje(text) as ParsedExpense | null;
  }

  parseIncome(text: string): ParsedIncome | null {
    return parseMensajeIngreso(text) as ParsedIncome | null;
  }

  detectField(text: string): string | null {
    return detectarCampoLote(text);
  }

  detectCampo(text: string): string | null {
    return detectarCampo(text);
  }

  detectPlot(text: string): string | null {
    return detectarLote(text);
  }

  normalizeAmount(text: string): number | null {
    return normalizarMonto(text);
  }

  detectExpenseCategory(text: string): string | null {
    return detectarCategoria(text);
  }

  detectIncomeCategory(text: string): string | null {
    return detectarCategoriaIngreso(text);
  }

  parseRainfall(text: string): number | null {
    return parseMilimetros(text);
  }

  parseDate(text: string): Date | null {
    return parseSpanishDate(text);
  }

  parseObservation(text: string): { plotName: string | null; fieldName: string | null; category: string; observationText: string } | null {
    return parsearObservacion(text);
  }

  extractAmount(text: string): number | null {
    return _extractAmount(text);
  }

  hasFinancialIntent(text: string): boolean {
    return _hasFinancialIntent(text);
  }
}
