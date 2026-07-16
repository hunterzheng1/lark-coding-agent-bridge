import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeBuddyAdapter } from '../../src/agent/codebuddy/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('CodeBuddyAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('injects bridge system prompt inline and keeps prompt on stdin', async () => {
    const fake = await createFakeCodeBuddy({
      lines: [
        { type: 'system', subtype: 'status', status: null },
        { type: 'file-history-snapshot', id: 'snap-1' },
        { type: 'result', session_id: 'sess-fresh', usage: { input_tokens: 1, output_tokens: 2 } },
      ],
    });
    cleanup.push(fake.dir);

    const run = new CodeBuddyAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      prompt: 'hello',
      cwd: fake.dir,
      permissionMode: 'acceptEdits',
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      {
        type: 'usage',
        inputTokens: 1,
        outputTokens: 2,
        cachedInputTokens: undefined,
        costUsd: undefined,
      },
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    expect(record.stdin).toBe('hello');
    expect(record.argv.slice(0, 7)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--append-system-prompt',
    ]);
    expect(record.argv).not.toContain('--append-system-prompt-file');
    expect(record.argv).not.toContain('hello');
    expect(record.systemPrompt).toContain('lark-channel-bridge 运行约定');
    expect(record.systemPrompt).toContain('__bridge_cb');
    expect(record.argv).not.toContain('--resume');
    expect(record.argv).not.toContain('--model');
  });

  it('passes resume and model after the base CLI contract', async () => {
    const fake = await createFakeCodeBuddy({
      lines: [{ type: 'result', session_id: 'sess-resumed' }],
    });
    cleanup.push(fake.dir);

    const run = new CodeBuddyAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'sess-old',
      model: 'glm-5.2',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);
    expect(record.argv.slice(-4)).toEqual(['--resume', 'sess-old', '--model', 'glm-5.2']);
  });

  it('requires cwd before spawning', () => {
    expect(() =>
      new CodeBuddyAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });

  it('resolves the binary from LARK_CHANNEL_CODEBUDDY_BIN when no option is given', async () => {
    const fake = await createFakeCodeBuddy({
      lines: [{ type: 'result', session_id: 'sess-env' }],
    });
    cleanup.push(fake.dir);

    const previous = process.env.LARK_CHANNEL_CODEBUDDY_BIN;
    process.env.LARK_CHANNEL_CODEBUDDY_BIN = fake.path;
    try {
      const run = new CodeBuddyAdapter().run({
        runId: 'run-env-bin',
        prompt: 'env',
        cwd: fake.dir,
      });
      expect(await collect(run.events)).toEqual([
        { type: 'done', sessionId: 'sess-env', terminationReason: 'normal' },
      ]);
      const record = await readRecord(fake.recordPath);
      expect(record.stdin).toBe('env');
    } finally {
      if (previous === undefined) delete process.env.LARK_CHANNEL_CODEBUDDY_BIN;
      else process.env.LARK_CHANNEL_CODEBUDDY_BIN = previous;
    }
  });

  it('reports availability failures with codebuddy agentId', async () => {
    const missing = join(tmpdir(), `missing-codebuddy-${Date.now()}`);
    const availability = await new CodeBuddyAdapter({ binary: missing }).checkAvailability();
    expect(availability.ok).toBe(false);
    if (availability.ok) return;
    expect(availability.diagnostic.agentId).toBe('codebuddy');
    expect(availability.diagnostic.code).toBe('agent-binary-not-found');
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeCodeBuddy(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'codebuddy-adapter-test-'));
  const path = join(dir, 'fake-codebuddy.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'const spIdx = argv.indexOf("--append-system-prompt");',
      'const systemPrompt = spIdx !== -1 ? argv[spIdx + 1] : null;',
      'let stdin = "";',
      'process.stdin.on("data", (chunk) => { stdin += chunk; });',
      'process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv,',
      '    stdin,',
      '    systemPrompt,',
      '    cwd: process.cwd(),',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '    },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  process.exit(${options.exitCode ?? 0});`,
      '});',
    ]
      .filter(Boolean)
      .join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  stdin: string;
  systemPrompt: string | null;
  cwd: string;
  env: { LARK_CHANNEL?: string };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    stdin: string;
    systemPrompt: string | null;
    cwd: string;
    env: { LARK_CHANNEL?: string };
  };
}