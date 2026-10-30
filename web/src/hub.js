// The hub page (web/hub.html, served by server/hub.js): the author's papers, each run by the hub
// as its own Margin server on its own port. Also the /open/<id> page, which starts a paper and
// then turns into it. Open is a normal link with target=_blank (a native shell turns it into a
// new window). The hub never talks to a paper's server from the browser: papers are other origins.
import { api, $, h, toast } from './util.js';
import { THEMES } from '../../server/appearance.js';
import { appHost, postToApp } from './notify.js';

const POLL_MS = 2000;
const state = { hub: null, papers: [], fresh: null, lastJson: '' };

// ---------- theme: the same shared setting as the papers (no menu here; change it in a paper) ----------
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme; else delete root.dataset.theme;
  try { localStorage.setItem('margin:theme', theme); } catch { /* first paint falls back to System */ }
}
async function pullTheme() {
  try { const r = await api('/appearance'); if (r.saved && THEMES.includes(r.settings?.theme)) applyTheme(r.settings.theme); } catch { /* keep what is shown */ }
}

// ---------- formatting ----------
function ago(iso) {
  if (!iso) return 'never opened';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'opened just now';
  if (s < 3600) return `opened ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `opened ${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'opened yesterday';
  return `opened ${new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
const STATE_LABEL = { running: 'Running', starting: 'Starting', stopped: 'Stopped', error: 'Error' };

// ---------- actions ----------
async function act(p, fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); await refresh(); return r; } catch (e) { toast(e.message, 'error', 8000); await refresh(); return null; }
}
const start = (p) => act(p, () => api(`/papers/${p.id}/start`, { method: 'POST' }));
const stop = (p) => act(p, () => api(`/papers/${p.id}/stop`, { method: 'POST' }), `Stopped ${p.name}`);
const dismiss = (p) => act(p, () => api(`/papers/${p.id}/dismiss`, { method: 'POST' }));
const setupClaude = (p) => act(p, () => api(`/papers/${p.id}/setup-claude`, { method: 'POST' }));
const terminal = (p) => act(p, () => api(`/papers/${p.id}/terminal`, { method: 'POST' }));
async function remove(p) {
  if (!confirm(`Remove ${p.name} from the list?\n\nIts folder and files are not touched${p.state === 'running' ? ', and its editor stops' : ''}. You can add it again with Open folder….`)) return;
  await act(p, () => api(`/papers/${p.id}`, { method: 'DELETE' }), `Removed ${p.name} from the list`);
}

// ---------- the list ----------
function paperRow(p) {
  const running = p.state === 'running';
  // A running paper opens directly; otherwise /open/<id> starts it in the new window first.
  const open = h('a', {
    class: 'btn sm primary open', target: '_blank', rel: 'noopener',
    href: running ? p.url : `/open/${p.id}`,
    title: running ? `Open ${p.url}` : 'Start this paper and open it',
    'aria-disabled': p.missing ? 'true' : null,
    onclick: (e) => {
      if (p.missing) { e.preventDefault(); return; }
      if (running) fetch(`/api/papers/${p.id}/opened`, { method: 'POST', keepalive: true }).then(() => refresh()).catch(() => {});
    },
  }, 'Open');
  const actions = [open];
  if (running) actions.push(h('button', { class: 'btn sm stop', onclick: () => stop(p) }, 'Stop'));
  if (p.state === 'error') actions.push(h('button', { class: 'btn sm restart', onclick: () => start(p) }, 'Restart'));
  if (!p.claude.setup && !p.missing) actions.push(h('button', { class: 'btn sm setup-claude', title: 'Run margin init on this folder, so Claude Code there connects to this paper', onclick: () => setupClaude(p) }, 'Set up for Claude'));
  else if (p.claude.outdated && !p.missing) actions.push(h('button', { class: 'btn sm setup-claude', title: 'Run margin init again: adds the hooks that tell Margin when Claude is done or needs you (for notifications). Your own settings and hooks are kept.', onclick: () => setupClaude(p) }, 'Update for Claude'));
  if (running && p.claude.setup && state.hub?.platform === 'darwin') {
    // In the Mac app: the app puts this paper's window above a Terminal running claude (one click).
    const inApp = !!appHost();
    actions.push(h('button', {
      class: 'btn sm ghost terminal',
      title: inApp ? 'Put this paper on the top of the screen and Terminal running claude in a strip below it' : 'Open Terminal in the paper folder and run claude',
      onclick: () => (inApp ? postToApp({ type: 'splitWithClaude', paper: p.id }) : terminal(p)),
    }, 'Claude terminal'));
  }
  actions.push(h('button', { class: 'btn sm ghost danger remove', title: 'Remove from this list (the files stay)', onclick: () => remove(p) }, 'Remove'));

  const msgs = [];
  if (p.missing) msgs.push(h('p', { class: 'paper-msg error' }, h('span', {}, `Folder not found: ${p.path}. Moved or deleted? Remove it here and open it again from its new place.`)));
  else if (p.error) msgs.push(h('p', { class: 'paper-msg error', role: 'alert' }, h('span', {}, p.error)));
  if (p.claude.problem) msgs.push(h('p', { class: 'paper-msg notice' }, h('span', {}, p.claude.problem)));
  if (p.notice) msgs.push(h('p', { class: 'paper-msg notice', role: 'status' }, h('span', {}, p.notice), h('button', { class: 'x', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => dismiss(p) }, '×')));

  return h('article', { class: `paper ${p.state}${state.fresh === p.id ? ' fresh' : ''}`, dataset: { id: p.id } },
    h('div', { class: 'paper-main' },
      h('div', { class: 'paper-title' },
        h('span', { class: 'paper-name' }, p.name),
        h('span', { class: `pill ${p.state}`, title: p.state === 'running' ? `Running on port ${p.port}` : '' }, STATE_LABEL[p.state] || p.state)),
      h('div', { class: 'paper-path', title: p.path }, p.path),
      h('div', { class: 'paper-meta' },
        h('span', { class: 'last-opened' }, ago(p.lastOpened)),
        h('span', {}, `port ${p.port}`),
        p.claude.setup ? h('span', {}, 'Claude Code: set up') : h('span', {}, 'Claude Code: not set up'))),
    h('div', { class: 'paper-actions' }, actions),
    msgs);
}

function render() {
  $('#papers').replaceChildren(...state.papers.map(paperRow));
  $('#empty').classList.toggle('hidden', state.papers.length > 0);
}

async function refresh() {
  let r;
  try { r = await api('/papers'); } catch (e) { return; }
  const json = JSON.stringify(r) + state.fresh;
  if (json === state.lastJson) return; // unchanged: keep focus and hover where they are
  state.lastJson = json;
  state.papers = r.papers;
  $('#hub-warning').textContent = r.warning || '';
  $('#hub-warning').classList.toggle('hidden', !r.warning);
  render();
}

// ---------- Open folder… ----------
function showForm(on, error = '') {
  $('#add-form').classList.toggle('hidden', !on);
  $('#add-error').textContent = error;
  $('#add-error').classList.toggle('hidden', !error);
  if (on) $('#add-path').focus();
}
async function addPath(path) {
  const p = await api('/papers', { method: 'POST', body: { path } });
  state.fresh = p.id;
  showForm(false);
  $('#add-path').value = '';
  await refresh();
  toast(`${p.name} is in the list. Starting it…`, 'ok');
  await start(p);
}
async function onAdd() {
  if (state.hub?.platform !== 'darwin') { showForm($('#add-form').classList.contains('hidden')); return; }
  try {
    const r = await api('/pick-folder', { method: 'POST' });
    if (r.cancelled) return;
    await addPath(r.path);
  } catch (e) { $('#add-path').value = ''; showForm(true, e.message); }
}

// ---------- /open/<id> ----------
async function openPage(id) {
  const main = $('#hub-main');
  const title = h('h2', {}, 'Opening…');
  const box = h('div', { class: 'opening' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), title, h('p', { class: 'fine' }, 'Starting the paper’s editor. This window becomes the paper when it is ready.'));
  main.replaceChildren(box);
  $('#btn-add').classList.add('hidden');
  try {
    const list = await api('/papers');
    const p = list.papers.find((x) => x.id === id);
    if (!p) throw new Error('That paper is not in the list any more.');
    title.textContent = `Opening ${p.name}…`;
    document.title = `${p.name} — Margin`;
    const r = await api(`/papers/${id}/start`, { method: 'POST' });
    if (r.state !== 'running') throw new Error(r.error || `It is ${r.state}.`);
    location.replace(r.url);
  } catch (e) {
    box.replaceChildren(
      h('h2', {}, 'Could not open the paper'),
      h('p', { class: 'hub-error', role: 'alert' }, e.message),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => openPage(id) }, 'Try again'), h('a', { class: 'btn', href: '/' }, 'All papers')));
  }
}

// ---------- boot ----------
async function boot() {
  pullTheme();
  window.addEventListener('focus', pullTheme);
  try { state.hub = await api('/hub'); } catch { /* buttons still work */ }
  const m = location.pathname.match(/^\/open\/([0-9a-f]{12})$/);
  if (m) return openPage(m[1]);
  $('#btn-add').addEventListener('click', onAdd);
  $('#btn-add').title = state.hub?.platform === 'darwin' ? 'Choose a paper folder' : 'Type the path of a paper folder';
  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await addPath($('#add-path').value); } catch (err) { showForm(true, err.message); }
  });
  $('#add-cancel').addEventListener('click', () => showForm(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#add-form').classList.contains('hidden')) showForm(false); });
  await refresh();
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
  // "opened 5 min ago" moves on even when nothing else changes.
  setInterval(() => { state.lastJson = ''; }, 60000);
}

boot().catch((e) => toast(`Failed to start: ${e.message}`, 'error', 20000));
