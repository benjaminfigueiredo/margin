// macOS helpers for the hub, through osascript: the native folder picker, and a Terminal window
// running `claude` in a paper folder. Nothing untrusted is ever put into the AppleScript text:
// the scripts are constants and the folder is passed as an argument to the script's run handler
// (argv), then shell-quoted by AppleScript's own `quoted form of`. The commands are built here
// and run through `run`, so the tests check them with a stub and never run osascript.
import { execFile } from 'node:child_process';

const PICK_PROMPT = 'Choose the folder that holds your paper (the one with the main .tex file)';

export function folderPickerCommand() {
  return ['osascript', ['-e', 'tell me to activate', '-e', `POSIX path of (choose folder with prompt "${PICK_PROMPT}")`]];
}

// `dir` must be an absolute path (the hub only stores realpaths), so it can never be read as an
// osascript option.
export function claudeTerminalCommand(dir) {
  if (typeof dir !== 'string' || !dir.startsWith('/')) throw new Error('Expected an absolute folder path');
  return ['osascript', [
    '-e', 'on run argv',
    '-e', 'tell application "Terminal"',
    '-e', 'activate',
    '-e', 'do script "cd " & quoted form of (item 1 of argv) & " && claude"',
    '-e', 'end tell',
    '-e', 'end run',
    dir,
  ]];
}

export function runCommand(cmd, args, { timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout: String(stdout || ''), stderr: String(stderr || '') }));
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// Resolves to the chosen folder, or null when the author cancels the dialog.
export async function pickFolder({ run = runCommand } = {}) {
  const [cmd, args] = folderPickerCommand();
  try {
    const { stdout } = await run(cmd, args, { timeout: 10 * 60 * 1000 });
    const p = stdout.replace(/\r?\n$/, '');
    return p || null;
  } catch (e) {
    if (/-128/.test(e.stderr || '') || /User canceled/i.test(e.stderr || '')) return null;
    throw new Error(`The folder picker failed: ${(e.stderr || e.message || '').trim()}`);
  }
}

export async function openClaudeTerminal(dir, { run = runCommand } = {}) {
  const [cmd, args] = claudeTerminalCommand(dir);
  try { await run(cmd, args, { timeout: 30000 }); } catch (e) {
    throw new Error(`Could not open Terminal: ${(e.stderr || e.message || '').trim()}. If macOS asked whether Margin may control Terminal, allow it in System Settings → Privacy & Security → Automation.`);
  }
}
