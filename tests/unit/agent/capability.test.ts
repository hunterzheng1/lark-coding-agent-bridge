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
      supportsNativeHistory: true,
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

// ─── OPT-05: interaction capability matrix ──────────────────────────────────

import type { InteractionCapabilities } from '../../../src/agent/capability';

describe('OPT-05: interaction capability matrix', () => {
  it('declares thinking events only for stream-json backends (claude, codebuddy)', () => {
    expect(capabilityForAgentKind('claude', profile()).interactions.thinkingEvents).toBe(true);
    expect(capabilityForAgentKind('codebuddy', profile()).interactions.thinkingEvents).toBe(true);
    // Codex JSONL translator maps no reasoning items (protocol evidence:
    // src/agent/codex/jsonl.ts emits text/final_text/tool/usage only).
    expect(capabilityForAgentKind('codex', profile()).interactions.thinkingEvents).toBe(false);
  });

  it('declares incremental text and usage events for all three backends', () => {
    for (const kind of ['claude', 'codex', 'codebuddy'] as const) {
      const cap = capabilityForAgentKind(kind, profile());
      expect(cap.interactions.incrementalText).toBe(true);
      expect(cap.interactions.usageEvents).toBe(true);
    }
  });

  it('declares no structured input/approval/steer channels for any backend yet', () => {
    // The bridge must never render interaction controls a backend cannot
    // honor. Until a protocol is verified end-to-end, these stay false.
    for (const kind of ['claude', 'codex', 'codebuddy'] as const) {
      const cap = capabilityForAgentKind(kind, profile());
      expect(cap.interactions.inputRequest).toBe(false);
      expect(cap.interactions.toolApproval).toBe(false);
      expect(cap.interactions.taskList).toBe(false);
      expect(cap.interactions.steer).toBe(false);
    }
  });

  it('native history matches supportsNativeHistory', () => {
    expect(capabilityForAgentKind('claude', profile()).interactions.nativeHistory).toBe(true);
    // /resume lists Codex threads via codexHistoryProvider (handleResume).
    expect(capabilityForAgentKind('codex', profile()).interactions.nativeHistory).toBe(true);
    expect(capabilityForAgentKind('codebuddy', profile()).interactions.nativeHistory).toBe(true);
  });

  it('the matrix is exposed through capabilityForAgentKind', () => {
    const cap = capabilityForAgentKind('codebuddy', profile());
    const keys = Object.keys(cap.interactions) as Array<keyof InteractionCapabilities>;
    expect(keys.sort()).toEqual([
      'incrementalText',
      'inputRequest',
      'nativeHistory',
      'steer',
      'taskList',
      'thinkingEvents',
      'toolApproval',
      'usageEvents',
    ]);
  });
});

function profile() {
  return createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
  });
}
