import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../../../src/agent/codex/argv.js';

describe('Codex argv contract', () => {
  it('builds the fresh exec argv without putting the prompt in argv', () => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'read-only' })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '-',
    ]);
  });

  it('puts global flags before resume and resume-local flags after resume', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        threadId: 'thread-123',
      }),
    ).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      'resume',
      '--json',
      'thread-123',
      '-',
    ]);
  });

  it('allows danger-full-access for Claude bridge parity', () => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'danger-full-access' })).toContain(
      'danger-full-access',
    );
  });

  it('separates image flags from stdin prompt for fresh exec', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        images: ['/tmp/image.png'],
      }),
    ).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '--image',
      '/tmp/image.png',
      '--',
      '-',
    ]);
  });

  it('passes resume image flags after the resume subcommand', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        threadId: 'thread-123',
        images: ['/tmp/image.png'],
      }),
    ).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      'resume',
      '--json',
      '--image',
      '/tmp/image.png',
      'thread-123',
      '-',
    ]);
  });

  it('can explicitly ignore the user config when profile isolation asks for it', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'read-only',
        ignoreUserConfig: true,
      }),
    ).toContain('--ignore-user-config');
  });

  it('carries the model as a discrete global flag on a fresh exec', () => {
    const argv = buildCodexArgs({
      cwd: '/repo',
      sandbox: 'workspace-write',
      model: 'gpt-5',
    });
    expect(argv).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '--model',
      'gpt-5',
      '-',
    ]);
  });

  it('carries the model as a global flag before the resume subcommand', () => {
    const argv = buildCodexArgs({
      cwd: '/repo',
      sandbox: 'workspace-write',
      threadId: 'thread-123',
      model: 'gpt-5-mini',
    });
    const modelIndex = argv.indexOf('--model');
    const resumeIndex = argv.indexOf('resume');
    expect(modelIndex).toBeGreaterThan(-1);
    expect(argv[modelIndex + 1]).toBe('gpt-5-mini');
    expect(resumeIndex).toBeGreaterThan(-1);
    // Global flag must precede the subcommand so resume inherits it.
    expect(modelIndex).toBeLessThan(resumeIndex);
  });

  it('omits the model entirely when no override is set', () => {
    expect(
      buildCodexArgs({ cwd: '/repo', sandbox: 'read-only' }),
    ).not.toContain('--model');
  });
});
