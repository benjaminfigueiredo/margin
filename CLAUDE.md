# Margin — notes for Claude working on this codebase

Margin is a local, Overleaf-style LaTeX editor. A Node server serves a browser
UI and exposes MCP tools so a Claude Code session can review a manuscript
(tracked-change suggestions, comments, compile, bibliography). The maintainer is
a scientist who uses it on real papers: stability matters more than features.

## Layout

```
bin/margin.js       CLI: `margin [dir]` starts the server, `margin init [dir]` sets up a paper
server/app.js       Express + WebSocket server, REST API for the UI, /mcp endpoint, file watcher
server/mcp.js       MCP tool definitions (what Claude can do in a paper session)
server/review.js    Suggestion/comment store (.review/review.json) and quote-based anchoring
server/responses.js Referee reports and the point-by-point response (.review/responses.json), owned by ReviewStore
server/responses-mcp.js  MCP tools for the response (get_response, update_response)
server/asks.js      "Ask Claude" requests: state, delivery to the prompt hook, Claude activity
server/search.js    Project-wide find and replace
server/wordcount.js LaTeX word counter (also bundled into the browser)
server/compile.js   latexmk invocation, TeX log parser, SyncTeX forward/inverse
server/bib.js       BibTeX parser, citation checks, doi.org and Crossref lookups
server/zotero.js    Zotero search/export via Better BibTeX JSON-RPC (local API fallback), port 23119
server/git.js       commit / pull --rebase / push for the Overleaf round-trip
server/project.js   Path safety (all client paths go through Project.abs), file tree, create/rename/delete/upload
server/init.js      `margin init`: .mcp.json, .claude/ files, .git/info/exclude
templates/          CLAUDE.md, slash commands and the prompt hook that `margin init` copies into a paper
web/                UI source: CodeMirror 6 editor, pdf.js viewer, review panel
public/             Built UI (committed so users can run without dev dependencies)
examples/           Sample paper used by the test
test/run.mjs        End-to-end API test
test/ui/            Playwright browser tests (npm test runs both)
```

## Commands

```bash
npm install          # full install incl. dev deps (esbuild, CodeMirror, pdf.js)
npm run build        # bundle web/ into public/ — required after any change in web/
npm test             # starts a throwaway server on a copy of examples/sample-paper and runs all checks
node bin/margin.js examples/sample-paper --no-open   # (use a copy, it modifies files)
```

The test needs latexmk, bibtex and synctex on PATH.

## Rules

- **Run `npm test` before every commit.** If you change anything in `web/`, run
  `npm run build` and commit `public/` in the same commit. CI fails if `public/`
  is out of date.
- **Never let Margin write outside the paper folder.** Every client-supplied path
  must go through `Project.abs()`.
- **Nothing Margin creates may reach Overleaf.** Local-only paths are listed in
  `server/init.js` (`LOCAL_ONLY`) and ignored in `server/project.js` (`IGNORED`).
  Keep both lists in sync when adding new local files.
- **The server listens on 127.0.0.1 and ::1 only**, checks the Host header, and
  refuses requests a browser marks as cross-site (Origin / Sec-Fetch-Site), on
  HTTP and the WebSocket alike. Don't loosen any of this.
- **The review store has one writer**: the server process. MCP tools and the UI
  both go through `ReviewStore`; don't write `.review/review.json` directly.
- **MCP tool changes are user-facing.** Tool names and descriptions are what
  Claude sees in paper sessions; keep descriptions precise, update the table in
  README.md, and keep `templates/CLAUDE.md` consistent with the tools.
- Keep dependencies minimal. No frontend framework; the UI is plain ES modules
  bundled by esbuild.
- Record user-visible changes in CHANGELOG.md and bump the version in
  package.json for releases.

## Gotchas already hit

- BibTeX refuses to start if `max_print_line` ≥ its buffer size; compile.js uses 10000.
- `.margin-build` is a dot-folder: `res.sendFile` needs `{ dotfiles: 'allow' }`.
- On macOS `localhost` may resolve to `::1`; the server listens on both, and
  `.mcp.json` uses `127.0.0.1`.
- `bin/margin.js` must stay executable (git tracks the mode).
- Overleaf supports a single branch (`master`) and loses its own comments/track
  changes when pushed to via git; Margin's review layer is deliberately separate.
