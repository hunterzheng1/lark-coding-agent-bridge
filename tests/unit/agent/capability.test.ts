import { describe, expect, it } from 'vitest';
import { BRIDGE_SYSTEM_PROMPT } from '../../../src/agent/bridge-system-prompt';
import {
  capabilityForAgentKind,
  claudeCapability,
  codebuddyCapability,
  codexCapability,
} from '../../../src/agent/capability';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { agentKindFromString } from '../../../src/config/profile-store';

describe('agent capability contract', () => {
  it('defines Claude capability with legacy callback marker compatibility', () => {
    const capability = claudeCapability();

    expect(capability).toMatchObject({
      agentId: 'claude',
      sessionKind: 'claude-session',
      promptInjection: 'append-system-prompt',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: ['__claude_cb'],
      },
    });
  });

  it('defines Codex capability with thread sessions and stdin prompt injection', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    expect(codexCapability(profile)).toMatchObject({
      agentId: 'codex',
      sessionKind: 'codex-thread',
      promptInjection: 'stdin-prefix',
      supportsNativeHistory: false,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      permissions: {
        maxAccess: 'workspace',
      },
    });
  });

  it('uses Codex profile max access as the static capability ceiling', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });

    expect(codexCapability(profile).permissions.maxAccess).toBe('read-only');
  });

  it('defines CodeBuddy capability with sessionId resume semantics', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codebuddy',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });

    expect(codebuddyCapability(profile)).toMatchObject({
      agentId: 'codebuddy',
      sessionKind: 'codebuddy-session',
      promptInjection: 'append-system-prompt',
      supportsNativeHistory: true,
      systemPrompt: BRIDGE_SYSTEM_PROMPT,
      callback: {
        marker: '__bridge_cb',
        legacyMarkers: [],
      },
      permissions: {
        maxAccess: 'read-only',
      },
    });
  });

  it('defaults CodeBuddy max access to full when profile is omitted', () => {
    expect(codebuddyCapability().permissions.maxAccess).toBe('full');
  });

  it('routes capabilityForAgentKind across claude, codex, and codebuddy', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
    });
    const codexProfile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: {
        app: {
          id: 'cli_test',
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      codex: { binaryPath: 'codex' },
    });

    expect(capabilityForAgentKind('claude', profile).agentId).toBe('claude');
    expect(capabilityForAgentKind('codex', codexProfile).agentId).toBe('codex');
    expect(capabilityForAgentKind('codebuddy', profile).agentId).toBe('codebuddy');
    expect(capabilityForAgentKind(undefined, profile).agentId).toBe('claude');
  });
});

describe('agentKindFromString', () => {
  it('accepts codebuddy', () => {
    expect(agentKindFromString('codebuddy')).toBe('codebuddy');
  });

  it('rejects unsupported agents', () => {
    expect(() => agentKindFromString('copilot')).toThrow(/unsupported agent: copilot/);
  });

  it('passes through undefined', () => {
    expect(agentKindFromString(undefined)).toBeUndefined();
  });
});
