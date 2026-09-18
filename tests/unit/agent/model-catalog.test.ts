import { describe, expect, it } from 'vitest';
import {
  clearModelCatalogCache,
  discoverModelCatalog,
  type ModelCatalogResult,
  type ReadOnlyExecResult,
  type ReadOnlyRunner,
} from '../../../src/agent/model-catalog';
import { parseCodeBuddyHelp } from '../../../src/agent/codebuddy/models';
import {
  claudeCapability,
  codebuddyCapability,
  codexCapability,
} from '../../../src/agent/capability';
import type { ProfileConfig } from '../../../src/config/profile-schema';

const perms = { maxAccess: 'full' } as ProfileConfig['permissions'];
const permProfile = { permissions: perms } as Pick<ProfileConfig, 'permissions'>;

function baseProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    agentKind: 'codex',
    accounts: { app: { id: 'app-1', secret: 'x', tenant: 'feishu' } },
    codex: { binaryPath: '/bin/codex' },
    ...overrides,
  } as unknown as ProfileConfig;
}

function appOnly(id: string): ProfileConfig['accounts'] {
  return { app: { id, secret: 'x', tenant: 'feishu' } } as ProfileConfig['accounts'];
}

function runner(result: Partial<ReadOnlyExecResult> & { stdout?: string }): ReadOnlyRunner {
  return async () => ({
    ok: true,
    stdout: '',
    stderr: '',
    code: 0,
    timedOut: false,
    ...result,
  });
}

function recordingRunner(result: Partial<ReadOnlyExecResult>): {
  run: ReadOnlyRunner;
  calls: Array<{ binary: string; args: string[] }>;
} {
  const calls: Array<{ binary: string; args: string[] }> = [];
  return {
    calls,
    run: async (opts) => {
      calls.push({ binary: opts.binary, args: opts.args });
      return { ok: true, stdout: '', stderr: '', code: 0, timedOut: false, ...result };
    },
  };
}

describe('discoverModelCatalog — Codex', () => {
  it('parses slug/display_name, drops hidden, sorts by priority, uses --bundled', async () => {
    clearModelCatalogCache();
    const rec = recordingRunner({
      stdout: JSON.stringify({
        models: [
          { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'show', priority: 2 },
          { slug: 'gpt-5-mini', display_name: 'GPT-5 Mini', visibility: 'show', priority: 1 },
          { slug: 'secret-model', display_name: 'Hidden', visibility: 'hidden', priority: 0 },
        ],
      }),
    });
    const result = await discoverModelCatalog({
      capability: codexCapability(permProfile),
      profileConfig: baseProfile(),
      now: () => 1000,
      run: rec.run,
    });
    expect(result.status).toBe('ok');
    expect(rec.calls[0]?.args).toEqual(['debug', 'models', '--bundled']);
    expect(result.candidates.map((c) => c.id)).toEqual(['gpt-5-mini', 'gpt-5']);
    expect(result.candidates.every((c) => c.source === 'cli')).toBe(true);
    expect(result.unverified).toBe(true);
  });

  it('degrades to a failed catalog on parse error without throwing', async () => {
    clearModelCatalogCache();
    const result = await discoverModelCatalog({
      capability: codexCapability(permProfile),
      profileConfig: baseProfile({ codex: { binaryPath: '/bin/codex' } }),
      now: () => 2000,
      run: runner({ stdout: 'not json' }),
    });
    expect(result.status).toBe('failed');
    expect(result.candidates).toEqual([]);
  });
});

