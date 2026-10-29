# Margin

An Overleaf-style LaTeX editor that runs on your machine, syncs with your
Overleaf project through git, and lets **Claude Code act as a reviewer**:
tracked-change suggestions you accept or reject, margin comments, compile
fixes, and bibliography work, all visible live in the editor.

```
Overleaf ⇄ git ⇄ your local repo ⇄ Margin server ⇄ browser UI
                                          ⇅ MCP
                                     Claude Code
```

- **Editor**: file tree, LaTeX editor, PDF preview, compile log.
- **PDF ⇄ source**: double-click the PDF to jump to the source; **→ PDF** (⌘/Ctrl+Alt+→) jumps the other way. Drag over the PDF to select and copy its text.
- **Find in PDF**: the box in the PDF header searches the compiled text, with a match count, next/previous, and highlights on the page.
- **Review panel**: Claude's suggestions appear inline as strike-through + insertion and as cards with Accept / Reject / Edit / Reply. Your own comments ("Claude: tighten this?") are requests Claude picks up.
- **Ask Claude**: select text, press **Ask Claude**, say what you want; your Claude terminal picks it up with your next message, and the card shows *waiting → Claude is on it → answered*, linked to the suggestions Claude made for it.
- **Split screen**: a compact layout for a short browser window with your Claude terminal underneath.
- **Sync with Overleaf**: one button commits, pulls Overleaf's changes (rebase), and pushes.

Nothing Margin or Claude needs is ever pushed to Overleaf: review threads, build
output and Claude settings are listed in `.git/info/exclude`, a local-only
ignore file. Co-authors only ever see the manuscript files.

---

## 1. Install (once)

You need:

