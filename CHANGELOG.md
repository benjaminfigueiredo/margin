# Changelog

## Unreleased

- Fix: in a browser that blocks site storage (some private modes, strict cookie settings) a paper
  page did not open at all. Margin keeps only conveniences there (last open file, pane widths),
  so it now carries on without them.
- Security: a paper page now refuses to be shown inside a frame on another site
  (clickjacking), as the hub already did.
- The hub: all your papers on one page. `margin hub` (or `margin` with no folder, run outside a
  paper folder) opens a list of your papers with their state and when you last opened them.
  **Open folder…** adds one (the native folder picker on macOS, a path field elsewhere); **Open**
  starts it if needed and opens it in a new tab; **Stop**, **Remove** (from the list only; files
  are never touched) and **Restart** after an error. Each paper runs as its own Margin server, so
  one crashing does not take the others down, on a port it is given once (4243 and up) and keeps.
  The hub keeps each paper's `.mcp.json` pointing at that port, so Claude Code in a paper folder
  always talks to that paper, and says when an open Claude session must be restarted; a paper not
  yet set up gets **Set up for Claude**. On macOS, **Claude terminal** opens Terminal in the paper
  folder running `claude`. Papers stop with the hub, even if it is killed. The list lives in
  Margin's settings folder (`~/Library/Application Support/margin` on macOS, `~/.config/margin`
  elsewhere, or `MARGIN_CONFIG_DIR`), never in a paper. Programs that start the hub can wait for
  the line `MARGIN_HUB_READY <url>` on stdout. `margin <folder>` and `margin init` are unchanged.
- A Mac app (`mac/`, built with `mac/build-app.sh` or downloaded from the CI run's artifacts): the
  hub in native windows, a window per paper, File → Open Folder… / Open Recent, Finder's Open With
  and Dock drops for paper folders, JavaScript dialogs, downloads with a save panel, and the usual
  Edit/View/Window menus. It uses the Node.js installed on the Mac (20 or later) and the login
  shell's PATH plus TeX's and Homebrew's folders, starts `margin hub` (or uses one already
  running) and stops it on quit, after letting the editors save. Ad-hoc signed: see README for
  opening it past Gatekeeper. The command line is unchanged.
- `margin hub --exit-with-stdin`: the hub (and its papers) also stop when stdin closes, so a
  program that starts the hub with a pipe on its stdin never leaves it running behind, even if
  that program crashes or is force-quit.
- Theme, font size and layout (**Aa**) are now shared by all your papers on this computer, in
  Margin's settings folder, instead of being remembered separately for each port.
- `margin <folder>` warns when the folder's `.mcp.json` points Claude Code at a different port.
- Fix: `margin` crashed right after starting on a computer with no browser opener (`xdg-open`
  missing, as on a headless Linux server) unless `--no-open` was given.
- Fix: every PDF reload after the first (after each compile) threw an error once the new PDF was
  already on screen, and left the previous document and its pdf.js worker in memory. pdf.js 6
  frees a document through its loading task; Margin still called the old method.
- The PDF's text can now be selected and copied, and searched. Drag over the PDF to select
  (a double-click still jumps to the source; a double-click that turns into a drag selects
  instead). The new **Find in PDF** box in the PDF header, or ⌘/Ctrl+F while the PDF has focus,
  counts matches, steps with Enter / Shift+Enter or the arrows, highlights them on the page and
  scrolls to the current one. Search ignores case and extra spaces and finds a phrase that runs
  across a line break. Text layers are built only for pages near the view, so a long paper
  stays responsive. A selection or a search survives a zoom change and a recompile.
- Changes view. **Changes** in the top bar lists what changed since your last sync with
  Overleaf (committed here but not pushed, plus uncommitted edits and new files) or only the
  uncommitted edits, as per-file hunks with the changed words marked; click a line or file name to
  open it there. A co-author's unpulled commits are not shown as your deletions (the panel says
  how many are waiting), and a branch with no upstream compares with your last commit and says
  why. A third tab lists the suggestions you accepted since the last sync, an hour, a day, a week
  or a chosen time, including ones you cleared from the review panel; Margin has no notion of a
  Claude session, and the panel says it is a time filter.
