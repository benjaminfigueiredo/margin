# Margin — notes for Claude working on this codebase

Margin is a local, Overleaf-style LaTeX editor. A Node server serves a browser
UI and exposes MCP tools so a Claude Code session can review a manuscript
(tracked-change suggestions, comments, compile, bibliography). The maintainer is
a scientist who uses it on real papers: stability matters more than features.

## Layout

```
bin/margin.js       CLI: `margin [dir]` starts the server, `margin init [dir]` sets up a paper, `margin hub` starts the hub
server/app.js       Express + WebSocket server, REST API for the UI, /mcp endpoint, file watcher
server/hub.js       The hub: paper list (projects.json), one `bin/margin.js <dir> --port P` child per paper, .mcp.json kept on the paper's port
server/localhost.js Host check, cross-site refusal and loopback listeners, shared by app.js and hub.js
server/config.js    Margin's settings folder (outside every paper), atomic JSON writes, shared appearance settings API
server/appearance.js Allowed appearance values (theme, font size, layout); pure, also bundled into the browser
server/macos.js     osascript commands: folder picker, Terminal running claude (folder passed as argv, never in the script)
server/mcp.js       MCP tool definitions (what Claude can do in a paper session)
server/review.js    Suggestion/comment store (.review/review.json) and quote-based anchoring
server/responses.js Referee reports and the point-by-point response (.review/responses.json), owned by ReviewStore
server/responses-mcp.js  MCP tools for the response (get_response, update_response)
server/context.js   Private context (.review/context/ files, .review/context.json descriptions): own narrow path checks
                    (plain names, regular files, no links, O_EXCL creates), its REST routes and the /context/file page
server/context-mcp.js  MCP tools for the context (list_context, read_context, save_context_note)
server/asks.js      "Ask Claude" requests: state, delivery to the prompt hook, Claude activity
server/claude-events.js  Notifications: POST /api/claude/event from the Stop/Notification hooks, asks answered,
                    coalescing; broadcasts `claude-event` (web/src/notify.js shows it)
server/search.js    Project-wide find and replace
server/wordcount.js LaTeX word counter (also bundled into the browser)
server/compile.js   latexmk invocation, TeX log parser, SyncTeX forward/inverse
server/bib.js       BibTeX parser, citation checks, doi.org and Crossref lookups
server/zotero.js    Zotero search/export/attachment paths via Better BibTeX JSON-RPC (local API fallback), port 23119
server/cited-pdf.js get_cited_pdf: a cited paper's PDF from Zotero or the context (<key>.pdf), validated and copied to
                    .margin-build/cited/<key>.pdf so Claude Code can Read it without a prompt
server/git.js       commit / pull --rebase / push for the Overleaf round-trip
server/changes.js   Changes view: read-only `git diff` parsed into per-file hunks (since last sync / HEAD), accepted-since list
server/latexdiff.js latexdiff --flatten between a git ref and the paper, compiled into .margin-build/diff/ (never over the real PDF)
server/project.js   Path safety (all client paths go through Project.abs), file tree, create/rename/delete/upload
server/init.js      `margin init`: .mcp.json, .claude/ files, .git/info/exclude
templates/          CLAUDE.md, slash commands and the hooks (hooks/margin-asks.mjs: UserPromptSubmit;
                    hooks/margin-events.mjs: Stop, Notification) that `margin init` copies into a paper
web/                UI source: CodeMirror 6 editor, pdf.js viewer, review panel (Review | Response | Context views:
                    web/src/review.js, response.js, context.js); hub.html/hub.css/src/hub.js for the hub page
public/             Built UI (committed so users can run without dev dependencies)
examples/           Sample paper used by the test
test/run.mjs        End-to-end API test
test/hub.mjs        End-to-end hub test (child processes, ports, .mcp.json, guards); `npm run test:api` runs both
test/ui/            Playwright browser tests (npm test runs both)
mac/                Mac app: Swift package (AppKit + WKWebView shell that starts `margin hub`), Info.plist,
                    build-app.sh (→ mac/dist/Margin.app, .zip), check-app.sh, tools/make-icon.swift.
                    PageMessages.swift (the `margin` message handler), Notifier.swift (UNUserNotification),
                    SplitScreen.swift (window rects, Terminal via osascript argv), NoteDrop.swift (notes
                    dropped on the app → a paper's context). Built and smoke-tested only on macOS CI
                    (.github/workflows/macos-app.yml)
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
  HTTP and the WebSocket alike. The hub does the same, with the same code
  (`server/localhost.js`), and is stricter on GET. Don't loosen any of this.
- **The hub's CLI and readiness line are an interface** (the Mac app in `mac/`
  starts `margin hub --no-open --port 4242 --exit-with-stdin`, waits for
  `MARGIN_HUB_READY <url>` on stdout, and relies on the hub stopping when its
  stdin pipe closes). Keep them as documented in README.md ("For programs that
  start the hub").
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
- The Mac app bundles Margin's code with `npm ci --omit=dev --omit=optional` (no fsevents, no native
  code in the bundle) and uses the Mac's own Node. A new runtime dependency must work from there:
  `mac/check-app.sh` imports `server/hub.js` from the bundle.
- WKWebView shows no `alert`/`confirm`/`prompt`, downloads nothing and opens no windows by itself:
  `mac/Sources/Margin/BrowserWindow.swift` does. A UI change that relies on another browser feature
  (a file `<input>`, `window.open`, a `download` link, a new ⌘ shortcut) must be checked there.
- The Mac app calls `window.marginBeforeClose()` (web/src/main.js) before closing a paper window or
  quitting, and asks the author when it reports unsaved edits. Keep that function and its contract.
- The pages talk to the Mac app through `window.webkit.messageHandlers.margin.postMessage(m)`
  (web/src/notify.js; the app side is mac/Sources/Margin/PageMessages.swift). It is a contract:
  `{ type: 'notify', title, body, tag }` (a paper page; the app shows it only when that window is
  not in front, same tag replaces) and `{ type: 'splitWithClaude', paper? }` (a paper page, or the
  Papers page with a hub paper id). The app accepts them only from its own windows' main frames on
  the expected origin and ignores unknown types; the page posts only when the handler exists, so
  browsers keep their own behaviour. Changing a message means changing both sides in one commit.
- In the Mac app, never call `alert.runModal()` (or anything else that spins a nested run loop)
  from a Task when a sheet will do: use `await Alerts.sheet(…, on: window)` (Support.swift).
- Claude Code hooks (`templates/hooks/`) must always exit 0, print nothing unless Claude Code
  should read it (only UserPromptSubmit's stdout reaches Claude), and give up within ~2 s when
  Margin is not running. `margin init` merges them by script name and keeps the author's hooks;
  papers set up before a new hook need `margin init` again (the hub shows "Update for Claude"
  when `hooksInstalled()` in server/init.js is false).
- `res.sendFile` with an absolute path refuses any dot-folder in it (Margin itself may live in
  one, e.g. a `.claude/worktrees/` checkout): pass `{ root }` and a relative name.
- Node's global HTTP agent keeps connections alive: a test that restarts a server on the same
  port must not reuse the old socket (`agent: false`).
- Overleaf supports a single branch (`master`) and loses its own comments/track
  changes when pushed to via git; Margin's review layer is deliberately separate.
