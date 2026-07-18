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

  it('passes resume and model before the multiline append-system-prompt', async () => {
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
    const resumeAt = record.argv.indexOf('--resume');
    const modelAt = record.argv.indexOf('--model');
    const appendAt = record.argv.indexOf('--append-system-prompt');
    expect(record.argv.slice(resumeAt, resumeAt + 4)).toEqual([
      '--resume',
      'sess-old',
      '--model',
      'glm-5.2',
    ]);
    expect(resumeAt).toBeGreaterThan(-1);
    expect(modelAt).toBeGreaterThan(resumeAt);
    expect(appendAt).toBeGreaterThan(modelAt);
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

  it('closes the event stream when the CodeBuddy process exits but a descendant keeps stdout open', async () => {
    const fake = await createFakeCodeBuddy({
      lines: [{ type: 'system', subtype: 'status', status: null }],
      lingerMs: 1500,
      shellWrapper: true,
    });
    cleanup.push(fake.dir);

    const run = new CodeBuddyAdapter({ binary: fake.path }).run({
      runId: 'run-inherited-stdout',
      prompt: 'hello',
      cwd: fake.dir,
      stopGraceMs: 100,
    });

    const events = collect(run.events);
    await waitForRecord(fake.recordPath);
    const fakePid = (await readRecord(fake.recordPath)).pid;
    await run.stop();

    const settled = await Promise.race([
      events.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);

    try {
      process.kill(fakePid, 'SIGTERM');
    } catch {
      // The fixed stream may outlive the short fake process on fast machines.
    }
    await events;

    expect(settled).toBe(true);
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
  lingerMs?: number;
  shellWrapper?: boolean;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'codebuddy-adapter-test-'));
  const runnerPath = join(dir, 'fake-codebuddy.mjs');
  const path = options.shellWrapper
    ? join(dir, process.platform === 'win32' ? 'fake-codebuddy.cmd' : 'fake-codebuddy.sh')
    : runnerPath;
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    runnerPath,
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
      '    pid: process.pid,',
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
      options.lingerMs
        ? `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.lingerMs});`
        : `  process.exit(${options.exitCode ?? 0});`,
      '});',
    ]
      .filter(Boolean)
      .join('\n'),
    'utf8',
  );
  await chmod(runnerPath, 0o755);
  if (options.shellWrapper) {
    const wrapper =
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${runnerPath}" %*\r\n`
        : `#!/bin/sh\n"${process.execPath}" "${runnerPath}" "$@"\n`;
    await writeFile(path, wrapper, 'utf8');
    await chmod(path, 0o755);
  }
  return { path, dir, recordPath };
}

async function waitForRecord(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`fake CodeBuddy did not start: ${path}`);
}

async function readRecord(path: string): Promise<{
  pid: number;
  argv: string[];
  stdin: string;
  systemPrompt: string | null;
  cwd: string;
  env: { LARK_CHANNEL?: string };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    pid: number;
    argv: string[];
    stdin: string;
    systemPrompt: string | null;
    cwd: string;
    env: { LARK_CHANNEL?: string };
  };
}
