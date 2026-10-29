// "Ask Claude" on a selection: a quick composer, the ask's progress on its review card, and a
// status-bar note of when Claude last talked to Margin. Margin never runs or drives Claude:
// an ask is a comment marked ask: true, and the author's own Claude Code session picks it up
// with their next prompt (the hook `margin init` installs) or with /margin. See server/asks.js.
import { api, $, h, toast, timeAgo } from './util.js';
import { selectionInfo } from './editor.js';

export const ASK_COMMAND = '/margin';

const STATE_LABEL = {
  waiting: 'Waiting for Claude',
  'picked-up': 'Claude is on it',
  answered: 'Claude answered',
  done: 'Done',
};

export function initAsk({ editor, getFile, saveIfDirty, refreshReview, focusItem, showReview }) {
  const box = $('#ask-box');
  const ta = box.querySelector('textarea');
  const status = $('#claude-status');
  let items = [];
  let seen = { at: null };

  const close = () => box.classList.add('hidden');

  function open() {
    const info = selectionInfo(editor.view.state);
    if (!info.selection || !getFile()) { toast('Select some text to ask Claude about', 'info'); return; }
    showReview();
    $('#new-comment').classList.add('hidden');
    const quote = info.selection.text;
    box.querySelector('.quote').textContent = quote.length > 200 ? quote.slice(0, 200) + '…' : quote;
    box.dataset.quote = quote;
    box.dataset.line = String(info.selection.fromLine);
    box.dataset.file = getFile();
    box.classList.remove('hidden');
    ta.value = '';
    ta.focus();
  }

  async function submit() {
    const request = ta.value.trim();
    if (!request) { ta.focus(); return; }
    await saveIfDirty();
    try {
      await api('/review/comment', { method: 'POST', body: { file: box.dataset.file, quote: box.dataset.quote, comment: request, line: Number(box.dataset.line), ask: true } });
      close();
      await refreshReview();
      toast(`Sent. In your Claude terminal, type ${ASK_COMMAND} (or send any message).`, 'claude', 6000);
    } catch (e) { toast(e.message, 'error', 6000); }
  }

  box.querySelector('.submit').addEventListener('click', submit);
  box.querySelector('.cancel').addEventListener('click', close);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') close();
  });
  // Starters fill the box; the author still sends it, so a misclick costs nothing.
  for (const b of box.querySelectorAll('[data-ask]')) {
    b.addEventListener('click', () => { ta.value = b.dataset.ask; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  }
  $('#btn-ask').addEventListener('click', open);

  async function copyCommand() {
    try { await navigator.clipboard.writeText(ASK_COMMAND); toast(`Copied ${ASK_COMMAND}. Paste it in your Claude terminal and press Enter.`, 'claude'); }
    catch { toast(`Type ${ASK_COMMAND} in your Claude terminal and press Enter.`, 'claude'); }
  }

  const chip = (it, label) => h('button', { class: 'ask-link', title: 'Show it', onclick: (e) => { e.stopPropagation(); focusItem(it); } }, label);

  // Extra rows on a review card: an ask's progress and what Claude did for it, or, on
  // Claude's own suggestion or comment, which ask it answers.
  function cardExtra(it, all) {
    if (it.ask && it.askState) {
      const row = h('div', { class: `ask-state ${it.askState}` }, h('span', { class: 'ask-dot', 'aria-hidden': 'true' }), h('span', { class: 'ask-label' }, STATE_LABEL[it.askState] || it.askState));
      if (it.askState === 'waiting') {
        row.append(h('span', { class: 'ask-hint' }, `type ${ASK_COMMAND} in your Claude terminal`),
          h('button', { class: 'btn sm ghost', title: `Copy ${ASK_COMMAND} to the clipboard`, onclick: (e) => { e.stopPropagation(); copyCommand(); } }, 'Copy'));
      }
      const linked = (it.linked || []).map((id) => all.find((x) => x.id === id)).filter(Boolean);
      if (!linked.length) return row;
      return h('div', { class: 'ask-extra' }, row, h('div', { class: 'ask-links' }, h('span', { class: 'fine' }, 'Claude:'),
        ...linked.map((x) => chip(x, `${x.kind === 'suggestion' ? 'suggested edit' : 'comment'}${x.line ? ` · line ${x.line}` : ''}${x.status !== 'open' ? ` · ${x.status}` : ''}`))));
    }
    if (it.askId) {
      const ask = all.find((x) => x.id === it.askId);
      if (!ask) return null;
      const q = ask.body.length > 60 ? ask.body.slice(0, 60) + '…' : ask.body;
      return h('div', { class: 'ask-links' }, h('span', { class: 'fine' }, 'For your ask:'), chip(ask, `“${q}”`));
    }
    return null;
  }

  // Margin only hears from Claude when it calls a tool or the author sends a prompt, so
  // this says when Claude was last active rather than claiming a live connection.
  function renderStatus() {
    const waiting = items.filter((it) => it.ask && it.askState === 'waiting').length;
    const recent = seen.at && Date.now() - seen.at < 120000;
    status.className = `claude-status ${recent ? 'on' : seen.at ? 'idle' : 'off'}`;
    const when = seen.at ? `active ${timeAgo(new Date(seen.at).toISOString())}` : 'not connected yet';
    status.replaceChildren(h('span', { class: 'ask-dot', 'aria-hidden': 'true' }), `Claude ${when}`, waiting ? h('strong', {}, ` · ${waiting} ask${waiting > 1 ? 's' : ''} waiting`) : '');
    status.title = seen.at
      ? `Last heard from Claude Code${seen.client ? ` (${seen.client})` : ''}: ${seen.what === 'prompt' ? 'you sent a prompt' : seen.what?.startsWith('tool:') ? `it used ${seen.what.slice(5)}` : 'it connected'}.${waiting ? ` Type ${ASK_COMMAND} in your Claude terminal to hand over what is waiting.` : ''}`
      : 'No Claude Code session has used Margin since it started. Run claude in the paper folder (after margin init).';
  }
  status.addEventListener('click', () => { if (items.some((it) => it.ask && it.askState === 'waiting')) copyCommand(); });
  setInterval(renderStatus, 30000);
  api('/claude').then((s) => { seen = s; renderStatus(); }).catch(() => {});
  renderStatus();

  return {
    open,
    cardExtra,
    onActivity(msg) { seen = msg; renderStatus(); },
    update(list) { items = list; renderStatus(); },
  };
}
