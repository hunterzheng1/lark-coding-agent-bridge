import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));
import { buildPlist } from '../../../src/daemon/launchd';
import {
  daemonStderrPath,
  daemonStdoutPath,
  launchAgentLabel,
  serviceProfileId,
  systemdUnitName,
  windowsTaskName,
  windowsLauncherVbsPath,
} from '../../../src/daemon/paths';
import {
  buildLauncherCmd,
  buildLauncherVbs,
  buildSchtasksCreateArgs,
  buildSchtasksEnableArgs,
  runTask,
} from '../../../src/daemon/schtasks';
import { buildUnit } from '../../../src/daemon/systemd';

describe('profile-scoped daemon paths and arguments', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as never);
  });

  it('sanitizes service ids and gives each profile distinct service names and logs', () => {
    expect(() => serviceProfileId('codex dev')).toThrow(/invalid profile name/i);
    expect(serviceProfileId('codex_dev')).toBe('codex_dev');
    expect(launchAgentLabel('codex-dev')).toContain('codex-dev');
    expect(systemdUnitName('claude')).not.toBe(systemdUnitName('codex-dev'));
    expect(windowsTaskName('claude')).not.toBe(windowsTaskName('codex-dev'));
    expect(daemonStdoutPath('claude')).not.toBe(daemonStdoutPath('codex-dev'));
    expect(daemonStderrPath('codex-dev').replace(/\\/g, '/')).toContain(
      '/profiles/codex-dev/logs/daemon/',
    );
  });

  it('pins launchd, systemd, and schtasks launch commands to run --profile', () => {
    const inputs = {
      nodePath: '/usr/local/bin/node',
      bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
      envPath: '/usr/local/bin:/usr/bin',
      profile: 'codex-dev',
      channelHome: '/tmp/lark-channel-home',
    };

    expect(buildPlist(inputs)).toContain('<string>--profile</string>\n        <string>codex-dev</string>');
    expect(buildPlist(inputs)).toContain('<key>LARK_CHANNEL_HOME</key>\n        <string>/tmp/lark-channel-home</string>');
    expect(buildUnit(inputs)).toContain('run --profile "codex-dev"');
    expect(buildUnit(inputs)).toContain('Environment="LARK_CHANNEL_HOME=/tmp/lark-channel-home"');
    expect(buildLauncherCmd(inputs)).toContain('run --profile "codex-dev"');
    expect(buildLauncherCmd(inputs)).toContain('set "LARK_CHANNEL_HOME=/tmp/lark-channel-home"');
  });

  it('keeps a scheduled task alive while retrying transient startup failures', () => {
    const inputs = {
      nodePath: '/usr/local/bin/node',
      bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
      envPath: '/usr/local/bin:/usr/bin',
      profile: 'claude',
      channelHome: '/tmp/lark-channel-home',
    };

    const launcher = buildLauncherCmd(inputs);
    expect(launcher).toContain(':bridge_retry');
    expect(launcher).toContain('set "EXIT_CODE=%ERRORLEVEL%"');
    expect(launcher).toContain('timeout /t 15 /nobreak >nul');
    expect(launcher).toContain('goto bridge_retry');
    expect(launcher).toContain('endlocal & exit /b 0');
  });

  it('delays the logon trigger so the user network stack can settle', () => {
    const args = buildSchtasksCreateArgs('claude');
    expect(args).toEqual(expect.arrayContaining(['/SC', 'ONLOGON', '/DELAY', '0001:00']));
    expect(args).toContain('/F');
    expect(args).toEqual(
      expect.arrayContaining(['/TR', `"wscript.exe" "${windowsLauncherVbsPath('claude')}"`]),
    );
  });

  it('launches the cmd wrapper without a visible console', () => {
    const vbs = buildLauncherVbs({
      launcherCmdPath: 'C:\\Users\\WINDOWS\\.lark-channel\\daemon\\claude\\launcher.cmd',
    });

    expect(vbs).toContain('CreateObject("WScript.Shell")');
    expect(vbs).toContain('cmd.exe /d /c');
    expect(vbs).toContain(', 0, True');
  });

  it('explicitly enables a task after overwriting a legacy disabled registration', () => {
    expect(buildSchtasksEnableArgs('claude')).toEqual([
      '/Change',
      '/TN',
      windowsTaskName('claude'),
      '/Enable',
    ]);
  });

  it('enables the task before starting it on demand', () => {
    runTask('claude');

    expect(vi.mocked(spawnSync).mock.calls).toEqual([
      ['schtasks', ['/Change', '/TN', windowsTaskName('claude'), '/Enable'], expect.anything()],
      ['schtasks', ['/Run', '/TN', windowsTaskName('claude')], expect.anything()],
    ]);
  });
});
