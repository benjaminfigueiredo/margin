// Review rail: cards for suggestions and comments, with accept/reject/edit/reply.
import { api, h, toast, timeAgo, wordDiff } from './util.js';

export function createReviewPanel(root, { getCurrentFile, onFocus, onChanged, saveIfDirty }) {
  let items = [];
  let scope = 'file';
  let showClosed = false;
  let activeId = null;
  const editing = new Set();
  const replying = new Set();

  const author = (a) => (a === 'claude' ? h('span', { class: 'avatar claude', title: 'Claude' }, 'C') : h('span', { class: 'avatar you', title: 'You' }, 'Y'));
  const authorName = (a) => (a === 'claude' ? 'Claude' : 'You');

  // Flush pending editor edits before any review action. Accept and Undo rewrite the
  // source file, so without this the server applies the change to a version of the file
  // that is missing the author's unsaved edits, and the "changed on disk" banner's
  // "Keep mine" writes the stale buffer back over the applied change.
  async function act(fn, okMsg) {
    try { await saveIfDirty?.(); await fn(); if (okMsg) toast(okMsg, 'ok', 1800); await onChanged(); }
    catch (e) { toast(e.message, 'error', 6000); }
  }

  function diffView(it) {
    const parts = wordDiff(it.quote, it.replacement ?? '');
    return h('div', { class: 'diff' }, parts.map((p) => (p.op === 'eq' ? h('span', {}, p.text) : h(p.op === 'del' ? 'del' : 'ins', {}, p.text))));
  }

  function card(it) {
    const isOpen = it.status === 'open';
    const el = h('div', {
      class: `card ${it.kind} ${it.author} ${isOpen ? '' : 'closed'} ${it.id === activeId ? 'active' : ''} ${it.orphaned ? 'orphaned' : ''}`,
      dataset: { id: it.id },
      onclick: (e) => { if (e.target.closest('button, textarea, input')) return; onFocus(it); },
    });

    const label = it.kind === 'suggestion' ? (it.replacement === '' ? 'Suggested deletion' : 'Suggested edit') : 'Comment';
    el.append(h('div', { class: 'card-head' },
      author(it.author),
      h('div', { class: 'meta' },
        h('div', { class: 'who' }, authorName(it.author), h('span', { class: 'kind' }, ` · ${label}`)),
        h('div', { class: 'when' }, `${scope === 'all' ? it.file + ' · ' : ''}${it.line ? 'line ' + it.line + ' · ' : ''}${timeAgo(it.createdAt)}`)),
      !isOpen ? h('span', { class: `status ${it.status}` }, it.status) : null,
      it.orphaned && isOpen ? h('span', { class: 'status orphan', title: it.fileMissing ? `${it.file} no longer exists. This item is kept, and attaches again if the file comes back.` : 'The quoted text is no longer in the file' }, it.fileMissing ? 'file missing' : 'text changed') : null,
    ));

    if (it.kind === 'suggestion') {
      if (editing.has(it.id)) {
        const ta = h('textarea', { class: 'edit-replacement', rows: Math.min(10, Math.max(3, Math.ceil((it.replacement || '').length / 38))) });
        ta.value = it.replacement;
        el.append(h('div', { class: 'quote small' }, it.quote), ta,
          h('div', { class: 'row' },
            h('button', { class: 'btn sm primary', onclick: () => act(() => api(`/review/${it.id}/accept`, { method: 'POST', body: { replacement: ta.value } }).then(() => editing.delete(it.id)), 'Accepted with your edits') }, 'Accept edited'),
            h('button', { class: 'btn sm', onclick: () => { editing.delete(it.id); render(); } }, 'Cancel')));
        setTimeout(() => ta.focus(), 0);
      } else {
        el.append(diffView(it));
      }
    } else {
      el.append(h('div', { class: 'quote' }, it.quote.length > 220 ? it.quote.slice(0, 220) + '…' : it.quote));
    }
    if (it.body) el.append(h('div', { class: 'body' }, it.body));

    for (const r of it.replies || []) {
      el.append(h('div', { class: `reply ${r.author}` }, author(r.author), h('div', {}, h('div', { class: 'who' }, authorName(r.author), h('span', { class: 'when' }, ` · ${timeAgo(r.createdAt)}`)), h('div', { class: 'body' }, r.body))));
    }

    if (replying.has(it.id)) {
      const ta = h('textarea', { rows: 2, placeholder: it.author === 'claude' ? 'Reply — Claude sees this via list_review' : 'Reply…' });
      const send = () => ta.value.trim() && act(() => api(`/review/${it.id}/reply`, { method: 'POST', body: { body: ta.value } }).then(() => replying.delete(it.id)));
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); if (e.key === 'Escape') { replying.delete(it.id); render(); } });
      el.append(ta, h('div', { class: 'row' }, h('button', { class: 'btn sm primary', onclick: send }, 'Reply'), h('button', { class: 'btn sm', onclick: () => { replying.delete(it.id); render(); } }, 'Cancel')));
      setTimeout(() => ta.focus(), 0);
    }

    const actions = h('div', { class: 'actions' });
    if (isOpen && it.kind === 'suggestion' && !editing.has(it.id)) {
      actions.append(
        h('button', { class: 'btn sm accept', title: 'Accept (apply to source)', disabled: it.orphaned, onclick: () => act(() => api(`/review/${it.id}/accept`, { method: 'POST', body: {} }), 'Accepted') }, '✓ Accept'),
        h('button', { class: 'btn sm reject', title: 'Reject', onclick: () => act(() => api(`/review/${it.id}/reject`, { method: 'POST', body: {} })) }, '✕ Reject'),
        h('button', { class: 'btn sm ghost', title: 'Edit the suggested text before accepting', disabled: it.orphaned, onclick: () => { editing.add(it.id); render(); } }, 'Edit'),
      );
    }
    if (isOpen && it.kind === 'comment') {
      actions.append(h('button', { class: 'btn sm', onclick: () => act(() => api(`/review/${it.id}/resolve`, { method: 'POST', body: {} })) }, 'Resolve'));
    }
    if (isOpen && !replying.has(it.id)) actions.append(h('button', { class: 'btn sm ghost', onclick: () => { replying.add(it.id); render(); } }, 'Reply'));
    if (!isOpen && it.status !== 'accepted') actions.append(h('button', { class: 'btn sm ghost', onclick: () => act(() => api(`/review/${it.id}/reopen`, { method: 'POST', body: {} })) }, 'Reopen'));
    if (it.status === 'accepted' && it.kind === 'suggestion') {
      actions.append(h('button', { class: 'btn sm ghost', title: 'Put the original text back in the source and reopen this suggestion', onclick: () => {
        act(() => api(`/review/${it.id}/unaccept`, { method: 'POST', body: {} }), 'Accept undone');
      } }, 'Undo accept'));
    }
    if (it.author === 'you' && it.kind === 'comment') actions.append(h('button', { class: 'btn sm ghost danger', title: 'Delete comment', onclick: () => act(() => api(`/review/${it.id}`, { method: 'DELETE' })) }, 'Delete'));
    if (actions.childElementCount) el.append(actions);
    return el;
  }

  function visible() {
    const file = getCurrentFile();
    return items.filter((it) => (scope === 'all' || it.file === file) && (showClosed || it.status === 'open'));
  }

  function render() {
    const list = root.querySelector('#cards');
    const vis = visible();
    const openSugg = vis.filter((it) => it.kind === 'suggestion' && it.status === 'open' && !it.orphaned);
    const bulk = root.querySelector('#bulk');
    bulk.replaceChildren();
    if (openSugg.length > 1) {
      bulk.append(
        h('span', {}, `${openSugg.length} open suggestions`),
        h('button', { class: 'btn sm accept', onclick: () => confirm(`Accept all ${openSugg.length} suggestions shown?`) && act(async () => { for (const s of openSugg) await api(`/review/${s.id}/accept`, { method: 'POST', body: {} }).catch((e) => toast(e.message, 'error')); }, 'Accepted all') }, 'Accept all'),
        h('button', { class: 'btn sm reject', onclick: () => confirm(`Reject all ${openSugg.length} suggestions shown?`) && act(async () => { for (const s of openSugg) await api(`/review/${s.id}/reject`, { method: 'POST', body: {} }); }) }, 'Reject all'),
      );
    }
    if (vis.length === 0) {
      list.replaceChildren(h('div', { class: 'empty' },
        h('p', {}, scope === 'file' ? 'No open threads in this file.' : 'No open threads.'),
        h('p', { class: 'hint' }, 'Select text and press “Comment” to leave a note for Claude, or ask Claude in your terminal to review a section.')));
      return;
    }
    list.replaceChildren(...vis.map(card));
  }

  root.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
    scope = b.dataset.scope;
    root.querySelectorAll('[data-scope]').forEach((x) => x.classList.toggle('on', x === b));
    render();
  }));
  root.querySelector('#show-closed').addEventListener('change', (e) => { showClosed = e.target.checked; render(); });

  return {
    async refresh() { items = await api('/review'); render(); return items; },
    render,
    get items() { return items; },
    setActive(id, { scroll = true } = {}) {
      activeId = id;
      render();
      if (scroll && id) root.querySelector(`.card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    itemsForFile(file) { return items.filter((it) => it.file === file); },
    openCount() { return items.filter((it) => it.status === 'open').length; },
  };
}
