// Context view in the review rail: the author's private background for this paper (notes,
// discussions, drafts, PDFs) that Claude reads through list_context / read_context. The files live
// in .review/context/ and never reach git or Overleaf; the server (server/context.js) owns them and
// their descriptions. Files can be dropped on the panel, picked with "Add files…", pasted, or
// typed as a quick note; files put in the folder with the Finder show up when Margin is next in front.
import { api, h, toast } from './util.js';
import { hasFiles, takeFiles, confirmDialog } from './files.js';

const MAX_BYTES = 20 * 1024 * 1024; // keep in step with CONTEXT_MAX_BYTES in server/context.js
const ACCEPT = '.md,.markdown,.txt,.text,.pdf';
const TYPE = /\.(md|markdown|txt|text|pdf)$/i;
const MAC = /Mac/i.test(navigator.platform || '');
const WIN = /Win/i.test(navigator.platform || '');
const REVEAL = MAC ? 'Show in Finder' : WIN ? 'Show in Explorer' : 'Show folder';
const TYPE_LABEL = { md: 'MD', txt: 'TXT', pdf: 'PDF' };

const q = (name) => `?name=${encodeURIComponent(name)}`;
const size = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function createContextPanel(rail) {
  const root = rail.querySelector('#context');
  const count = rail.querySelector('#context-count');
  let data = null;
  let editing = null; // { name, value } while a description is being edited
  let noteOpen = false;

  // ---------- static parts ----------
  const picker = h('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'hidden', 'aria-hidden': 'true', tabindex: '-1' });
  picker.addEventListener('change', () => { const files = [...picker.files]; picker.value = ''; upload(files); });
  const bar = h('div', { class: 'cx-bar' },
    h('button', { class: 'btn sm', title: 'Add .md, .txt or .pdf files (or drop them on this panel)', onclick: () => picker.click() }, 'Add files…'),
    h('button', { class: 'btn sm', title: 'Type or paste a note', onclick: () => openNote() }, '+ Note'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm ghost cx-reveal-all', title: 'Open the context folder (.review/context/) to add or remove files there', onclick: () => reveal() }, REVEAL),
    picker);

  const noteTitle = h('input', { class: 'cx-note-title', placeholder: 'Title (optional)', 'aria-label': 'Note title', maxlength: '80' });
  const noteBody = h('textarea', { rows: 6, placeholder: 'Paste a discussion, notes from a call, a draft…', 'aria-label': 'Note' });
  noteBody.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveNote(); } if (e.key === 'Escape') closeNote(); });
  noteTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); noteBody.focus(); } if (e.key === 'Escape') closeNote(); });
  const noteBox = h('div', { class: 'cx-note hidden' }, noteTitle, noteBody,
    h('div', { class: 'row' },
      h('button', { class: 'btn sm primary', onclick: () => saveNote() }, 'Save note'),
      h('button', { class: 'btn sm', onclick: () => closeNote() }, 'Cancel'),
      h('span', { class: 'fine' }, '⌘/Ctrl + Enter')));
  const list = h('div', { class: 'cx-list' });
  const skippedNote = h('p', { class: 'fine cx-skipped hidden' });
  const foot = h('p', { class: 'fine cx-foot' }, 'Only on this computer, in .review/context/. Never committed or sent to Overleaf. Claude reads it as background (list_context) and does not cite it.');
  root.append(bar, noteBox, list, skippedNote, foot);
  root.setAttribute('tabindex', '-1'); // so a paste on the panel itself reaches it

  // ---------- adding ----------
  async function upload(files) {
    const added = [];
    for (const f of files) {
      if (!TYPE.test(f.name)) { toast(`${f.name}: only .md, .txt or .pdf files can be added as context.`, 'error', 7000); continue; }
      if (f.size > MAX_BYTES) { toast(`${f.name} is over 20 MB; not added.`, 'error', 7000); continue; }
      try {
        const res = await fetch(`/api/context/upload${q(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
        added.push(body);
      } catch (err) { toast(`${f.name}: ${err.message}`, 'error', 7000); }
    }
    if (!added.length) return;
    toast(added.length === 1 ? `Added ${added[0].name} to your private context` : `Added ${added.length} files to your private context`, 'ok');
    if (added.length === 1) editing = { name: added[0].name, value: '' }; // invite a description
    await refresh();
  }

  function openNote(text) {
    noteOpen = true;
    noteBox.classList.remove('hidden');
    if (typeof text === 'string') noteBody.value = text;
    (noteBody.value ? noteTitle : noteBody).focus();
  }
  function closeNote() {
    noteOpen = false;
    noteBox.classList.add('hidden');
    noteTitle.value = ''; noteBody.value = '';
  }
  async function saveNote() {
    if (!noteBody.value.trim()) { toast('Type or paste the note first', 'info'); noteBody.focus(); return; }
    try {
      const it = await api('/context/note', { method: 'POST', body: { title: noteTitle.value, body: noteBody.value } });
      closeNote();
      toast(`Saved ${it.name}`, 'ok');
      await refresh();
    } catch (e) { toast(e.message, 'error', 6000); }
  }

  // Drop anywhere on the panel.
  const dropOn = (on) => root.classList.toggle('drop-over', on);
  root.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); dropOn(true); } });
  root.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; dropOn(true); } });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) dropOn(false); });
  root.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropOn(false);
    upload(takeFiles(e));
  });
  // A paste on the panel (not in one of its fields): files are added, text opens a note with it.
  root.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea')) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); upload(files); return; }
    const text = e.clipboardData?.getData('text/plain');
    if (text && text.trim()) { e.preventDefault(); openNote(text); }
  });

  // ---------- items ----------
  async function reveal(name) {
    try { await api('/context/reveal', { method: 'POST', body: name ? { name } : {} }); } catch (e) { toast(e.message, 'error', 8000); }
  }

  async function remove(it) {
    const ok = await confirmDialog({
      title: `Delete “${it.name}”?`,
      lines: ['This deletes the file from your private context folder (.review/context/). Margin has no trash, so this cannot be undone from here.'],
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try { await api(`/context/item${q(it.name)}`, { method: 'DELETE' }); toast(`Deleted ${it.name}`, 'ok'); } catch (e) { toast(e.message, 'error', 6000); }
    if (editing?.name === it.name) editing = null;
    await refresh();
  }

  async function saveDescription(it, value) {
    editing = null;
    if (value.trim() === it.description) { render(); return; }
    try { await api(`/context/item${q(it.name)}`, { method: 'PUT', body: { description: value } }); } catch (e) { toast(e.message, 'error', 6000); }
    await refresh();
  }

  function description(it) {
    if (editing?.name !== it.name) {
      return h('div', {
        class: `cx-desc ${it.description ? '' : 'blank'}`, tabindex: '0', role: 'button', title: 'Edit the description',
        'aria-label': `Description of ${it.name}`,
        onclick: () => { editing = { name: it.name, value: it.description }; render(); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editing = { name: it.name, value: it.description }; render(); } },
      }, it.description || 'Add a description…');
    }
    const ta = h('textarea', { class: 'cx-desc-edit', rows: 2, placeholder: 'What is this? e.g. “Call with Anna about the reviewers’ comments”', 'aria-label': `Description of ${it.name}`, maxlength: '2000' });
    ta.value = editing.value;
    let done = false;
    const finish = (save) => { if (done) return; done = true; if (save) saveDescription(it, ta.value); else { editing = null; render(); } };
    ta.addEventListener('input', () => { if (editing) editing.value = ta.value; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    ta.addEventListener('blur', () => { if (ta.isConnected) finish(true); });
    return ta;
  }

  function card(it) {
    const href = `/context/file${q(it.name)}`;
    return h('div', { class: `cx-item ${it.type}`, dataset: { name: it.name } },
      h('div', { class: 'cx-item-head' },
        h('span', { class: `cx-type ${it.type}`, 'aria-label': `${TYPE_LABEL[it.type]} file` }, TYPE_LABEL[it.type]),
        h('a', { class: 'cx-name', href, target: '_blank', rel: 'noopener', title: `Open ${it.name}` }, it.name)),
      h('div', { class: 'cx-meta' },
        h('span', {}, size(it.size)),
        h('span', {}, it.source ? `added ${day(it.addedAt)}` : `in the folder since ${day(it.addedAt)}`),
        it.source === 'claude' ? h('span', { class: 'cx-by-claude' }, 'added by Claude') : null),
      description(it),
      h('div', { class: 'cx-actions' },
        h('a', { class: 'btn sm ghost', href, target: '_blank', rel: 'noopener' }, 'Open'),
        h('button', { class: 'btn sm ghost', onclick: () => reveal(it.name) }, REVEAL),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm ghost danger', title: 'Delete this file (no trash)', onclick: () => remove(it) }, 'Delete')));
  }

  function render() {
    if (!data) return;
    const n = data.items.length;
    count.textContent = n || '';
    count.classList.toggle('hidden', !n);
    count.title = n ? `${n} private context item${n === 1 ? '' : 's'}` : '';
    if (editing && !data.items.some((it) => it.name === editing.name)) editing = null;
    const scroll = list.scrollTop;
    if (!n) {
      list.replaceChildren(h('div', { class: 'empty cx-empty' },
        h('p', {}, 'No private context yet.'),
        h('p', { class: 'hint' }, 'Drop .md, .txt or .pdf files here: discussions with co-authors, notes from a call, earlier drafts. Or add a note with + Note. Claude reads them to understand what you want; they are never part of the paper.')));
    } else list.replaceChildren(...data.items.map(card));
    list.scrollTop = scroll;
    const skipped = data.skipped || [];
    skippedNote.classList.toggle('hidden', !skipped.length);
    skippedNote.textContent = skipped.length ? `Not used (only .md, .txt and .pdf files directly in the folder): ${skipped.map((s) => s.name).join(', ')}` : '';
    if (editing) {
      const ta = list.querySelector('.cx-desc-edit');
      if (ta && document.activeElement !== ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }
  }

  async function refresh() {
    try { data = await api('/context'); } catch (e) { toast(e.message, 'error'); return; }
    // Re-rendering would take the focus out of a description being typed: keep it.
    if (editing && document.activeElement?.classList?.contains('cx-desc-edit')) {
      count.textContent = data.items.length || '';
      count.classList.toggle('hidden', !data.items.length);
      return;
    }
    render();
  }

  const visible = () => !root.classList.contains('hidden');
  // Files put in the folder with the Finder: look again whenever Margin comes back to the front.
  window.addEventListener('focus', () => { if (visible()) refresh(); });

  return { refresh, visible, isEditing: () => !!editing || noteOpen };
}
