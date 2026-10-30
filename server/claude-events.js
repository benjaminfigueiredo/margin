// What Claude is doing in the author's own terminal, for notifications: Claude finished its turn
// (Claude Code's Stop hook), Claude needs the author (the Notification hook: a permission prompt,
// or waiting for input), and Claude answered an Ask (seen in the review store). The hook script
// `margin init` installs (.claude/hooks/margin-events.mjs) POSTs to /api/claude/event; each event
// worth telling the author about is broadcast as `claude-event` over the paper's WebSocket, and the
// page turns it into a notification (the Mac app's, or the browser's when the author turned them
// on; see web/src/notify.js). Margin still never runs or drives Claude.
//
// Hooks fire more often than an author wants to hear about, so:
//   - several Stops within a few seconds are one (a Stop hook that sends Claude back to work);
//   - a Stop right after "Claude needs you" is not announced again (a permission prompt the
//     author answered by stopping the turn);
//   - "needs you" notifications within a few seconds of each other are one, and "waiting for
//     your input" (idle_prompt) after "Claude is done" is dropped: the author has been told;
//   - asks answered during a turn are reported with the Stop that ends it ("answered your
//     question"), when the Stop hook is installed; otherwise they are announced on their own.
import fs from 'node:fs';
import path from 'node:path';
import { askInfo } from './review.js';