describe('discoverModelCatalog — CodeBuddy', () => {
  it('extracts the Currently supported list from --help output', async () => {
    clearModelCatalogCache();
    const help =
      '  --model <model>  Model for the session. Currently supported: (custom:foo, bar-1, bar-1, baz)\n';
    const rec = recordingRunner({ stdout: help });
    const result = await discoverModelCatalog({
      capability: codebuddyCapability(permProfile),
      profileConfig: baseProfile({ agentKind: 'codebuddy', codex: undefined }),
      now: () => 3000,
      run: rec.run,
    });
    expect(rec.calls[0]?.args).toEqual(['--help']);
    expect(result.candidates.map((c) => c.id)).toEqual(['custom:foo', 'bar-1', 'baz']);
    expect(result.candidates[0]?.source).toBe('help');
  });

  it('fails (→ manual fallback) when the help has no supported list', async () => {
    clearModelCatalogCache();
    const result = await discoverModelCatalog({
      capability: codebuddyCapability(permProfile),
      profileConfig: baseProfile({ agentKind: 'codebuddy', codex: undefined }),
      now: () => 3500,
      run: runner({ stdout: 'no list here' }),
    });
    expect(result.status).toBe('failed');
  });

  it('parseCodeBuddyHelp tolerates missing/empty parens', () => {
    expect(parseCodeBuddyHelp('no match')).toEqual([]);
    expect(parseCodeBuddyHelp('Currently supported: ()')).toEqual([]);
    expect(parseCodeBuddyHelp('Currently supported: ( a , b )')).toEqual(['a', 'b']);
  });
});

describe('discoverModelCatalog — Claude', () => {
  it('returns a static, unverified alias set and runs nothing', async () => {
    clearModelCatalogCache();
    const rec = recordingRunner({ stdout: '' });
    const result = await discoverModelCatalog({
      capability: claudeCapability(permProfile),
      profileConfig: baseProfile({ agentKind: 'claude', codex: undefined }),
      now: () => 4000,
      run: rec.run,
    });
    expect(result.status).toBe('static');
    expect(result.unverified).toBe(true);
    expect(rec.calls).toEqual([]);
  });
});

describe('discoverModelCatalog — cache', () => {
  it('serves a cached list within TTL and re-queries on forceRefresh', async () => {
    clearModelCatalogCache();
    let clock = 5000;
    const rec = recordingRunner({ stdout: JSON.stringify({ models: [{ slug: 'm', visibility: 'show' }] }) });
    const input = {
      capability: codexCapability(permProfile),
      profileConfig: baseProfile(),
      now: () => clock,
      run: rec.run,
    };
    await discoverModelCatalog(input);
    clock += 1000;
    const cached = await discoverModelCatalog(input);
    expect(cached.candidates[0]?.id).toBe('m');
    expect(rec.calls.length).toBe(1);
    await discoverModelCatalog({ ...input, forceRefresh: true });
    expect(rec.calls.length).toBe(2);
  });

  it('expires after TTL', async () => {
    clearModelCatalogCache();
    let clock = 5000;
    const rec = recordingRunner({ stdout: JSON.stringify({ models: [{ slug: 'm', visibility: 'show' }] }) });
    const input = {
      capability: codexCapability(permProfile),
      profileConfig: baseProfile(),
      now: () => clock,
      run: rec.run,
    };
    await discoverModelCatalog(input);
    clock += 6 * 60 * 1000;
    await discoverModelCatalog(input);
    expect(rec.calls.length).toBe(2);
  });

  it('keys the cache by account so candidates are not shared across profiles', async () => {
    clearModelCatalogCache();
    const rec = recordingRunner({ stdout: JSON.stringify({ models: [{ slug: 'm', visibility: 'show' }] }) });
    const capability = codexCapability(permProfile);
    const now = () => 6000;
    await discoverModelCatalog({
      capability,
      profileConfig: baseProfile({ accounts: appOnly('A') }),
      now,
      run: rec.run,
    });
    await discoverModelCatalog({
      capability,
      profileConfig: baseProfile({ accounts: appOnly('B') }),
      now,
      run: rec.run,
    });
    expect(rec.calls.length).toBe(2);
  });
});

describe('discoverModelCatalog — timeout', () => {
  it('marks a timed-out query as failed', async () => {
    clearModelCatalogCache();
    const result: ModelCatalogResult = await discoverModelCatalog({
      capability: codexCapability(permProfile),
      profileConfig: baseProfile(),
      now: () => 7000,
      run: async () => ({ ok: false, stdout: '', stderr: '', code: null, timedOut: true }),
    });
    expect(result.status).toBe('failed');
  });
});