- Diff PDF for resubmissions. **Make diff PDF** (bottom of the Changes panel) runs
  `latexdiff --flatten` against your last sync, last commit or any earlier commit and shows the
  marked-up PDF under a **DIFF** bar with **Back to normal PDF**; the normal PDF is never replaced
  and the diff is built under `.margin-build/diff/`. `latexdiff` is a separate install (full
  MacTeX has it; BasicTeX: `tlmgr install latexdiff`; Ubuntu: `apt install latexdiff`); without
  it the panel says what to install. CI now installs it.
- Security fix: any web page you visited could make Margin act on your paper. The server
  only checked that requests were addressed to localhost, which does not stop a page on
  another site from sending one through your browser, so a malicious or compromised page
  could start a compile, pull from Overleaf, or archive your closed review items. Margin
  now refuses requests that a browser marks as coming from another site, as its WebSocket
  already did. Claude Code and the prompt hook are unaffected.
- File management. **+** in the Files pane makes a new file or folder; right-click a file or
  folder (or use its **⋯**) to rename, delete or reveal it in Finder/Explorer. Drag an image or
  PDF onto the editor and it is uploaded to `figures/` and a `figure` block with
  `\includegraphics`, `\caption{}` and a `\label{fig:...}` is inserted; drag any file onto the
  Files pane to upload it there. Nothing is replaced without asking (a clash in `figures/` gets
  a `-2`), the main document cannot be renamed or deleted, and the open file stays open when
  renamed. Comments and suggestions follow a renamed file. When a file is deleted its review
  items are kept, not deleted: they show as "file missing" under All and attach again if the file
  returns. There is no trash, so the delete dialog says it cannot be undone.
- Fix: the guard that keeps Margin out of `.git`, `.review`, `.claude`, `node_modules` and the
  build folder could be bypassed with a backslash (`.git\hooks\pre-commit`) or, on macOS and
  Windows, a different case (`.GIT`). One check now covers writing, creating, renaming, deleting
  and uploading, and refuses absolute paths too. An oversized upload or malformed JSON now
  gets a JSON error instead of an HTML page. The Main document list in the compile menu now
  follows files you add or rename.
- Find and replace across the whole project (**Find** in the top bar, or Ctrl/⌘+Shift+F). Plain
  text or regular expression, match case, whole word. Results are grouped by file with line
  context; click one to jump to it. Replace all (after a confirmation naming the files and
  match count), replace in one file, or replace a single match; unsaved edits in the editor are
  saved first. If open suggestions or comments quote text a replace would change, the
  confirmation says how many; their cards are then flagged "text changed" rather than rewritten.
- New: reviewer-response mode. In the review panel, **Response** takes a pasted referee
  report; `/respond-to-reviewers` has Claude split it into numbered points (R1.1, R1.2, …)
  with a proposed stance and a draft reply, then stop until you have confirmed or changed
  each stance. Run it again and Claude implements the agreed points as ordinary
  suggestions linked to their point. Each point shows done, pending or **mismatch** — a
  linked suggestion was rejected, deleted or edited away, so the reply may claim a change
  that is not in the manuscript — worked out from the suggestions every time, so rejecting
  or undoing an accept later updates it. Download the response letter as Markdown or LaTeX
  (numbered, the referee quoted, your reply under it). Reports and replies are stored in
  `.review/responses.json`, which never reaches git or Overleaf; the export is a download
  and writes nothing into the paper folder. New MCP tools `get_response` and
  `update_response`; `suggest_edit` / `suggest_edits` take `responds_to`. For a paper set
  up before this version, `margin init` adds the new slash command and leaves your other
  files alone.

