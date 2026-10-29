---
description: Work through the comments the author left for Claude in Margin
argument-hint: [optional file to limit to]
---

Call `list_review` with `author: "you"` (limit to $ARGUMENTS if a file is
given). These are the author's notes to you.

For each open comment, in document order:
- If it asks for a change, propose it with `suggest_edit` (or `suggest_edits`),
  then `reply` on the comment naming the suggestion and `resolve` it.
- If it asks a question, answer it with `reply` and leave it open for the
  author.
- If it needs information you don't have (data, a reference, a decision),
  `reply` saying exactly what you need and leave it open.

Then summarize in chat what you did and what is waiting on the author.