| | macOS | Check |
|---|---|---|
| Node.js 20+ | `brew install node` | `node -v` |
| TeX with latexmk + synctex | [MacTeX](https://tug.org/mactex/) (full) | `latexmk -v` |
| Claude Code | see claude.com/claude-code | `claude --version` |

Then clone Margin somewhere it can stay (not an iCloud-synced folder) and link it:

```bash
git clone https://github.com/<you>/margin ~/Developer/margin
cd ~/Developer/margin
npm install --omit=dev    # the UI is already built into public/
npm link                  # puts the `margin` command on your PATH
```

**Updating:** `cd ~/Developer/margin && git pull && npm install --omit=dev`.
Changes are listed in CHANGELOG.md.

To try it before touching a real paper:

```bash
cp -r examples/sample-paper ~/margin-demo && cd ~/margin-demo && git init -q && git add -A && git commit -qm init
margin init . && margin .        # then, in another terminal: cd ~/margin-demo && claude
```

## 2. Connect a manuscript to Overleaf (once per paper)

1. In Overleaf, generate a Git authentication token in **Account Settings**
   (overleaf.com/user/settings). Copy it.
2. In the project, open **Integrations → Git** in the left sidebar and copy
   the clone URL (`https://git.overleaf.com/<project-id>`, where the ID is the
   number in your project's URL).
3. Clone and let git remember the token:

```bash
git config --global credential.helper osxkeychain   # macOS: store the token in Keychain
git clone https://git.overleaf.com/<project-id> my-paper
# username: git    password: <your token>
```

4. Set it up for Margin and Claude:

```bash
margin init my-paper
```

This adds (all local-only): `.mcp.json` (connects Claude Code to Margin),
`.claude/settings.local.json` (approves the Margin tools so Claude doesn't ask
each time, and adds the "Ask Claude" prompt hook), `.claude/hooks/margin-asks.mjs`
(that hook), `.claude/CLAUDE.md` (how Claude should review — **edit the "Project
notes" section** with your journal, spelling and terminology) and five slash
commands.

Already set up a paper with an older Margin? Run `margin init my-paper` again: it
keeps your files and adds what is new. Restart `claude` afterwards.

## 3. Daily use

```bash
margin my-paper           # terminal 1: opens http://localhost:4242
cd my-paper && claude     # terminal 2: Claude Code, connected to Margin
```

The first time, Claude Code asks you to trust the folder; check the connection
with `/mcp` (you should see `margin` connected).

Things to say to Claude:

- `/review Discussion, focus on concision and hedging`
- `/review` (reviews whatever you've selected in the editor)
- `/address-comments` (works through the comments you left for it)
- `/margin` (handles what you sent with **Ask Claude**; see below)
- `/check-citations`
- `/fix-compile`
- `/respond-to-reviewers` (after pasting a referee report in the Response view; see below)
- "Look at my selection — is this claim supported by the results section?"
- "Add Smith et al. 2021 on copepod heat stress to the bibliography and cite it here"
- "Cite my Zotero paper on heatwaves and copepod fecundity here"

In the editor:

| | |
|---|---|
| Recompile | ⌘/Ctrl + Enter (or ⌘/Ctrl + S) |
| Ask Claude about the selection | ⌘/Ctrl + Alt + A |
| Comment on selection (for Claude or yourself) | ⌘/Ctrl + Alt + C |
| Source → PDF | ⌘/Ctrl + Alt + → |
| PDF → source | double-click the PDF |
| Select and copy PDF text | drag over the PDF (a double-click also jumps to the source) |
| Find in the PDF | the box in the PDF header, or ⌘/Ctrl + F with the PDF focused; Enter / Shift+Enter for next / previous, Esc to clear |
| Compiler / main file / auto-recompile | ▾ next to Recompile |
| Light / dark theme, editor font size, layout | **Aa** in the top bar (saved per browser) |
| New file / folder | **+** in the Files pane |
| Rename, delete, reveal in Finder/Explorer | right-click a file or folder (or its **⋯**) |
| Add a figure | drag an image or PDF onto the editor: it goes to `figures/` and a `figure` block is inserted |
| Add any file | drag it onto the Files pane (onto a folder to put it there) |

Use **Sync with Overleaf** when you want your accepted changes on Overleaf, and
before starting a session to pull co-authors' edits.

### Split screen with your Claude terminal

Put the browser in the top half of the screen and your `claude` terminal (in the
paper folder) in the bottom half. Margin switches to its compact **Split screen**
layout by itself when the window is 660 px tall or less; choose it, or
**Standard**, under **Aa → Layout**.

1. Select a passage and press **Ask Claude** (⌘/Ctrl + Alt + A). Type what you
   want, or pick a starter (Concise, Check claim, …), and send with ⌘/Ctrl + Enter.
   The card reads **Waiting for Claude**.
2. In the terminal below, type `/margin` and press Enter. Any other message works
   too: the ask rides along with it. The card turns to **Claude is on it**.
3. Claude answers on the card and makes its suggestions as tracked changes,
   linked from the card (click a link to jump to it). The card reads **Claude
   answered**. Accept or reject the suggestions, reply on the card if you want
   more (it goes back to waiting for your next message), and **Resolve** it when
   you're done.

The status bar shows when Claude last used Margin and how many asks are waiting
(click it to copy `/margin`). Margin never types into or controls your terminal:
the hand-over happens when you send a message, through a Claude Code hook that
`margin init` installs. If Margin isn't running, the hook does nothing.

## What Claude can do (MCP tools)

| Tool | |
|---|---|
| `get_editor_state` | Open file, cursor line, selected text |
| `suggest_edit`, `suggest_edits` | Tracked-change suggestions (file untouched until you accept); `responds_to` links one to a referee point |
| `revise_suggestion` | Change a suggestion after your feedback |
| `add_comment`, `reply`, `resolve` | Comment threads |
| `list_review` | Open threads, including your comments for Claude |
| `get_asks` | What you sent with **Ask Claude** that is still waiting for an answer (`suggest_edit`, `suggest_edits` and `add_comment` take its id as `ask` to link their result to it) |
| `compile` | Recompile; returns errors/warnings with file:line |
| `show_location` | Scroll your editor and PDF to a spot |
| `check_citations` | Missing / unused / duplicate keys and DOIs |
| `search_references`, `add_bib_entry` | Crossref search; add BibTeX by DOI (deduplicated) |
| `search_zotero`, `cite_from_zotero` | Search your Zotero library; copy one entry into the .bib by its citation key |
| `list_files`, `read_file` | Project files |
| `get_response` | Referee reports and the point-by-point response, with each point's status (done / pending / mismatch) |
| `update_response` | Split a report into points; propose stances (you confirm them) and draft replies; link suggestions |

Claude Code's own file tools still work for direct edits; the editor reloads
when a file changes on disk.

### Zotero

If you keep your references in Zotero, Claude can search your library and copy
just the entries you cite into the paper's `.bib`. Zotero stays your master
library, and the `.bib` on Overleaf holds only what the paper uses. Zotero must
be open during the session. Install the
[Better BibTeX](https://retorque.re/zotero-better-bibtex/) add-on (recommended:
its citation keys are used, and group libraries are searched too). Without it,
Margin falls back to Zotero's own local API (Settings → Advanced → "Allow other
applications on this computer to communicate with Zotero"), which only covers
My Library. Local file paths, abstracts, notes and keywords are not copied.

### Responding to referees

Switch the review panel to **Response**, press **+ Report** and paste a referee
report (one per reviewer). Then run `/respond-to-reviewers` in Claude Code:

1. Claude splits the report into numbered points (R1.1, R1.2, …), each quoting
   the referee, with a proposed stance (agree, partly agree, disagree, clarify)
   and a draft reply — and stops there.
2. You confirm or change each stance in the Response view. What to concede and
   what to rebut is your call; Claude cannot confirm a stance, and won't edit
   anything for a point until you have.
3. Run `/respond-to-reviewers` again. Claude implements the agreed points as
   ordinary suggestions, each linked to its point, and updates the replies.
4. Accept or reject the suggestions as usual (also from the Response view).

Each point shows a status worked out from its linked suggestions: **done**
(reply written, every linked suggestion accepted), **pending** (stance not
confirmed, no reply yet, or suggestions still open) or **mismatch** (a linked
suggestion was rejected, deleted, or its text was edited away — the reply may
claim a change that is not in the manuscript). Mismatches are flagged at the top
of the view and on the Response tab.

**.md** and **.tex** download the response letter: numbered, each referee point
quoted with your reply under it (the .tex version treats both as plain text and
escapes characters such as % and $). Reports and responses are stored in
`.review/responses.json` — on your computer only, never committed or pushed to
Overleaf — and the export is a download, not a file in the paper folder.

## How it works

- **Suggestions are anchored to quoted text**, not line numbers, so they
  survive edits elsewhere in the file. If the quoted text itself is edited away,
  the card is flagged "text changed" and can only be rejected.
- Review threads live in `.review/review.json` in the paper folder (local, not
  synced). Back it up if the review history matters to you.
- Compiles run `latexmk` into `.margin-build/` with SyncTeX on. Use the same
  compiler as your Overleaf project (Menu → Compiler). Overleaf's TeX Live may
  be newer or older than yours; if something compiles on one but not the other,
  that's the usual reason.
- The server only listens on `127.0.0.1` and rejects requests addressed to
  other hostnames.

## Limits and good habits

- **Overleaf comments and track changes are not synced.** Git can't carry them,
  and Overleaf warns that pushing from git can displace them. Don't rely on
  Overleaf's review features for files you also edit here.
- **Sync often.** Overleaf has one branch. If a co-author changed the same lines,
  Sync stops, keeps your commit locally, and tells you which files conflict.
  Resolve with git (or ask Claude: "resolve the merge conflict in main.tex"),
  then sync again.
- One person per local copy; this isn't a real-time multi-user editor.
- PDF text is the text the PDF carries, so a word split by a line-end hyphen is two pieces to
  PDF search ("underes-" and "timate"), and text drawn as an image or outlined (some figures)
  can be neither selected nor found. Search highlights can sit a character off on long lines
  in some fonts; the match count and the jump are exact. A recompile keeps your selection
  only if the text under it did not change.

## Changing Margin itself

Open Claude Code in the Margin folder (`cd ~/Developer/margin && claude`) and
describe the change. `CLAUDE.md` in this repo tells Claude how the code is
organised and the rules to follow. In particular, Claude runs `npm test` before
committing, and rebuilds the UI when it changes `web/`. GitHub runs the same
test on every push (`.github/workflows/test.yml`).

To try a change on a paper before committing, stop and restart `margin`; it
always runs the code in this folder.

## Uninstall

Margin runs only while `margin` is open in a terminal. It installs no
background service and nothing system-wide except the `margin` command.

**Remove Margin from a paper** (run inside the paper folder):

```bash
rm -rf .review .margin-build .mcp.json
rm -rf .claude    # only if Margin created it; see the note below
```

Then open `.git/info/exclude` and delete the block under
`# Margin (local only, never pushed to Overleaf)`.

If you had your own `.claude/` folder before running `margin init`, don't delete
it. Instead remove only what Margin added:
- `.claude/CLAUDE.md`
- `.claude/commands/review.md`, `address-comments.md`, `check-citations.md`, `fix-compile.md`, `margin.md`
- `.claude/hooks/margin-asks.mjs`
- in `.claude/settings.local.json`: `"margin"` from `enabledMcpjsonServers`, `"mcp__margin__*"` from `permissions.allow`, and the `UserPromptSubmit` hook that runs `margin-asks.mjs`

`.review/review.json` holds your review threads. Copy it somewhere first if you
want to keep that history.

**Remove the program:**

```bash
npm uninstall -g margin-latex   # removes the `margin` command
rm -rf /path/to/margin          # the unzipped folder
```

**What stays:** your manuscript and its git history. Changes you synced are
ordinary commits in your Overleaf project, and removing Margin doesn't touch
them. Node, MacTeX and Claude Code were installed separately; uninstall them
separately if you want.

## Files

```
bin/margin.js       CLI (margin, margin init)
server/app.js       HTTP + WebSocket server, file watcher
server/mcp.js       Claude's tools (MCP over HTTP at /mcp)
server/review.js    suggestion/comment store and text anchoring
server/asks.js      "Ask Claude": hand-over to the Claude terminal, Claude activity
server/compile.js   latexmk, log parsing, SyncTeX
server/bib.js       BibTeX parsing, citation checks, DOI/Crossref
server/zotero.js    Zotero library search and export (Better BibTeX / local API)
server/git.js       commit / pull --rebase / push
server/init.js      margin init
templates/          CLAUDE.md, slash commands and the prompt hook installed by init
web/                UI source (CodeMirror 6, pdf.js) → built into public/
test/run.mjs        end-to-end test (npm test)
CLAUDE.md           guide for Claude when working on Margin's code
CHANGELOG.md        what changed in each version
```
