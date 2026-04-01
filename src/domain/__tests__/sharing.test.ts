import { describe, it, expect, vi } from 'vitest';
import { DomainRouter } from '../router.js';
import { SharingHandler } from '../sharing/sharing.handler.js';
import { FieldSharingService } from '../sharing/field-sharing.service.js';
import { AgentResponseMapper } from '../../ai/agent-response-mapper.js';
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../../ai/tool-definitions.js';
import type { UserId, User, UserSettings, HandlerResponse } from '../../types/index.js';
import type { AgentResult } from '../../ai/agent.service.js';

function mockHandler(response: HandlerResponse = { messages: ['ok'] }) {
  return { handleCommand: vi.fn().mockResolvedValue(response) };
}

const mockFeatureGate = {
  hasFeature: vi.fn().mockResolvedValue(true),
  getUserFeatures: vi.fn().mockResolvedValue([]),
  getUserPlan: vi.fn().mockResolvedValue(null),
  invalidateCache: vi.fn(),
} as any;

const userId = 1 as UserId;
const user = { id: userId, name: 'Test', phone_number: '123', city: null } as User;
const settings = {} as UserSettings;

describe('Sharing tool definitions', () => {
  it('includes share_field tool', () => {
    expect(TOOL_NAMES.has('share_field')).toBe(true);
  });

  it('includes accept_invite tool', () => {
    expect(TOOL_NAMES.has('accept_invite')).toBe(true);
  });

  it('includes list_field_members tool', () => {
    expect(TOOL_NAMES.has('list_field_members')).toBe(true);
  });

  it('includes remove_field_member tool', () => {
    expect(TOOL_NAMES.has('remove_field_member')).toBe(true);
  });

  it('share_field requires only field (no phone)', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'share_field');
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as any;
    expect(schema.required).toContain('field');
    expect(schema.required).not.toContain('phone');
    expect(schema.properties).not.toHaveProperty('phone');
  });

  it('accept_invite requires code', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'accept_invite');
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as any;
    expect(schema.required).toContain('code');
    expect(schema.properties).toHaveProperty('code');
  });

  it('remove_field_member uses member instead of phone', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'remove_field_member');
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as any;
    expect(schema.required).toContain('field');
    expect(schema.required).toContain('member');
    expect(schema.properties).toHaveProperty('member');
    expect(schema.properties).not.toHaveProperty('phone');
  });
});

describe('AgentResponseMapper for sharing tools', () => {
  const mapper = new AgentResponseMapper();

  it('maps share_field tool call (no phone)', () => {
    const result: AgentResult = {
      toolCalls: [{
        toolName: 'share_field',
        toolInput: { field: 'Norte' },
        toolUseId: 'test-1',
      }],
      conversationalText: null,
    };

    const parsed = mapper.mapToParseResults(result, 'compartir campo Norte');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].intent.type).toBe('command');
    const cmd = (parsed[0].intent as any).data;
    expect(cmd.command).toBe('share_field');
    expect(cmd.fieldName).toBe('Norte');
  });

  it('maps accept_invite tool call', () => {
    const result: AgentResult = {
      toolCalls: [{
        toolName: 'accept_invite',
        toolInput: { code: 'A3F7K2' },
        toolUseId: 'test-2',
      }],
      conversationalText: null,
    };

    const parsed = mapper.mapToParseResults(result, 'unirme A3F7K2');
    expect(parsed).toHaveLength(1);
    const cmd = (parsed[0].intent as any).data;
    expect(cmd.command).toBe('accept_invite');
    expect(cmd.code).toBe('A3F7K2');
  });

  it('maps list_field_members tool call', () => {
    const result: AgentResult = {
      toolCalls: [{
        toolName: 'list_field_members',
        toolInput: { field: 'Norte' },
        toolUseId: 'test-3',
      }],
      conversationalText: null,
    };

    const parsed = mapper.mapToParseResults(result, 'miembros campo Norte');
    expect(parsed).toHaveLength(1);
    const cmd = (parsed[0].intent as any).data;
    expect(cmd.command).toBe('list_field_members');
    expect(cmd.fieldName).toBe('Norte');
  });

  it('maps remove_field_member with member name', () => {
    const result: AgentResult = {
      toolCalls: [{
        toolName: 'remove_field_member',
        toolInput: { field: 'Norte', member: 'Juan' },
        toolUseId: 'test-4',
      }],
      conversationalText: null,
    };

    const parsed = mapper.mapToParseResults(result, 'quitar a Juan de campo Norte');
    expect(parsed).toHaveLength(1);
    const cmd = (parsed[0].intent as any).data;
    expect(cmd.command).toBe('remove_field_member');
    expect(cmd.fieldName).toBe('Norte');
    expect(cmd.memberName).toBe('Juan');
    expect(cmd.phone).toBe('Juan');
  });
});

