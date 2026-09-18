import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearModelCatalogCache,
  discoverModelCatalog,
} from '../../src/agent/model-catalog';
import {
  claudeCapability,
  codebuddyCapability,
  codexCapability,
} from '../../src/agent/capability';
import type { ProfileConfig } from '../../src/config/profile-schema';

const perms = { maxAccess: 'full' } as ProfileConfig['permissions'];
const permProfile = { permissions: perms } as Pick<ProfileConfig, 'permissions'>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  clearModelCatalogCache();
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function fakeBinary(stdout: string, code = 0): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'model-discovery-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const path = join(dir, 'fake-agent.mjs');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      `process.stdout.write(${JSON.stringify(stdout)});`,
      `process.exit(${code});`,
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return path;
}

function codexProfile(binary: string): ProfileConfig {
  return {
    agentKind: 'codex',
    accounts: { app: { id: 'app-1', secret: 'x', tenant: 'feishu' } },
    codex: { binaryPath: binary },
  } as unknown as ProfileConfig;
}

describe('model catalog discovery via the real read-only runner', () => {
  it('spawns `codex debug models --bundled` and parses its JSON catalog', async () => {
    const payload = JSON.stringify({
      models: [
        { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'show', priority: 1 },
        { slug: 'hidden-x', display_name: 'Hidden', visibility: 'hidden', priority: 0 },
      ],
    });
    const binary = await fakeBinary(payload);
    const result = await discoverModelCatalog({
      capability: codexCapability(permProfile),
      profileConfig: codexProfile(binary),
      now: () => 1000,
    });
    expect(result.status).toBe('ok');
    expect(result.candidates.map((c) => c.id)).toEqual(['gpt-5']);
    expect(result.unverified).toBe(true);
  });

  it('spawns `codebuddy --help` and parses the Currently supported list', async () => {
    const help =
      '  --model <model>  Model. Currently supported: (gpt-oss-120b, custom:foo, custom:bar)\n';
    const binary = await fakeBinary(help);
    const previous = process.env.LARK_CHANNEL_CODEBUDDY_BIN;
    process.env.LARK_CHANNEL_CODEBUDDY_BIN = binary;
    try {
      const result = await discoverModelCatalog({
        capability: codebuddyCapability(permProfile),
        profileConfig: {
          agentKind: 'codebuddy',
          accounts: { app: { id: 'app-1', secret: 'x', tenant: 'feishu' } },
        } as unknown as ProfileConfig,
        now: () => 1000,
      });
      expect(result.status).toBe('ok');
      expect(result.candidates.map((c) => c.id)).toEqual(['gpt-oss-120b', 'custom:foo', 'custom:bar']);
    } finally {
      if (previous === undefined) delete process.env.LARK_CHANNEL_CODEBUDDY_BIN;
      else process.env.LARK_CHANNEL_CODEBUDDY_BIN = previous;
    }
  });

  it('degrades to a failed catalog when the binary exits non-zero', async () => {
    const binary = await fakeBinary('', 3);
    const result = await discoverModelCatalog({
      capability: codexCapability(permProfile),
      profileConfig: codexProfile(binary),
      now: () => 1000,
    });
    expect(result.status).toBe('failed');
    expect(result.candidates).toEqual([]);
  });

  it('claude discovery is static and spawns nothing', async () => {
    const result = await discoverModelCatalog({
      capability: claudeCapability(permProfile),
      profileConfig: codexProfile('/definitely/not/a/real/binary'),
      now: () => 1000,
    });
    expect(result.status).toBe('static');
    expect(result.candidates.length).toBeGreaterThan(0);
  });
});
