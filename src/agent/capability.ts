import type { AccessMode } from '../config/permissions';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'codebuddy';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'codebuddy-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

/**
 * Per-backend interaction capability matrix (OPT-05). The bridge must never
 * render or promise an interaction a backend cannot honor: UI surfaces gate
 * on these flags. Each `true` needs protocol evidence in the translator that
 * maps the corresponding upstream events; structured interaction channels
 * (input request / tool approval / task list / steer) stay false until one is
 * verified end-to-end for a specific backend.
 */
export interface InteractionCapabilities {
  /** Streams upstream thinking/reasoning content (`thinking` events). */
  thinkingEvents: boolean;
  /** Streams partial assistant text while the run is in flight (`text` deltas). */
  incrementalText: boolean;
  /** Emits token usage events. */
  usageEvents: boolean;
  /** A native history provider is wired (session/thread recall). */
  nativeHistory: boolean;
  /** Backend can ask the user a question mid-run via a structured event. */
  inputRequest: boolean;
  /** Backend delegates tool-permission decisions to the bridge mid-run. */
  toolApproval: boolean;
  /** Backend exposes structured plan/task-list events. */
  taskList: boolean;
  /** Backend accepts steering messages for an in-flight run. */
  steer: boolean;
}

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  interactions: InteractionCapabilities;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  const interactions = streamJsonInteractions(true);
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    // Compat alias — interactions.nativeHistory is the single source of truth.
    supportsNativeHistory: interactions.nativeHistory,
    interactions,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  const interactions: InteractionCapabilities = {
    // Protocol evidence: src/agent/codex/jsonl.ts maps agent_message /
    // command execution / token_count — no reasoning items.
    thinkingEvents: false,
    incrementalText: true,
    usageEvents: true,
    // /resume lists and restores Codex threads via codexHistoryProvider.
    nativeHistory: true,
    inputRequest: false,
    toolApproval: false,
    taskList: false,
    steer: false,
  };
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: interactions.nativeHistory,
    interactions,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codebuddyCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  const interactions = streamJsonInteractions(true);
  return {
    agentId: 'codebuddy',
    sessionKind: 'codebuddy-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: interactions.nativeHistory,
    // Protocol evidence: CodeBuddyAdapter reuses the Claude stream-json
    // translator, so thinking/text/usage mappings carry over 1:1.
    interactions,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/**
 * Event matrix shared by the backends that speak Claude stream-json. All
 * structured-interaction channels are false everywhere until a protocol is
 * verified end-to-end (OPT-05 vertical loop).
 */
function streamJsonInteractions(nativeHistory: boolean): InteractionCapabilities {
  return {
    thinkingEvents: true,
    incrementalText: true,
    usageEvents: true,
    nativeHistory,
    inputRequest: false,
    toolApproval: false,
    taskList: false,
    steer: false,
  };
}

export function capabilityForAgentKind(
  kind: AgentKind | undefined,
  profile: Pick<ProfileConfig, 'permissions'>,
): AgentCapability {
  if (kind === 'codex') return codexCapability(profile);
  if (kind === 'codebuddy') return codebuddyCapability(profile);
  return claudeCapability(profile);
}
