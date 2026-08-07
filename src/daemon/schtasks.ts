import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  windowsTaskName,
  windowsLauncherCmdPath,
  windowsLauncherVbsPath,
} from './paths';
import { paths } from '../config/paths';

export interface LauncherInputs {
  /** Absolute path to node.exe. */
  nodePath: string;
  /** Absolute path to the bridge CLI entry. */
  bridgeEntryPath: string;
  /** PATH for the child process; baked into the .cmd via `set PATH=`. */
  envPath: string;
  /** Profile this service instance is pinned to. */
  profile: string;
  /** Root directory for config/profile state. */
  channelHome: string;
}

/** Delay after an ONLOGON trigger, giving the user's network stack time to settle. */
export const WINDOWS_LOGON_DELAY = '0001:00';

/** Backoff between bridge restarts after a transient startup failure. */
export const WINDOWS_LAUNCHER_RETRY_SECONDS = 15;

/**
 * Generate the .cmd wrapper script that the scheduled task actually invokes.
 *
 * schtasks `/TR` can accept a direct command, but we need stdout/stderr
 * redirection + a PATH override so child tools (lark-cli, claude) resolve
 * correctly when the daemon runs under Task Scheduler. A `.cmd` script
 * is the natural place for both.
 *
 * `@echo off` keeps the script's own commands out of the daemon log.
 * `>>` / `2>>` append (not truncate) so log history is preserved across
 * daemon restarts. A service can start while DNS/proxy initialization is
 * still in progress; a non-zero bridge exit therefore stays inside this
 * launcher and retries instead of making Task Scheduler believe the task
 * completed successfully.
 */
export function buildLauncherCmd(inputs: LauncherInputs): string {
  return [
    '@echo off',
    'setlocal',
    `set "LARK_CHANNEL_HOME=${inputs.channelHome}"`,
    `set "PATH=${inputs.envPath}"`,
    ':bridge_retry',
    `"${inputs.nodePath}" "${inputs.bridgeEntryPath}" run --profile "${inputs.profile}" >> "${daemonStdoutPath(inputs.profile)}" 2>> "${daemonStderrPath(inputs.profile)}"`,
    'set "EXIT_CODE=%ERRORLEVEL%"',
    'if "%EXIT_CODE%"=="0" goto bridge_done',
    `>> "${daemonStderrPath(inputs.profile)}" echo [launcher] bridge exited with code %EXIT_CODE%; retrying in ${WINDOWS_LAUNCHER_RETRY_SECONDS} seconds.`,
    `timeout /t ${WINDOWS_LAUNCHER_RETRY_SECONDS} /nobreak >nul`,
    'goto bridge_retry',
    ':bridge_done',
    'endlocal & exit /b 0',
    '',
  ].join('\r\n');
}

export interface LauncherVbsInputs {
  /** Absolute path to the .cmd launcher generated alongside this wrapper. */
  launcherCmdPath: string;
}

/**
 * Generate the Windows Script Host wrapper used by Task Scheduler.
 *
 * `wscript.exe` is a GUI-subsystem host, so invoking it as the task action
 * avoids the visible console that appears when a task starts a `.cmd` file
 * directly. `Run(..., 0, True)` keeps the child hidden and waits for the
 * retrying launcher to finish.
 */