- **Ask Claude** on a selection (button next to + Comment, or ⌘/Ctrl + Alt + A): say what
  you want, and your Claude Code terminal picks it up with the next message you send there,
  or with the new `/margin` command. The card shows where it stands (waiting, Claude is on
  it, answered) and links to the suggestions Claude made for it. Margin does not run or
  control Claude: `margin init` installs a small Claude Code hook (local only) that hands
  waiting asks to Claude when you send a message, and does nothing when Margin isn't
  running. Asks are ordinary comments with a marker, so review.json keeps its format.
  Run `margin init` again on papers set up before this, then restart `claude`.
- New MCP tool `get_asks`; `suggest_edit`, `suggest_edits` and `add_comment` take an
  optional `ask` id to link what Claude proposes to the request.
- **Split screen** layout for a short browser window above your Claude terminal: denser
  chrome, outline folded, popovers kept in view. **Aa → Layout**: Auto (switches at 660 px
  window height or less), Standard, or Split screen; saved per browser.
- The status bar shows when Claude last used Margin and how many asks are waiting.
- Dark theme. Margin follows your system's light/dark setting; **Aa** in the top bar
  forces Light or Dark and sets the editor font size. Both are saved in this browser, not
  in the paper. The editor's syntax colours, suggestion and comment highlights, review
  cards and compile log all switch with the theme; the PDF pages stay white.

## 0.2.0 — 2026-10-29

- Fix: on a branch that tracks nothing on Overleaf, the status bar showed no "to pull" count,
  which looked exactly like being up to date. It now says "not tracking Overleaf", and the
  tooltip explains how to get back to `master`.
- The outline panel now takes only the height it needs (up to half the Files pane), so an
  empty outline no longer squeezes the file tree. On a long paper, the word-count breakdown
  keeps its column headings and the Paper total in view while the sections scroll.
- Fix: a pull that conflicted reported success. `git pull --rebase --autostash` can
  fast-forward and then fail to reapply your stashed edits, leaving both versions in the
  file with `<<<<<<<` markers while git still exits 0 — and `behind`/`ahead` both read 0,
  so nothing looked wrong. The next Sync would then have committed those markers and
  pushed them to your co-authors. A conflicted pull is now reported as one, the status bar
  names the conflicted file, and Sync refuses to stage a file that still has markers in it
  — but goes through as soon as you have edited them out, so you are never stuck.
- Sync now lists the files it is about to commit and push before asking for a message. It
  stages everything in the paper folder, which was never shown.
- Fix: `.DS_Store` was in the editor's ignore list but not in the git exclusions, so Sync
  pushed it to Overleaf.
- Syncing from a branch with no upstream now explains that Overleaf supports only one
  branch, instead of passing git's "no tracking information" through to a toast.
- Fix: when the background fetch keeps failing (an expired Overleaf token, offline, revoked
  access) the status bar said "Overleaf · master" with no "to pull", which is
  indistinguishable from being up to date — the same stale-`behind` lie the fetch was added
  to fix. It now says "can't reach Overleaf", with the git error in the tooltip.
- New: Margin tells you when Overleaf has commits you have not pulled. The server fetches every
  3 minutes (only for a git project with a remote) and the UI shows a banner with a "Pull from
  Overleaf" button; if a co-author changed the file you have open, the banner names it. Offline, or a
  remote that needs a password, stays silent. Unsaved edits are saved before the pull, as for Sync.
- Fix: the "N to pull" count in the status bar was stale. It came from the last fetch, and nothing in
  Margin ever fetched, so it said nothing to pull however many commits co-authors made.
- Fix: Margin's own files could be pushed to Overleaf. The guarantee that nothing Margin
  creates reaches your co-authors depended entirely on `.git/info/exclude`, which only
  `margin init` wrote — but `margin <dir>` runs fine on a folder that was never inited, and
  Sync stages everything with `git add -A`. On such a folder, Sync committed and pushed
  `.margin-build/` and `.review/review.json`, which holds your private review history with
  Claude. The server now writes those exclusions itself on startup.
