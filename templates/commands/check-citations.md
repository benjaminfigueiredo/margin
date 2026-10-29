---
description: Audit citations and the bibliography, and fix what can be fixed safely
---

1. Run `check_citations`.
2. For each **missing** key: look for a likely typo of an existing key first.
   If the paper is clear from context, look for it in my Zotero library with
   `search_zotero` (add it with `cite_from_zotero`), otherwise with
   `search_references` (add it with `add_bib_entry`). Show me the candidate
   before adding it. Never guess.
3. For **duplicate DOIs**: comment on the citing passages proposing one key to
   keep; don't merge silently.
4. For **articles without a DOI**: look them up with `search_references` and
   list proposed DOIs for me to confirm.
5. List **unused** entries but do not delete them.
6. `compile` and report any remaining citation warnings.
