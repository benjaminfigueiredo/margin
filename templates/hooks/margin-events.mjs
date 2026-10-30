#!/usr/bin/env node
// Margin: Claude Code Stop and Notification hook, installed by `margin init` into
// .claude/hooks/ (local only, never pushed to Overleaf). `margin init` may replace it.
//
// Tells the Margin editor when Claude has finished its turn (Stop) or needs you
// (Notification: a permission prompt, or waiting for your input), so it can notify you
// while you look at the paper instead of the terminal. It POSTs to the Margin server on
// 127.0.0.1 (port from .mcp.json) and prints nothing.
//
// It must never get in your way: it always exits 0, never blocks Claude from stopping,
// and gives up within about two seconds if Margin is not running.
import fs from 'node:fs';
import path from 'node:path';

const quit = () => process.exit(0);
setTimeout(quit, 2500).unref();
process.on('uncaughtException', quit);
process.on('unhandledRejection', quit);

function readStdin(ms) {
  return new Promise((resolve) => {
    let data = '';
    const done = () => resolve(data);
    setTimeout(done, ms).unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; if (data.length > 1e6) done(); });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : undefined);

async function main() {
  let input = {};
  try { input = JSON.parse(await readStdin(500)); } catch { /* no or bad input: carry on */ }
  // The event comes on stdin (hook_event_name); the command line names it too, for safety.
  const event = String(input.hook_event_name || process.argv[2] || '');
  if (event !== 'Stop' && event !== 'Notification') return;
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const url = new URL(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.margin.url);
  const port = Number(url.port) || 4242;
  await fetch(`http://127.0.0.1:${port}/api/claude/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event,
      notification_type: clip(input.notification_type, 60),
      message: clip(input.message, 300),
      title: clip(input.title, 120),
      last_assistant_message: clip(input.last_assistant_message, 300),
    }),
    signal: AbortSignal.timeout(1500),
  });
}

main().then(quit, quit);
