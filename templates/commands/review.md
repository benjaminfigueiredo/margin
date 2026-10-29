---
description: Review a section (or the current selection) and leave tracked-change suggestions and comments in Margin
argument-hint: [section name, file, or focus — e.g. "Discussion, focus on concision"]
---

Review the manuscript as a careful co-author and journal referee.

Scope: $ARGUMENTS
If no scope is given, call `get_editor_state` and review the selected text, or
the section around the cursor if nothing is selected.

1. Read the relevant source (and nearby sections for context).
2. Check `list_review` so you don't duplicate open threads.
3. Leave feedback in Margin:
   - `suggest_edits` for concrete wording changes: clarity, concision,
     grammar, consistency of terms and notation. One sentence or clause per
     suggestion, with a one-line rationale.
   - `add_comment` for substantive issues: unsupported claims, missing
     citations, logical gaps, unclear figures, things a referee would flag.
4. Finish with a short summary in chat: the main issues, ordered by
   importance, and how many suggestions/comments you left.

Do not edit the files directly.
