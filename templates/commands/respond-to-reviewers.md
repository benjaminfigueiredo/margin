---
description: Draft a point-by-point response to the referees in Margin, then (once the author has confirmed the stances) implement the agreed points as suggestions
argument-hint: [optional: points to work on, e.g. "R1.3 R2.1", or "Reviewer 2"]
---

Work on the response to the referees. Scope: $ARGUMENTS (all points if empty).

Call `get_response` first. What you do depends on where things stand.

**No report yet.** If the author pasted a report in this conversation, save it
with `update_response` (`report`: reviewer label such as "Reviewer 1", the full
text verbatim). Otherwise ask them to paste it in Margin (Review panel →
Response → + Report) and stop.

**A report that is not split into points yet.** Read the manuscript sections it
refers to, then call `update_response` with one point per referee comment:
- `referee_text`: the comment, quoted verbatim (merge nothing, drop nothing).
- `stance`: your proposal — `agree` (we change the manuscript), `partly_agree`
  (we change part of it), `disagree` (we explain why not), `clarify` (an
  explanation or thanks, no change needed).
- `reply`: a courteous draft. For agree/partly_agree, say what will change and
  where (section names, not line numbers). Never promise data, analyses or
  experiments the author has not mentioned; write `[author: …]` where only they
  can fill something in.

Then **stop**. Give the author a short table in chat (point, stance, one line
why) and ask them to confirm or change each stance in Margin's Response view —
deciding what to concede and what to rebut is their call. Do not suggest any
edits in this run.

**Points whose stance the author has confirmed.** For each confirmed `agree` /
`partly_agree` point without a linked suggestion, in order:
1. Make the change with `suggest_edit` / `suggest_edits`, passing
   `responds_to` with the point's number (e.g. "R1.3"). Follow the usual
   suggestion style: one sentence or clause per suggestion, with a rationale.
2. Revise the reply with `update_response` so it describes exactly the changes
   you linked — nothing more.
For confirmed `disagree` / `clarify` points, polish the reply only. Skip points
that are still unconfirmed and list them at the end.

**Points with status mismatch** (a linked suggestion was rejected, deleted, or
its text changed): the reply claims a change the manuscript does not contain.
Tell the author, and either propose a new suggestion (if they still agree) or
revise the reply. Never leave a reply that describes a change that is not
there.

Finish with a short summary: points drafted, implemented, waiting for the
author, and any mismatches.

Never write the referee reports or the response into the manuscript files:
they are private and live only in Margin's `.review/` folder.
