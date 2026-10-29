---
description: Handle what the author asked you with "Ask Claude" in Margin
---

Call `get_asks`. These are requests the author sent you from the editor, each
anchored to the text they selected.

For each one, oldest first:
- If it asks for a change, propose it with `suggest_edit` / `suggest_edits`
  (or `add_comment` for a concern), passing the ask's id as `ask`, then
  `reply` on the ask with a one-line summary.
- If it asks a question, answer it with `reply`. Use `show_location` if the
  answer is about another passage.
- If you need something you don't have (data, a reference, a decision),
  `reply` saying exactly what.

Leave the asks open: the author resolves them in Margin. Don't rewrite prose
with direct file edits. Finish with a short summary in chat.
