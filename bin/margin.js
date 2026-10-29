#!/usr/bin/env node
// margin — an Overleaf-style LaTeX editor with Claude as a reviewer.
//
//   margin init [dir]            set up a manuscript repo for Margin + Claude Code
//   margin [dir] [options]       start the editor (default dir: current folder)
//
// Options: --port 4242  --main main.tex  --engine pdflatex|xelatex|lualatex  --no-open
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../server/app.js';
import { init } from '../server/init.js';

const argv = process.argv.slice(2);
const opts = { port: 4242, open: true };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opts.port = Number(argv[++i]);
  else if (a === '--main') opts.main = argv[++i];
  else if (a === '--engine') opts.engine = argv[++i];
  else if (a === '--no-open') opts.open = false;
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else positional.push(a);
}

function usage() {
  console.log(`margin — LaTeX editor with Claude as reviewer

  margin init [dir]          Set up a manuscript repo (git excludes, Claude Code config)
  margin [dir] [options]     Start the editor for dir (default: current folder)

Options:
  --port <n>        Port (default 4242)
  --main <file>     Main .tex file (default: main.tex or the file with \\documentclass)
  --engine <name>   pdflatex | xelatex | lualatex (default pdflatex)
  --no-open         Don't open the browser`);
}

if (positional[0] === 'init') {
  const dir = path.resolve(positional[1] || '.');
  try { init(dir, { port: opts.port }); } catch (e) { console.error(`margin init: ${e.message}`); process.exit(1); }
  process.exit(0);
}

const root = path.resolve(positional[0] || '.');
try {
  const { project } = await startServer({ root, port: opts.port, main: opts.main, engine: opts.engine });
  const url = `http://localhost:${opts.port}`;
  console.log(`\n  Margin is editing ${project.name} (main: ${project.main})`);
  console.log(`  Editor:      ${url}`);
  console.log(`  Claude MCP:  ${url}/mcp`);
  console.log(`\n  In another terminal:  cd "${project.root}" && claude\n`);
  if (opts.open) openBrowser(url);
} catch (e) {
  if (e.code === 'EADDRINUSE') console.error(`Port ${opts.port} is in use. Is Margin already running? Try --port 4243 (and update .mcp.json).`);
  else console.error(`margin: ${e.message}`);
  process.exit(1);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* headless */ }
}
