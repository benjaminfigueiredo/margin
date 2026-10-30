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
- **Changes**: what differs from your last sync (or last commit) as clickable hunks, the suggestions you accepted since a time, and a one-click **diff PDF** with every change marked, for a resubmission.

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
| `latexdiff` (only for the diff PDF) | included in full MacTeX; with BasicTeX: `sudo tlmgr install latexdiff` | `latexdiff --version` |
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

Working on several papers? Start the **hub** instead (`margin hub`, see
[Several papers: the hub](#several-papers-the-hub)): one page lists your papers
and runs each one on its own port, so you don't need a terminal and a `--port`
per paper.

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
| Light / dark theme, editor font size, layout | **Aa** in the top bar (shared by all your papers on this computer) |
| New file / folder | **+** in the Files pane |
| Rename, delete, reveal in Finder/Explorer | right-click a file or folder (or its **⋯**) |
| Add a figure | drag an image or PDF onto the editor: it goes to `figures/` and a `figure` block is inserted |
| Add any file | drag it onto the Files pane (onto a folder to put it there) |

Use **Sync with Overleaf** when you want your accepted changes on Overleaf, and
before starting a session to pull co-authors' edits.

### Several papers: the hub

```bash
margin hub                # opens http://127.0.0.1:4242/ with the list of your papers
```

Running `margin` with no folder does the same when the current folder has no
`.tex` file in it (in a paper folder it opens that paper, as before).

- **Open folder…** adds a paper: on macOS it shows the usual folder picker,
  elsewhere you type the path. It must be the folder that holds the paper's main
  `.tex` file (not your home folder, not `/`).
- **Open** starts the paper if needed and opens it in a new tab. Each paper runs
  as its own Margin server, on a port it is given the first time (4243, 4244, …)
  and keeps for good. A paper that crashes is marked **Error** with the reason and
  a **Restart** button; the others carry on. **Stop** stops one paper;
  **Remove** takes it off the list (its files are not touched).
- **Claude Code stays on the right paper.** Claude finds Margin through the URL in
  the paper's `.mcp.json`. The hub keeps that URL on the paper's own port: if it
  has to change it (a paper set up with an older `margin init` points at 4242,
  which is now the hub), it says so, and a Claude session already open in that
  folder must be restarted (`/exit`, then `claude`). Nothing else in `.mcp.json`
  is changed. A paper never set up for Claude gets a **Set up for Claude** button,
  which runs `margin init` with the right port. On macOS, **Claude terminal**
  opens Terminal in the paper folder and runs `claude` (the first time, macOS
  asks whether Margin may control Terminal).
- If a paper's port is taken (for example by `margin my-paper` still running in a
  terminal), the hub says so instead of starting a second copy.
- A paper opened from the hub has a **‹ Papers** link in its top bar.
- Theme, font size and layout (**Aa**) follow you from paper to paper.
- **Ctrl+C** in the hub's terminal stops the hub and every paper it started.
  Papers never outlive the hub, even if it is killed.

The list, the shared settings and each paper's server log live in Margin's own
settings folder, never in a paper folder: `~/Library/Application Support/margin/`
on macOS, `~/.config/margin/` elsewhere (or `$XDG_CONFIG_HOME/margin`; set
`MARGIN_CONFIG_DIR` to use another folder). The only thing the hub writes in a
paper folder is the margin entry in `.mcp.json` (and what `margin init` writes,
when you press **Set up for Claude**), all of it kept out of git.

`margin <folder>` still works on its own, on port 4242 or `--port`. Don't run it
and the hub on the same paper at once; if `.mcp.json` names another port,
`margin <folder>` warns that Claude will not reach it.

#### For programs that start the hub (a native app, scripts)

- Start: `margin hub [--port N] [--no-open] [--exit-with-stdin]` (default port
  4242). The process is the hub; stop it with SIGTERM (or SIGINT), which stops
  every paper it started and then exits with status 0.
- `--exit-with-stdin`: the hub also stops that way when its stdin reaches end of
  file. Give it a pipe and keep the write end open for as long as you want the
  hub; when your program exits, however it exits (a crash, a force quit), the
  pipe closes and the hub and its papers stop. Anything written to the pipe is
  ignored. Don't use it with stdin on `/dev/null`: the hub would stop at once.
  (`margin <folder>` refuses this option.)
- Ready: once it is listening, the hub prints one line to stdout,
  `MARGIN_HUB_READY http://127.0.0.1:<port>/`. Other output is for people. If the
  port is taken it prints a message to stderr and exits with status 1 (the message
  says when the port holds a hub already).
- The page at `/` is the paper list. **Open** is a normal link with
  `target="_blank"`: to `http://127.0.0.1:<paper-port>/` when the paper is
  running, otherwise to the hub's `/open/<id>`, which starts the paper and then
  navigates to the paper's URL. A paper's **‹ Papers** link is a plain link to
  the hub's `/`.
- The hub only answers on 127.0.0.1 and ::1, only to requests addressed to
  `127.0.0.1`, `localhost` or `[::1]` on its port, and only to its own page (or to
  requests with no `Origin` and no cross-site `Sec-Fetch-Site`, such as curl).
  Pages from other sites and from the papers themselves are refused; only `/`
  can be reached by a link from elsewhere, and no page can frame it.
  `GET /api/hub` answers `{"hub": true, ...}`; `GET /api/papers` lists the papers
  with their `state` (`stopped`, `starting`, `running`, `error`), `port`, `url`
  and `pid`.

### The Mac app

`Margin.app` is the hub in its own windows instead of a browser tab and a
terminal: double-click it, and the **Papers** window lists your papers; each paper
opens in a window of its own (one per paper; opening it again brings that window
forward), with its size and place remembered. It is a small native shell (Swift,
AppKit and WebKit, no third-party code) around exactly what `margin hub` serves,
so everything in [the hub](#several-papers-the-hub) applies.

- **It needs Node.js 20 or later and TeX installed on the Mac** (see
  [Install](#1-install-once)); the app contains Margin itself but no Node, so
  Node's security updates keep coming from Homebrew or nodejs.org. It finds Node
  in your login shell's PATH, Homebrew, MacPorts, nvm, Volta, asdf, mise, nodenv
  and fnm, and says how to install it if there is none. The papers it runs find
  latexmk, git and latexdiff on your login shell's PATH plus `/Library/TeX/texbin`
  and Homebrew's folders (an app opened from Finder gets none of these by itself).
- **File → Open Folder…** (⌘O) adds a paper folder and opens it; **File → Open
  Recent** lists the hub's papers. In Finder, **Open With → Margin** on a folder,
  or dropping a folder on Margin's Dock icon, does the same.
- **Window → Papers** (⇧⌘P), or clicking the Dock icon, brings the list back;
  closing it doesn't quit. **View** has Reload (⌘R) and zoom (⌘+, ⌘−, ⌘0).
  Links to other sites (doi.org, Crossref, this README) open in your browser.
- **Quitting Margin** lets each editor save, then stops the hub and every paper it
  started. If the app crashes or is force-quit, the hub notices (its stdin closes)
  and stops too. If a hub was already running on port 4242 (`margin hub` in a
  terminal), the app uses it and leaves it running when it quits.
- If the hub cannot start (port 4242 taken by `margin <folder>`, for example) the
  app says why. The hub's output is in `~/Library/Logs/Margin/hub.log`.
- The first time you press **Claude terminal**, macOS asks whether Margin may
  control Terminal. If you said no, allow it in System Settings → Privacy &
  Security → Automation → Margin.

The command line keeps working exactly as before, with or without the app.

**Getting the app.** Either download it from GitHub: every push builds it (the
*macOS app* workflow under the repository's **Actions** tab); open a run and
download **Margin-app** under *Artifacts*, unzip until you have `Margin.app`
(GitHub wraps the zip in another one), and move it to Applications. Or build it
on your Mac, with Xcode or the Command Line Tools (`xcode-select --install`):

```bash
cd ~/Developer/margin
mac/build-app.sh            # → mac/dist/Margin.app and mac/dist/Margin.zip
mac/build-app.sh --universal   # Apple silicon and Intel in one app
```

The app holds a copy of Margin, so rebuild (or download) it after updating Margin.

**Opening it the first time (Gatekeeper).** The app is signed "ad hoc", not with an
Apple Developer certificate, so macOS refuses to open a downloaded copy at first
("Apple could not verify “Margin” is free of malware"). On current macOS
(Sequoia and later) right-click → Open is no longer enough:

1. Double-click Margin.app and dismiss the warning (**Done**).
2. Open System Settings → Privacy & Security, scroll to *Security*, and press
   **Open Anyway** next to "Margin was blocked". Confirm with your password.
3. Open Margin again and press **Open Anyway**. macOS remembers the choice.

A copy you built yourself is not quarantined and opens directly. To skip the steps
for a downloaded copy you trust (or if macOS calls it "damaged"), run
`xattr -dr com.apple.quarantine /Applications/Margin.app`.
Opening without warnings would take a membership of the Apple Developer Program, a
*Developer ID Application* certificate to sign with (`codesign --options runtime
--timestamp`, the hardened runtime, plus the `com.apple.security.automation.apple-events`
entitlement so Claude terminal can still ask Terminal), and notarizing each build with Apple
(`xcrun notarytool submit … --wait`, then `xcrun stapler staple Margin.app`); the
build script and the CI workflow are where that would go.

To remove the app: quit it and drop it in the Trash. It also leaves its log
(`~/Library/Logs/Margin/`), its window positions (`defaults delete
io.github.benjaminfigueiredo.margin`) and WebKit's data for it (folders named
`io.github.benjaminfigueiredo.margin` in `~/Library/WebKit/` and `~/Library/Caches/`).

### What changed, and a diff PDF for resubmissions

**Changes** in the top bar opens a panel over the PDF (the same place as Logs and Find):

- **Since last sync** lists every file that differs from what Overleaf had at your
  last sync: edits committed here but not yet pushed, edits not yet committed, and
  new files. Added and deleted lines are shown with the words that changed marked;
  click a line (or a file name) to open the file at that spot. If a co-author has
  pushed commits you have not pulled, their changes are *not* shown as if you had
  deleted them; the panel says how many are waiting.
- **Uncommitted** shows only the edits not yet committed.
- **Accepted suggestions** lists the suggestions you accepted in Margin since a time:
  the last sync, an hour or a day ago, or a time you pick. Margin keeps no record of
  Claude *sessions*, so this is a filter on when each suggestion was accepted, not
  "what Claude did this session". Suggestions you have cleared from the review panel
  are included.
- If the branch has no upstream (a paper with no remote, or a branch that tracks
  nothing on Overleaf), there is no "last sync" to measure from: the panel says so
  and compares with your last commit instead.

**Make diff PDF** (bottom of the panel) runs `latexdiff` between an earlier version
and the paper as it is now, and shows the result in the PDF pane under a **DIFF**
bar: added text blue, deleted text red, like Word's Track Changes. Compare with your
last sync (the default), your last commit, or any earlier commit in the list (an
Overleaf version, or a tag such as the submitted manuscript). **Back to normal PDF**
returns; the normal PDF and its build are never replaced, and the diff PDF is built
in `.margin-build/diff/` (never synced). Papers split over several files are handled
with `latexdiff --flatten`, which also follows text moved between files. Things it
cannot compare (an `\input` in the preamble) are listed under the DIFF bar rather than
silently left unmarked. Some documents confuse `latexdiff` (unusual packages or
macros inside math, for example); the panel then shows LaTeX's first errors.

`latexdiff` is a separate program: full MacTeX includes it, BasicTeX does not
(`sudo tlmgr install latexdiff`), and on Ubuntu/Debian it is its own package
(`sudo apt install latexdiff`). Without it the panel says so instead of failing.
Margin marks changes with latexdiff's underline/strike-through style when the `ulem`
and `listings` packages are installed (they are in full MacTeX), and with its
coloured-font style otherwise, so a minimal TeX install still works.

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
when a file changes on disk. If you have unsaved edits in that file, the change on
disk is merged into them when it is elsewhere in the file; when both touch the same
text, the editor keeps yours, saves nothing, and asks which version to keep.

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
test on every push (`.github/workflows/test.yml`), and builds and smoke-tests
the Mac app on macOS (`.github/workflows/macos-app.yml`).

To try a change on a paper before committing, stop and restart `margin`; it
always runs the code in this folder.

## Uninstall

Margin runs only while `margin` (or `margin hub`, or the Mac app) is open. It
installs no background service and nothing system-wide except the `margin`
command. Its settings folder (the hub's list of papers, the shared appearance
settings and the papers' logs) is `~/Library/Application Support/margin/` on macOS
and `~/.config/margin/` elsewhere; delete it to forget them.

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
bin/margin.js       CLI (margin, margin init, margin hub)
server/app.js       HTTP + WebSocket server, file watcher
server/hub.js       the hub: list of papers, one Margin server per paper as a child process
server/localhost.js localhost-only guards (Host, cross-site requests) shared by the paper server and the hub
server/config.js    Margin's settings folder: shared appearance settings, atomic JSON writes
server/macos.js     macOS folder picker and Claude terminal (osascript)
server/mcp.js       Claude's tools (MCP over HTTP at /mcp)
server/review.js    suggestion/comment store and text anchoring
server/asks.js      "Ask Claude": hand-over to the Claude terminal, Claude activity
server/compile.js   latexmk, log parsing, SyncTeX
server/bib.js       BibTeX parsing, citation checks, DOI/Crossref
server/zotero.js    Zotero library search and export (Better BibTeX / local API)
server/git.js       commit / pull --rebase / push
server/changes.js   Changes view: per-file hunks since the last sync / last commit, accepted-since list
server/latexdiff.js latexdiff PDF of the changes, built under .margin-build/diff/
server/init.js      margin init
templates/          CLAUDE.md, slash commands and the prompt hook installed by init
web/                UI source (CodeMirror 6, pdf.js) and the hub page → built into public/
test/run.mjs        end-to-end test (npm test)
test/hub.mjs        end-to-end test of the hub (npm test)
mac/                the Mac app: Swift shell (AppKit + WKWebView) around `margin hub`, build-app.sh
CLAUDE.md           guide for Claude when working on Margin's code
CHANGELOG.md        what changed in each version
```