export const EVENTS_HOOK_SCRIPT = 'margin-events.mjs';
// notification_type values that mean the author has to do something in the terminal. Others
// (auth_success, elicitation_complete, quota notices, ...) are not worth interrupting for.
// Older Claude Code versions send no notification_type: those count as "needs you".
const NEEDS_YOU = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
export const TIMING = { stopRepeatMs: 5000, stopAfterNeedMs: 3000, needRepeatMs: 5000, answerDelayMs: 1500, answerHoldMs: 10 * 60 * 1000 };
const RECENT = 20;

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function createClaudeEvents({ project, review, broadcast, timing = TIMING, now = Date.now }) {
  const t = { ...TIMING, ...timing };
  let turnStart = now(); // what Claude added since then is the turn's work
  let lastStop = 0, lastNeed = 0;
  let toldDone = false; // "Claude is done" was the last thing said, nothing happened since
  let seq = 0;
  const recent = [];
  let answered = answeredAsks();
  let held = []; // asks answered during a turn, for the Stop that ends it
  let holdTimer = null, answerTimer = null, pendingAnswers = [];

  function emit(kind, title, body) {
    const ev = { type: 'claude-event', id: ++seq, kind, title, body, at: now() };
    recent.push(ev);
    if (recent.length > RECENT) recent.shift();
    broadcast(ev);
    toldDone = kind === 'done';
    return ev;
  }

  // ---- asks Claude answered ----
  function answeredAsks() {
    const items = review.data.items;
    return new Set(items.filter((it) => it.ask && it.status === 'open' && askInfo(it, items).askState === 'answered').map((it) => it.id));
  }
  // The Stop hook is in this paper's Claude Code settings: a Stop will end the turn.
  function stopHookInstalled() {
    try { return fs.readFileSync(path.join(project.root, '.claude', 'settings.local.json'), 'utf8').includes(EVENTS_HOOK_SCRIPT); } catch { return false; }
  }
  function onReviewChange() {
    const nowAnswered = answeredAsks();
    const fresh = [...nowAnswered].filter((id) => !answered.has(id));
    answered = nowAnswered;
    if (!fresh.length) return;
    const asks = fresh.map((id) => review.data.items.find((it) => it.id === id)).filter(Boolean);
    if (stopHookInstalled()) {
      held.push(...asks);
      // A turn that never ends (Claude Code closed, a hook that is not loaded): say it anyway.
      if (!holdTimer) holdTimer = setTimeout(() => { holdTimer = null; announceAnswers(held.splice(0)); }, t.answerHoldMs);
      return;
    }
    pendingAnswers.push(...asks);
    clearTimeout(answerTimer);
    answerTimer = setTimeout(() => { answerTimer = null; announceAnswers(pendingAnswers.splice(0)); }, t.answerDelayMs);
  }
  function announceAnswers(asks) {
    if (!asks.length) return;
    const body = asks.length === 1 ? `“${clip(asks[0].body, 90)}” (${asks[0].file})` : asks.map((a) => `“${clip(a.body, 40)}”`).join(', ');
    emit('answered', asks.length === 1 ? 'Claude answered your question' : `Claude answered ${asks.length} of your questions`, body);
  }
  review.on('change', onReviewChange);

  // ---- what Claude added in the turn: "sections/intro.tex: 4 suggestions, 1 comment" ----
  function turnSummary(since) {
    const iso = new Date(since).toISOString();
    const byFile = new Map();
    let replies = 0;
    for (const it of review.data.items) {
      if (it.author === 'claude' && it.createdAt > iso && (it.kind === 'suggestion' || it.kind === 'comment')) {
        const f = byFile.get(it.file) || { suggestion: 0, comment: 0 };
        f[it.kind]++;
        byFile.set(it.file, f);
      }
      for (const r of it.replies || []) if (r.author === 'claude' && r.createdAt > iso) replies++;
    }
    let s = 0, c = 0;
    for (const f of byFile.values()) { s += f.suggestion; c += f.comment; }
    const counts = [s && plural(s, 'suggestion'), c && plural(c, 'comment')].filter(Boolean).join(', ');
    const parts = [];
    if (counts) parts.push(byFile.size === 1 ? `${[...byFile.keys()][0]}: ${counts}` : `${counts} in ${byFile.size} files`);
    if (replies) parts.push(plural(replies, 'reply', 'replies'));
    return parts.join(' · ');
  }

  // ---- the hooks ----
  function onHook(body) {
    const event = String(body?.event || body?.hook_event_name || '');
    const at = now();
    if (event === 'Stop') {
      const since = turnStart;
      turnStart = at;
      const answers = held.splice(0);
      clearTimeout(holdTimer); holdTimer = null;
      const repeat = at - lastStop < t.stopRepeatMs;
      lastStop = at;
      if (repeat) return { sent: false, reason: 'another Stop a moment ago' };
      if (at - lastNeed < t.stopAfterNeedMs) return { sent: false, reason: 'right after "needs you"' };
      const parts = [turnSummary(since)];
      if (answers.length) parts.push(answers.length === 1 ? 'answered your question' : `answered ${answers.length} of your questions`);
      let text = parts.filter(Boolean).join(' · ');
      if (!text) text = clip(String(body?.last_assistant_message || '').split('\n').find((l) => l.trim()) || '', 140) || 'Your turn in the terminal.';
      return { sent: true, event: emit('done', 'Claude is done', text) };
    }
    if (event === 'Notification') {
      const type = body?.notification_type ? String(body.notification_type) : '';
      if (type && !NEEDS_YOU.has(type)) return { sent: false, reason: `not for the author (${type})` };
      if (type === 'idle_prompt' && toldDone) return { sent: false, reason: 'already told: Claude is done' };
      const repeat = at - lastNeed < t.needRepeatMs;
      lastNeed = at;
      if (repeat) return { sent: false, reason: 'another notification a moment ago' };
      return { sent: true, event: emit('needs-you', 'Claude needs you', clip(body?.message, 200) || 'Claude is waiting for you in the terminal.') };
    }
    throw Object.assign(new Error('event must be Stop or Notification'), { status: 400 });
  }

  return {
    // A prompt from the author starts a turn (the "Ask Claude" prompt hook calls this).
    turnStarted() { turnStart = now(); toldDone = false; },
    mount(api) {
      // The hooks. JSON only, like /asks/deliver, so a web page cannot trigger it with a form post.
      api.post('/claude/event', (req, res) => {
        if (!req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
        try { res.json(onHook(req.body || {})); } catch (e) { res.status(e.status || 500).json({ error: e.message || String(e) }); }
      });
      api.get('/claude/events', (req, res) => res.json({ events: recent }));
    },
    close() {
      review.off('change', onReviewChange);
      clearTimeout(holdTimer); clearTimeout(answerTimer);
      holdTimer = answerTimer = null;
    },
  };
}
