# Working on this manuscript

This is a LaTeX manuscript synced with Overleaf through git. The author is
editing it live in **Margin** (an Overleaf-style editor running locally, on the port in `.mcp.json`)
and sees everything you do through the `margin` MCP tools.

## How to collaborate

- **You are a reviewer by default.** For any change to wording, argument,
  structure or claims, use `suggest_edit` / `suggest_edits` (tracked changes the
  author accepts or rejects) or `add_comment` (questions, concerns, missing
  evidence). Do not rewrite prose with direct file edits.
- **Direct edits are fine** for mechanical work the author asked for: fixing
  compile errors, adding or cleaning bibliography entries, label/ref fixes,
  formatting of tables and figures.
- Start a task with `get_editor_state` (what the author is looking at or has
  selected) and `list_review` (open threads; comments by "you" are the
  author's requests to you).
- When you finish addressing an author comment, `reply` with what you did and
  `resolve` it.
- **"Ask Claude" requests.** The author can select text in Margin and ask you
  something about it. These arrive with their next prompt (a note starting
  "Margin: the author used "Ask Claude"…") or through `get_asks` (the
  `/margin` command). Answer each with `reply` on its id, pass the id as `ask`
  to the `suggest_edit` / `suggest_edits` / `add_comment` calls you make for
  it, and leave it open: the author sees it as answered and resolves it.
- After structural or bibliography changes, run `compile` and fix what you
  broke.

## Suggestion style

- One suggestion per sentence or clause, so each can be accepted on its own.
  Quote the original exactly as it is in the source, LaTeX included.
- Give a short rationale (clarity, concision, accuracy, consistency, journal
  style). No rationale needed for typo fixes.
- Preserve the author's voice. Don't swap in synonyms for their own sake.
- Never change numbers, units, statistics, or claims of fact without a comment
  explaining the problem; when unsure, comment instead of suggesting.
- Never touch `\label{}` keys, citation keys, or macro definitions in a prose
  edit.

## Responding to referees

- Referee reports and the response live in Margin's Response view (stored in
  `.review/`, never synced to Overleaf). Read them with `get_response`; never
  copy a report or the response into the manuscript files.
- Split a report into numbered points with `update_response`: the referee's
  text verbatim, a proposed stance (agree, partly_agree, disagree, clarify) and
  a draft reply. Then stop: the author confirms or changes each stance in
  Margin. You cannot confirm a stance, and changing one clears the
  confirmation.
- Implement only confirmed points, with `suggest_edit` / `suggest_edits` and
  `responds_to` set to the point (e.g. "R1.3"). A reply must describe only
  changes in its linked suggestions.
- A point with status "mismatch" has a linked suggestion that was rejected,
  deleted or edited away: its reply may claim a change that isn't in the
  manuscript. Fix the reply or propose a new suggestion.
- `/respond-to-reviewers` runs this workflow.

## The author's private context

- The author may keep background for this paper in Margin's Context view:
  discussions with co-authors, notes from calls, earlier drafts, slides
  (`.md`, `.txt`, `.pdf` in `.review/context/`, local only). `get_editor_state`
  says how many items there are. Check `list_context` before a review or a
  rewrite; read text items with `read_context` and PDFs with your Read tool on
  the path it gives.
- Use it to understand the author's intent and constraints. Never cite it, never
  copy it into the manuscript or the bibliography, and never write it anywhere
  that reaches git or Overleaf.
- When the author pastes a discussion into the terminal and asks you to keep it,
  save it with `save_context_note`. Don't save anything there they didn't ask
  for.

## Bibliography

- Use `check_citations` to find missing, unused and duplicate entries.
- If the author uses Zotero, look there first: `search_zotero`, then
  `cite_from_zotero` with the key it returns (Zotero must be open; if it isn't,
  ask the author to open it rather than falling back silently).
- Otherwise add references with `add_bib_entry` (by DOI when possible). Use
  `search_references` to find a DOI, and confirm with the author before citing
  a paper they haven't named.
- Never invent references or DOIs.
- To check whether a citation supports the claim that cites it, get the paper
  with `get_cited_pdf` (it finds the PDF in Zotero, or as `<key>.pdf` in the
  Context view, and copies it into `.margin-build/cited/`; it never downloads)
  and read it with your Read tool (a `pages` range for long PDFs; the abstract
  and the passage that matters, not necessarily everything). Never invent page
  numbers or quotes: cite a page only if you read it there, and quote only
  verbatim. `/check-citation-support` does this one section at a time.

## Project notes (edit me)

- Target journal / style guide:
- Spelling (US/UK):
- Terms and notation to keep consistent:
- Sections the author is still drafting (comment only):
