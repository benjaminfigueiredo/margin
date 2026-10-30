#!/usr/bin/env node
// margin — an Overleaf-style LaTeX editor with Claude as a reviewer.
//
//   margin init [dir]            set up a manuscript repo for Margin + Claude Code
//   margin [dir] [options]       start the editor (default dir: current folder)
//   margin hub [options]         start the hub: all your papers on one page
//   margin                       the editor if the current folder has a .tex file, else the hub
//
// Options: --port 4242  --main main.tex  --engine pdflatex|xelatex|lualatex  --no-open
//          --exit-with-stdin (hub only: stop when stdin closes, for programs that start the hub)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../server/app.js';
import { init } from '../server/init.js';
import { resolveConfigDir } from '../server/config.js';

// Started by the hub (server/hub.js forks this file with an IPC channel): exit as soon as the hub
// goes away, however it goes. The channel closes even when the hub is SIGKILLed.
const hubUrl = process.send && process.env.MARGIN_HUB_URL ? process.env.MARGIN_HUB_URL : undefined;
if (hubUrl) {
  process.on('disconnect', () => process.exit(0));
  if (!process.connected) process.exit(0);
}

const argv = process.argv.slice(2);
const opts = { port: 4242, open: true };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opts.port = Number(argv[++i]);
  else if (a === '--main') opts.main = argv[++i];
  else if (a === '--engine') opts.engine = argv[++i];
  else if (a === '--no-open') opts.open = false;
  else if (a === '--exit-with-stdin') opts.exitWithStdin = true;
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else positional.push(a);
}

function usage() {
  console.log(`margin — LaTeX editor with Claude as reviewer

  margin init [dir]          Set up a manuscript repo (git excludes, Claude Code config)
  margin [dir] [options]     Start the editor for dir (default: current folder)
  margin hub [options]       Start the hub: your papers on one page, each on its own port
  margin                     With no folder: the editor if the current folder contains a
                             .tex file, otherwise the hub (for a folder named "hub", use ./hub)

Options:
  --port <n>        Port (default 4242; the hub gives each paper its own port from 4243)
  --main <file>     Main .tex file (default: main.tex or the file with \\documentclass)
  --engine <name>   pdflatex | xelatex | lualatex (default pdflatex)
  --no-open         Don't open the browser
  --exit-with-stdin (margin hub) Stop the hub, and its papers, when stdin closes:
                    for a program that starts the hub and keeps a pipe open on its stdin

When the hub is listening it prints one line for programs that start it:
  MARGIN_HUB_READY http://127.0.0.1:<port>/`);
}

if (positional[0] === 'init') {
  const dir = path.resolve(positional[1] || '.');
  try { init(dir, { port: opts.port }); } catch (e) { console.error(`margin init: ${e.message}`); process.exit(1); }
  process.exit(0);
}

const hasTex = (dir) => { try { return fs.readdirSync(dir).some((n) => n.toLowerCase().endsWith('.tex')); } catch { return false; } };

const startsHub = positional[0] === 'hub' || (positional.length === 0 && !hubUrl && !hasTex(process.cwd()));
if (opts.exitWithStdin && !startsHub) { console.error('--exit-with-stdin is an option of margin hub only.'); process.exit(1); }

if (startsHub) {
  if (positional[0] === 'hub' && positional.length > 1) { console.error('margin hub takes no folder. Add papers from the hub page.'); process.exit(1); }
  if (positional[0] !== 'hub') console.log(`No .tex file in ${process.cwd()}, so starting the hub (margin <folder> opens one paper).`);
  await runHub();
} else {
  await runPaper();
}

async function runPaper() {
  const root = path.resolve(positional[0] || '.');
  try {
    const { project } = await startServer({ root, port: opts.port, main: opts.main, engine: opts.engine, configDir: resolveConfigDir(), hubUrl });
    const url = `http://localhost:${opts.port}`;
    console.log(`\n  Margin is editing ${project.name} (main: ${project.main})`);
    console.log(`  Editor:      ${url}`);
    console.log(`  Claude MCP:  ${url}/mcp`);
    console.log(`\n  In another terminal:  cd "${project.root}" && claude\n`);
    if (!hubUrl) warnMcpPort(project.root, opts.port);
    if (opts.open) openBrowser(url);
  } catch (e) {
    if (e.code === 'EADDRINUSE') console.error(`Port ${opts.port} is in use. Is Margin already running? Try --port 4243 (and update .mcp.json).`);
    else console.error(`margin: ${e.message}`);
    process.exit(1);
  }
}

// .mcp.json tells Claude Code which port to talk to. If it names another port, Claude in this
// folder reaches whatever runs there (another paper, or nothing).
function warnMcpPort(root, port) {
  let url;
  try { url = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'))?.mcpServers?.margin?.url; } catch { return; }
  const m = typeof url === 'string' && url.match(/^https?:\/\/[^/]+:(\d+)\//);
  if (m && Number(m[1]) !== port) console.log(`  Note: .mcp.json points Claude Code at port ${m[1]}, not ${port}. Start Margin with --port ${m[1]}, or Claude in this folder will not reach this paper.\n`);
}

async function runHub() {
  const { startHub, READY_PREFIX } = await import('../server/hub.js');
  let hub;
  try {
    hub = await startHub({ port: opts.port, log: (l) => console.error(l) });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      let isHub = false;
      try { isHub = (await (await fetch(`http://127.0.0.1:${opts.port}/api/hub`, { signal: AbortSignal.timeout(1500) })).json()).hub === true; } catch { /* something else */ }
      console.error(isHub ? `A Margin hub is already running at http://127.0.0.1:${opts.port}/` : `Port ${opts.port} is in use (a paper started with "margin <folder>"?). Try: margin hub --port 4300`);
    } else console.error(`margin hub: ${e.message}`);
    process.exit(1);
  }
  console.log(`${READY_PREFIX} ${hub.url}`);
  console.log(`\n  Margin hub: ${hub.url}\n  Papers and settings: ${hub.configDir}\n  Ctrl+C stops the hub and every paper it started.\n`);
  let stopping = false;
  const stop = (why) => {
    if (stopping) {
      if (why !== 'stdin') process.exit(1); // a second Ctrl+C: don't wait
      return; // stdin closing during a shutdown (the app quitting after its SIGTERM): let it finish
    }
    stopping = true;
    hub.close().then(() => process.exit(0), () => process.exit(1));
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(sig));
  // The program that started the hub (the Mac app) keeps a pipe open on our stdin. When that
  // program goes away, however it goes (quit, crash, force quit), the pipe closes: stop as on
  // SIGTERM, so neither the hub nor its papers outlive it. Anything written to stdin is ignored.
  if (opts.exitWithStdin) {
    process.stdin.on('end', () => stop('stdin'));
    process.stdin.on('error', () => stop('stdin'));
    process.stdin.resume();
  }
  if (opts.open) openBrowser(hub.url);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  // No browser opener installed (a headless Linux box): an 'error' event, which must not crash Margin.
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* headless */ }
}
