#!/usr/bin/env node
// Margin: Claude Code UserPromptSubmit hook, installed by `margin init` into
// .claude/hooks/ (local only, never pushed to Overleaf). `margin init` may replace it.
//
// When you use "Ask Claude" in the Margin editor, this hands those requests to Claude
// with the next prompt you send in this folder: any message, or /margin. It asks the
// Margin server on 127.0.0.1 (port from .mcp.json) and prints what it returns, which
// Claude Code adds to your prompt as context.
//
// It must never get in your way: it always exits 0, prints nothing when there is
// nothing to hand over, and gives up within about two seconds if Margin is not running.
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

async function main() {
  let input = {};
  try { input = JSON.parse(await readStdin(500)); } catch { /* no or bad input: carry on */ }
  // /margin fetches the asks itself through the get_asks tool.
  if (/^\s*\/margin\b/.test(String(input.prompt || ''))) return '';
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const url = new URL(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.margin.url);
  const port = Number(url.port) || 4242;
  const res = await fetch(`http://127.0.0.1:${port}/api/asks/deliver`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(1500),
  });
  if (!res.ok) return '';
  const { text } = await res.json();
  return typeof text === 'string' ? text : '';
}

main().then((text) => {
  if (text) process.stdout.write(text + '\n', quit);
  else quit();
}, quit);
