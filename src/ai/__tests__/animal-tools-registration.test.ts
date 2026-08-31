import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../tool-definitions.js';
import { classifyDomain } from '../../domain/router.js';
import { FeatureGate } from '../../domain/billing/feature-gate.js';
import { AgentResponseMapper } from '../agent-response-mapper.js';

/**
 * Invariante 2: comando nuevo = 3 registros (schema + set del router + switch
 * del handler) + mapeo explícito de los campos que el copiador genérico no cubre.
 * Si falta uno, `routeCommand` devuelve null y el comando falla EN SILENCIO.
 *
 * Este test recorre las seis tools de la capa individual y verifica cada
 * registro, para que el próximo que agregue una tool acá no descubra el olvido
 * en producción.
 */

const ANIMAL_TOOLS = [
  'register_animal',
  'identify_animal',
  'query_animal',
  'list_animals',
  'move_animals',
  'revert_livestock_movement',
] as const;

describe('capa individual de hacienda — registros (invariante 2)', () => {
  it.each(ANIMAL_TOOLS)('%s tiene schema en TOOL_DEFINITIONS', (name) => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
    expect(tool, `falta el schema de ${name}`).toBeDefined();
    expect(tool!.description.length).toBeGreaterThan(40);
    expect(tool!.input_schema.type).toBe('object');
    expect(TOOL_NAMES.has(name)).toBe(true);
  });

  it.each(ANIMAL_TOOLS)('%s rutea al dominio livestock', (name) => {
    expect(classifyDomain(name), `${name} no está en ningún *_COMMANDS`).toBe('livestock');
  });

  it.each(ANIMAL_TOOLS)('%s está gateado por el feature livestock', (name) => {
    expect(FeatureGate.commandToFeature(name)).toBe('livestock');
  });

  it('set_livestock_price también quedó gateado (faltaba)', () => {
    expect(FeatureGate.commandToFeature('set_livestock_price')).toBe('livestock');
  });

  describe('mapeo de campos que el copiador genérico no cubre', () => {
    const mapper = new AgentResponseMapper();
    // El output-validator se apaga acá a propósito: lo que se prueba es el
    // MAPEO de campos, no la capa anti-alucinación (que tiene su propia suite y
    // vetaría valores que este test inyecta sin texto de respaldo).
    const mapOne = (toolName: string, toolInput: Record<string, unknown>) => {
      const [result] = mapper.mapToParseResults(
        { toolCalls: [{ toolName, toolInput }], text: null, truncated: false } as never,
        'texto original',
        {},
      );
      const intent = result?.intent as { type: string; data: Record<string, unknown> };
      return intent?.data ?? {};
    };

    it('register_animal traslada rfid, visual_tag, sex, birth_date y origin', () => {
      const data = mapOne('register_animal', {
        category: 'vaca', rfid: '032010001234567', visual_tag: 'A-77',
        sex: 'H', birth_date: '2024-03-10', origin: 'compra',
      });
      expect(data.rfid).toBe('032010001234567');
      expect(data.visualTag).toBe('A-77');
      expect(data.sex).toBe('H');
      expect(data.birthDate).toBe('2024-03-10');
      expect(data.origin).toBe('compra');
    });

    it('identify_animal traslada animal_ref y new_rfid', () => {
      const data = mapOne('identify_animal', {
        animal_ref: '0001234567', new_rfid: '0007654321', reason: 'perdida',
      });
      expect(data.animalRef).toBe('0001234567');
      expect(data.newRfid).toBe('0007654321');
    });

    it('query_animal traslada animal_ref', () => {
      expect(mapOne('query_animal', { animal_ref: '032010001234567' }).animalRef).toBe('032010001234567');
    });

    it('list_animals traslada status e identified', () => {
      const data = mapOne('list_animals', { status: 'vendido', identified: false });
      expect(data.status).toBe('vendido');
      expect(data.identified).toBe(false);
    });

    it('move_animals normaliza animal_refs a string[]', () => {
      const data = mapOne('move_animals', {
        animal_refs: ['0001234567', 7654321], dest_plot: 'Sur',
      });
      expect(data.animalRefs).toEqual(['0001234567', '7654321']);
      expect(data.destPlot).toBe('Sur');
    });

    it('revert_livestock_movement traslada movement_id', () => {
      expect(mapOne('revert_livestock_movement', { movement_id: 'abc' }).movementId).toBe('abc');
    });
  });

  describe('las tools de grupo siguen intactas', () => {
    // La capa individual es aditiva: si alguna de estas se rompió, se rompió el
    // camino que usa el productor todos los días.
    const GROUP_TOOLS = [
      'add_livestock', 'remove_livestock', 'transfer_livestock',
      'record_livestock_death', 'record_livestock_birth', 'adjust_livestock',
      'list_livestock', 'livestock_history',
      'log_health_event', 'log_repro_event', 'log_weighing',
    ];

    it.each(GROUP_TOOLS)('%s sigue registrada y ruteando a livestock', (name) => {
      expect(TOOL_NAMES.has(name)).toBe(true);
      expect(classifyDomain(name)).toBe('livestock');
    });

    it('transfer_livestock conserva sus params de grupo', () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === 'transfer_livestock')!;
      const props = tool.input_schema.properties as Record<string, unknown>;
      for (const p of ['category', 'count', 'source_plot', 'dest_plot', 'dest_category']) {
        expect(props[p], `transfer_livestock perdió el param ${p}`).toBeDefined();
      }
      expect(tool.input_schema.required).toEqual(['category', 'count']);
    });
  });
});
