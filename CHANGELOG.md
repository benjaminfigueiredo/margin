# Changelog

## Unreleased

- Fix: the file watcher no longer swallows external changes that land shortly after an autosave.
  It used to treat any change within 1.5 s of a UI save as its own echo, so a write by Claude, a
  `git pull` or another editor in that window produced no reload and no "changed on disk" notice, and
  the next autosave overwrote it. Self-writes are now recognised by content hash: an event is ours only
  if the file on disk still holds exactly the bytes the UI saved.
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
