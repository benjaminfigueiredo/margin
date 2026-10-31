---
description: Check whether each cited paper supports the sentence that cites it (reads the cited PDFs from Zotero or the Context view)
argument-hint: [section name, file, or "selection" — one section at a time]
---

Check whether the papers cited in one part of the manuscript support what the
manuscript says they support.

Scope: $ARGUMENTS
If no scope is given, call `get_editor_state` and use the selected text, or the
section around the cursor if nothing is selected.

**One section at a time.** Every citation means reading a PDF, which is slow and
costly. If the scope has more than about 15 distinct citations, do the first
part, say where you stopped, and let me ask for the rest. Don't re-read a paper
you have already read in this session; a key cited several times is read once.

1. Read the scope in the source. If `list_context` shows my private notes about
   this part, read them: they say what each citation is meant to show. Check
   `list_review` so you don't duplicate open threads.
2. List every `\cite`-family command in scope (`\cite`, `\citep`, `\citet`,
   `\parencite`, `\textcite`, `\autocite`, …, with their keys). For each key,
   note **the claim**: the sentence or clause it supports, as the manuscript
   words it, including any number, direction of effect, species, method or
   scope it states. When one command carries several keys, the claim is
   what they support together; check each paper for its share.
3. Get the PDFs with `get_cited_pdf` (several keys per call). It looks in my
   Zotero and in `<key>.pdf` in the Context view, copies the PDF into the
   paper's `.margin-build/cited/` and gives you the path. It never downloads
   anything. Don't try to fetch papers from the web yourself.
4. Read the cited paper with your Read tool, only as much as the claim needs:
   the abstract first, then the results, table, figure or passage that bears on
   it, and the methods when the claim is about how something was done. For a PDF
   over 10 pages pass a `pages` range. Read the whole paper only when the claim
   cannot be judged otherwise. If a PDF has no readable text (a scan), say so.
5. Judge each citation:
   - **supported**: the paper reports what the manuscript says it does;
   - **partly**: it supports part of it (a weaker effect, one species or
     system instead of several, a different range, correlation worded as
     causation, a result only in a subgroup);
   - **not supported**: it does not report this, or reports the opposite;
   - **can't check (no PDF)**: `get_cited_pdf` found no local PDF, or you could
     not read it.
   Judge only what you read. A paper that fits the topic but where you did not
   find the passage is "partly" or "not supported" with that stated, not
   "supported". Never invent page numbers or quotes: cite a page only if you
   saw it on that page, and put quotes in quotation marks only when they are
   verbatim.
6. Leave `add_comment` only for **partly**, **not supported** and **can't
   check**, anchored on the sentence with the `\cite` in it. Say, in this
   order: what the manuscript claims, what the cited paper actually reports
   (with the page, and a short verbatim quote when it helps), and what would
   fix it (a weaker wording, another citation, the number's real source). For
   "can't check", say there was no PDF and that the author can attach it in
   Zotero or add `<key>.pdf` in the Context view. Also flag, when it is evident
   from what you read:
   - a paper cited for a **primary finding** that is a review, a commentary or
     a methods paper, where the original study should be cited;
   - **the claim cites one paper but the number (or finding) comes from
     another**, naming the paper it comes from if the text shows it.
   Don't comment on "supported" citations.
7. Never edit citations, keys, numbers or text directly. Use `suggest_edit`
   only for a clear wording fix such as hedging an overstated claim ("shows" →
   "suggests"), with the reason in the rationale, and never to change a
   citation key or a number.
8. Finish with a short table in chat: key, verdict, and one line on why for the
   ones that are not "supported" (include the comment's location). Say which
   keys had no PDF, and what you did not get to.

Do not cite or quote my private context in comments. Never fetch from the
internet.