describe('DomainRouter routes sharing commands', () => {
  it('routes share_field to sharing handler', async () => {
    const sharing = mockHandler({ messages: ['shared'] });
    const router = new DomainRouter(
      mockHandler() as any,
      mockHandler() as any,
      mockHandler() as any,
      mockFeatureGate,
      sharing as any,
    );

    const result = await router.routeCommand({ command: 'share_field', fieldName: 'Norte' }, userId, user, settings);
    expect(result).toEqual({ messages: ['shared'] });
    expect(sharing.handleCommand).toHaveBeenCalled();
  });

  it('routes accept_invite to sharing handler', async () => {
    const sharing = mockHandler({ messages: ['accepted'] });
    const router = new DomainRouter(
      mockHandler() as any,
      mockHandler() as any,
      mockHandler() as any,
      mockFeatureGate,
      sharing as any,
    );

    const result = await router.routeCommand({ command: 'accept_invite', code: 'A3F7K2' }, userId, user, settings);
    expect(result).toEqual({ messages: ['accepted'] });
    expect(sharing.handleCommand).toHaveBeenCalled();
  });

  it('routes list_field_members to sharing handler', async () => {
    const sharing = mockHandler({ messages: ['members list'] });
    const router = new DomainRouter(
      mockHandler() as any,
      mockHandler() as any,
      mockHandler() as any,
      mockFeatureGate,
      sharing as any,
    );

    const result = await router.routeCommand({ command: 'list_field_members', fieldName: 'Norte' }, userId, user, settings);
    expect(result).toEqual({ messages: ['members list'] });
    expect(sharing.handleCommand).toHaveBeenCalled();
  });

  it('routes remove_field_member to sharing handler', async () => {
    const sharing = mockHandler({ messages: ['removed'] });
    const router = new DomainRouter(
      mockHandler() as any,
      mockHandler() as any,
      mockHandler() as any,
      mockFeatureGate,
      sharing as any,
    );

    const result = await router.routeCommand({ command: 'remove_field_member', fieldName: 'Norte', memberName: 'Juan' }, userId, user, settings);
    expect(result).toEqual({ messages: ['removed'] });
    expect(sharing.handleCommand).toHaveBeenCalled();
  });

  it('blocks sharing commands when feature is not available', async () => {
    const blockedGate = {
      hasFeature: vi.fn().mockResolvedValue(false),
    } as any;
    const sharing = mockHandler();
    const router = new DomainRouter(
      mockHandler() as any,
      mockHandler() as any,
      mockHandler() as any,
      blockedGate,
      sharing as any,
    );

    const result = await router.routeCommand({ command: 'share_field' }, userId, user, settings);
    expect(result?.messages[0]).toContain('🔒');
    expect(sharing.handleCommand).not.toHaveBeenCalled();
  });

  it('accept_invite is not feature-gated (no feature in map)', async () => {
    const blockedGate = {
      hasFeature: vi.fn().mockResolvedValue(false),
    } as any;
    const sharing = mockHandler({ messages: ['accepted'] });
    const router = new DomainRouter(
      mockHandler() as any,
      mockHandler() as any,
      mockHandler() as any,
      blockedGate,
      sharing as any,
    );

    // accept_invite has no feature mapping, so it routes freely
    const result = await router.routeCommand({ command: 'accept_invite', code: 'X' }, userId, user, settings);
    expect(result).toEqual({ messages: ['accepted'] });
    expect(sharing.handleCommand).toHaveBeenCalled();
    expect(blockedGate.hasFeature).not.toHaveBeenCalled();
  });
});

describe('SharingHandler', () => {
  it('returns error when field name is missing for share_field', async () => {
    const handler = new SharingHandler();
    const result = await handler.handleCommand(
      { command: 'share_field' },
      userId,
      user,
      settings
    );
    expect(result?.messages[0]).toContain('nombre del campo');
  });

  it('returns error when code is missing for accept_invite', async () => {
    const handler = new SharingHandler();
    const result = await handler.handleCommand(
      { command: 'accept_invite' },
      userId,
      user,
      settings
    );
    expect(result?.messages[0]).toContain('código');
  });

  it('returns error when field name is missing for list_field_members', async () => {
    const handler = new SharingHandler();
    const result = await handler.handleCommand(
      { command: 'list_field_members' },
      userId,
      user,
      settings
    );
    expect(result?.messages[0]).toContain('nombre del campo');
  });

  it('returns error when field name or identifier is missing for remove_field_member', async () => {
    const handler = new SharingHandler();
    const result = await handler.handleCommand(
      { command: 'remove_field_member' },
      userId,
      user,
      settings
    );
    expect(result?.messages[0]).toContain('nombre del campo');
  });

  it('returns null for unknown commands', async () => {
    const handler = new SharingHandler();
    const result = await handler.handleCommand(
      { command: 'unknown_xyz' },
      userId,
      user,
      settings
    );
    expect(result).toBeNull();
  });
});
