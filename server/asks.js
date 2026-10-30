// "Ask Claude": requests the author addresses to Claude from the editor, and how they reach
// the author's own Claude Code terminal. Margin never runs or controls Claude. An ask is a
// comment in the review store (marked ask: true); it gets to Claude in one of two ways:
//   - the UserPromptSubmit hook `margin init` installs (.claude/hooks/margin-asks.mjs) POSTs
//     to /api/asks/deliver whenever the author sends any prompt, and prints what comes back,
//     which Claude Code adds to that prompt as context;
//   - the /margin slash command, which calls the get_asks MCP tool.
// This module also keeps a note of when Claude last talked to Margin, for the status bar.
const MAX_IN_PROMPT = 10;
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s);

// Text handed to Claude: by the prompt hook (forHook) or by the get_asks tool.
export function formatAsks(asks, { forHook = false } = {}) {
  if (!asks.length) return '';
  const n = asks.length;
  const shown = forHook ? asks.slice(0, MAX_IN_PROMPT) : asks; // the hook's text is capped by Claude Code
  const out = [];
  if (forHook) {
    out.push(`Margin: the author used "Ask Claude" in the Margin editor and is waiting on ${n === 1 ? 'this request' : `these ${n} requests`}. Handle ${n === 1 ? 'it' : 'them'} in this turn, after anything the author's message itself asks for.`);
  } else {
    out.push(`${n} request${n === 1 ? '' : 's'} from the author, oldest first.`);
  }
  out.push('For each: do what it asks, then `reply` on its id with your answer or a one-line summary of what you did. Propose wording changes with suggest_edit / suggest_edits / add_comment and pass `ask: "<id>"` so they show up linked to the request; do not rewrite prose with direct file edits. Leave the ask open: the author resolves it. Use show_location to point the author at another passage.');
  for (const a of shown) {
    const where = a.orphaned ? `${a.file} (the selected text has been edited since)` : `${a.file}:${a.line}${a.endLine > a.line ? `-${a.endLine}` : ''}`;
    out.push('', `[${a.id.slice(0, 8)}] ${where}`, `  selected: ${JSON.stringify(clip(a.quote, 600))}`, `  request: ${clip(a.body, 1500)}`);
    for (const r of a.replies || []) out.push(`  ${r.author === 'claude' ? 'you (Claude)' : 'author'}: ${clip(r.body, 800)}`);
  }
  if (n > shown.length) out.push('', `…and ${n - shown.length} more: call get_asks for the rest.`);
  return out.join('\n');
}

// What the status bar shows: when a Claude Code session last talked to Margin, and how.
export function createClaudeLink({ review, broadcast, onPrompt = () => {} }) {
  const seen = { at: null, what: null, client: null };
  let timer = null;
  const note = (what) => {
    seen.at = Date.now();
    seen.what = what;
    // Coalesce bursts (a session start sends initialize, tools/list, ... in a row).
    if (!timer) timer = setTimeout(() => { timer = null; broadcast({ type: 'claude-activity', ...seen }); }, 250);
  };

  return {
    // Called with each /mcp request body (a JSON-RPC message or a batch of them).
    noteMcp(body) {
      for (const m of Array.isArray(body) ? body : [body]) {
        if (!m || typeof m.method !== 'string') continue;
        if (m.method === 'initialize') {
          const c = m.params?.clientInfo;
          if (c?.name) seen.client = `${c.name}${c.version ? ' ' + c.version : ''}`.slice(0, 80);
          note('connect');
        } else if (m.method === 'tools/call') note(`tool:${String(m.params?.name || '').slice(0, 60)}`);
        else if (!m.method.startsWith('notifications/')) note('mcp');
      }
    },

    mount(api) {
      api.get('/claude', (req, res) => res.json(seen));
      // The prompt hook. JSON only, so a web page cannot trigger it with a plain form post.
      api.post('/asks/deliver', (req, res) => {
        if (!req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
        try {
          note('prompt');
          onPrompt(); // a turn starts: what Claude adds from now on is its work (server/claude-events.js)
          const asks = review.pendingAsks({ states: ['waiting'] });
          const text = formatAsks(asks, { forHook: true });
          if (asks.length) review.markPickedUp(asks.slice(0, MAX_IN_PROMPT).map((a) => a.id), 'prompt');
          res.json({ count: asks.length, text });
        } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
      });
    },

    close() { clearTimeout(timer); timer = null; },
  };
}