- Fix: accepting a suggestion (or undoing an accept) while the editor had unsaved edits
  could lose work silently. The change was applied to the version on disk, which did not
  include those edits, so the editor and the file diverged with nothing to show it and the
  "changed on disk" banner then overwrote one side or the other. Every review action now
  saves pending edits first, as compiling, commenting and syncing already did.
- Fix: the file watcher no longer swallows external changes that land shortly after an autosave.
  It used to treat any change within 1.5 s of a UI save as its own echo, so a write by Claude, a
  `git pull` or another editor in that window produced no reload and no "changed on disk" notice, and
  the next autosave overwrote it. Self-writes are now recognised by content hash: an event is ours only
  if the file on disk still holds exactly the bytes the UI saved.
- Outline panel under the file tree: parts, chapters, sections (incl. starred forms), figures and tables of the open .tex file, parsed from the editor text so it follows unsaved edits and ignores comments. Click an entry to jump; the section around the cursor is highlighted.
- Undo accept: an accepted suggestion's card now has an "Undo accept" button that puts the
  original text back (refused if the accepted text has been edited since) and reopens the
  suggestion. Author-only: Claude gets no MCP tool for it.
- Word count: the status bar shows the paper's word count (following `\input`/`\include`; excludes comments, math, tables and the preamble); click it for a per-section breakdown with caption and footnote subtotals. Selecting text shows its count live. `GET /api/wordcount`.
- Compile errors and warnings now appear as red/amber markers in the editor gutter on
  the line that failed (open file only, box warnings skipped). Hover shows the message;
  click opens the Logs panel on that entry. A clean compile clears them.
- Review store safety: `.review/review.json` is now version-checked and migrated (a
  file from a newer Margin makes startup fail with a clear message instead of being
  overwritten), the last three versions are kept as `review.json.bak*`, an
  unreadable file is moved aside as `review.json.corrupt-*` instead of being
  replaced, and clearing closed items archives them to `.review/archive.json`.
- Browser tests (Playwright, `npm run test:ui`) now cover the editor UI: boot, save,
  compile log, accept/reject, comments, PDF → source and the review panel toggle.
  `npm test` runs both the API and the UI suites.
- Fix: Margin could previously write (and read) through a symlink inside the paper
  folder that points outside it, overwriting files elsewhere on disk. Paths are
  now resolved through symlinks and refused if they leave the paper folder;
  symlinks that stay inside, and a paper folder reached through a symlink, work
  as before.
- New Claude tools `search_zotero` and `cite_from_zotero`: search the Zotero
  library open on this Mac and copy single entries into the paper's `.bib` under
  their Better BibTeX citation keys. Works with group libraries; falls back to
  Zotero's local API when Better BibTeX isn't installed. Local file paths,
  abstracts, notes and keywords are left out so they don't reach Overleaf.
- Fix: bibliography entries added by Claude wrote `month = {sep}`, which BibTeX
  prints literally; month macros now stay bare (`month = sep`).
- Fix: PDF → source (double-click) failed when the paper folder's path went
  through a symlink (e.g. macOS `/var` → `/private/var`).

## 0.1.1 — 2026-10-28

- Fix: Claude Code could not connect on Macs where `localhost` resolves to IPv6.
  The server now listens on `::1` as well, and `margin init` writes
  `http://127.0.0.1:4242/mcp` into `.mcp.json`.
- Fix: `bin/margin.js` lost its executable bit in the zip ("permission denied: margin").
- `npm test` now starts its own server on a copy of the sample paper.
- README: uninstall instructions.

## 0.1.0 — 2026-10-28

- First version: editor, PDF preview with SyncTeX, compile log, review panel,
  Overleaf sync, MCP tools for Claude Code, `margin init`.