export function buildLauncherVbs(inputs: LauncherVbsInputs): string {
  const command = `cmd.exe /d /c ""${inputs.launcherCmdPath}""`;
  const escapedCommand = command.replace(/"/g, '""');
  return [
    "' lark-channel-bridge hidden launcher (wscript -> cmd, no console window)",
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${escapedCommand}", 0, True`,
    '',
  ].join('\r\n');
}

async function writeLauncherScripts(profile: string): Promise<void> {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildLauncherCmd({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? '',
    profile,
    channelHome: paths.rootDir,
  });
  const cmdPath = windowsLauncherCmdPath(profile);
  await mkdir(dirname(cmdPath), { recursive: true });
  await mkdir(daemonLogDir(profile), { recursive: true });
  await writeFile(cmdPath, content, 'utf8');
  await writeFile(
    windowsLauncherVbsPath(profile),
    buildLauncherVbs({ launcherCmdPath: cmdPath }),
    'utf8',
  );
}

interface SchtasksResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

/** Build the complete task registration command for one profile. */
export function buildSchtasksCreateArgs(profile: string): string[] {
  return [
    '/Create',
    '/F',
    '/SC',
    'ONLOGON',
    '/DELAY',
    WINDOWS_LOGON_DELAY,
    '/RL',
    'LIMITED',
    '/TN',
    windowsTaskName(profile),
    '/TR',
    `"wscript.exe" "${windowsLauncherVbsPath(profile)}"`,
  ];
}

/** Build the explicit enable operation used after overwriting a task. */
export function buildSchtasksEnableArgs(profile: string): string[] {
  return ['/Change', '/TN', windowsTaskName(profile), '/Enable'];
}

function runSchtasks(args: string[]): SchtasksResult {
  const r = spawnSync('schtasks', args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? '',
    stdout: r.stdout ?? '',
  };
}

/**
 * Create (or overwrite) the scheduled task. Trigger: ONLOGON.
 * `/RL LIMITED` runs as the current user without admin elevation.
 * `/F` overwrites if the task already exists.
 *
 * The /TR value is the hidden WScript wrapper. Schtasks treats /TR as a
 * command line, so wrapping both executable and script paths in quotes keeps
 * spaces in the paths intact while avoiding a visible console window.
 */
export async function installTask(profile: string): Promise<SchtasksResult> {
  await writeLauncherScripts(profile);
  const created = runSchtasks(buildSchtasksCreateArgs(profile));
  if (!created.ok) return created;

  // `/Create /F` preserves the disabled state of an existing task on some
  // Windows builds. Explicitly enable after replacing legacy registrations;
  // otherwise `start` appears successful while the next logon still skips it.
  return runSchtasks(buildSchtasksEnableArgs(profile));
}

/** Start the task now (regardless of trigger), ensuring autostart is enabled. */
export function runTask(profile: string): SchtasksResult {
  const enabled = runSchtasks(buildSchtasksEnableArgs(profile));
  if (!enabled.ok) return enabled;
  return runSchtasks(['/Run', '/TN', windowsTaskName(profile)]);
}

/** End the running instance. Task stays registered for next logon. */
export function endTask(profile: string): SchtasksResult {
  return runSchtasks(['/End', '/TN', windowsTaskName(profile)]);
}

/** Disable autostart (task stays registered but ONLOGON trigger won't fire). */
export function disableTask(profile: string): SchtasksResult {
  return runSchtasks(['/Change', '/TN', windowsTaskName(profile), '/Disable']);
}

/** Re-enable autostart for an existing task. */
export function enableTask(profile: string): SchtasksResult {
  return runSchtasks(buildSchtasksEnableArgs(profile));
}

/** End + disable. The cross-platform "stop = stay stopped" semantic. */
export function endAndDisable(profile: string): SchtasksResult {
  const ended = endTask(profile);
  // If the task wasn't running, /End fails; we still want to disable.
  const disabled = disableTask(profile);
  // Surface whichever signal is more informative — disable result wins
  // because the autostart prevention is the user-visible effect.
  return disabled.ok ? disabled : ended.ok ? disabled : ended;
}

/** Schtasks has no native restart — end, wait, run. */
export async function restartTask(profile: string): Promise<SchtasksResult> {
  endTask(profile); // best-effort; ignore if not running
  await waitUntilStopped(profile);
  return runTask(profile);
}

/**
 * `schtasks /Query` returns 0 iff the task is registered. We toss the
 * output (it's verbose); use describeTask for full state.
 */
export function isTaskRegistered(profile: string): boolean {
  const r = spawnSync('schtasks', ['/Query', '/TN', windowsTaskName(profile)], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

/**
 * Parse `/Query /V /FO LIST` output for the current run state. Looks for
 * `Status: Running` in the verbose listing. Other states include
 * "Ready" (registered, not currently running) and "Disabled".
 */
export function isTaskRunning(profile: string): boolean {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', windowsTaskName(profile)]);
  if (!r.ok) return false;
  return /Status:\s+Running/i.test(r.stdout);
}

export function describeTask(profile: string): string {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', windowsTaskName(profile)]);
  return r.stdout || r.stderr || '';
}

export async function waitUntilStopped(profile: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTaskRunning(profile)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteTask(profile: string): Promise<SchtasksResult> {
  const r = runSchtasks(['/Delete', '/F', '/TN', windowsTaskName(profile)]);
  // Remove the launcher script too; best-effort.
  if (existsSync(windowsLauncherCmdPath(profile))) {
    await rm(windowsLauncherCmdPath(profile), { force: true });
  }
  if (existsSync(windowsLauncherVbsPath(profile))) {
    await rm(windowsLauncherVbsPath(profile), { force: true });
  }
  return r;
}
