# Changelog

## Unreleased

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
