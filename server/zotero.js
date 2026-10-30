// Zotero lookups against the Zotero app running on this machine. Zotero stays the
// master library; the paper's .bib only receives entries that are actually cited.
// Prefers Better BibTeX's JSON-RPC endpoint (its citation keys, all libraries);
// falls back to Zotero's own local API (Settings → Advanced → "Allow other
// applications on this computer to communicate with Zotero"), My Library only.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBib, formatEntry } from './bib.js';

const base = () => (process.env.MARGIN_ZOTERO_URL || 'http://127.0.0.1:23119').replace(/\/$/, '');
const TIMEOUT_MS = 15000;

// Fields that are local to the author's Zotero (or just noise) and must not reach Overleaf.
const DROP_FIELDS = new Set(['file', 'abstract', 'annote', 'annotation', 'keywords']);

const NOT_RUNNING = 'Zotero is not running (nothing answers on port 23119). Ask the author to open Zotero, then try again.';
const NO_API = 'Zotero is open but Margin cannot query it. Install the Better BibTeX add-on (recommended), or enable Settings → Advanced → "Allow other applications on this computer to communicate with Zotero".';

async function request(path, init = {}) {
  try {
    return await fetch(base() + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error('Zotero did not answer within 15 s. It may be busy (e.g. syncing); try again.');
    throw new Error(NOT_RUNNING);
  }
}

// --- Better BibTeX JSON-RPC -------------------------------------------------

class NoBbt extends Error {}

async function bbt(method, params) {
  const res = await request('/better-bibtex/json-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  if (res.status === 404) throw new NoBbt();
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Better BibTeX returned HTTP ${res.status}`);
  if (json.error) throw Object.assign(new Error(json.error.message), { rpc: json.error });
  return json.result;
}

// BBT matches the query as one phrase ("biogeography island" finds nothing), so
// multi-word queries also search word by word and keep items matching every word.
async function bbtSearch(query, limit) {
  const hits = await bbt('item.search', [query]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 1 && hits.length < limit) {
    const perWord = await Promise.all(words.map((w) => bbt('item.search', [w])));
    const sets = perWord.map((r) => new Set(r.map((it) => it.id)));
    const seen = new Set(hits.map((it) => it.id));
    for (const it of perWord.flat()) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      const hay = cslHaystack(it);
      if (words.every((w, i) => sets[i].has(it.id) || hay.includes(w))) hits.push(it);
    }
  }
  return hits.slice(0, limit).map(fromCsl);
}

function cslHaystack(it) {
  const names = (it.author || []).map((a) => [a.given, a.family, a.literal].join(' '));
  return [it.title, it['container-title'], it.DOI, it.citekey, cslYear(it), ...names].join(' ').toLowerCase();
}

const cslYear = (it) => it.issued?.['date-parts']?.[0]?.[0] ?? (String(it.issued?.raw || it.issued?.literal || '').match(/\d{4}/)?.[0]);

function fromCsl(it) {
  const names = (it.author || it.editor || []).map((a) => a.literal || [a.given, a.family].filter(Boolean).join(' '));
  return {
    key: it.citekey || it['citation-key'],
    library: it.library,
    title: it.title || '(untitled)',
    authors: names.slice(0, 4).join(', ') + (names.length > 4 ? ', et al.' : ''),
    year: cslYear(it),
    venue: it['container-title'],
    doi: it.DOI,
    type: it.type,
  };
}

async function bbtExport(key, library) {
  try {
    return await bbt('item.export', library ? [[key], 'Better BibTeX', library] : [[key], 'Better BibTeX']);
  } catch (e) {
    if (library || !/not found/i.test(e.message)) throw e;
  }
  // Not in My Library: find which library (e.g. a group) holds the key.
  const owner = (await bbt('item.search', [key])).find((it) => (it.citekey || it['citation-key']) === key);
  if (!owner) throw new Error(`No item with citation key "${key}" in Zotero. Use search_zotero to find the right key.`);
  return bbt('item.export', [[key], 'Better BibTeX', owner.library]);
}

// --- Zotero local API (fallback) ---------------------------------------------

const MY_LIBRARY = '/api/users/0';

async function local(path, scope = MY_LIBRARY) {
  const res = await request(scope + path, { headers: { 'Zotero-API-Version': '3' } });
  const body = await res.text();
  if (res.status === 403 || /not enabled/i.test(body)) throw new Error(NO_API);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Zotero local API returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  return body;
}

const ITEM_KEY = /^[A-Z0-9]{8}$/;

function localCitekey(data) {
  return data.citationKey || (data.extra || '').match(/^\s*Citation Key:\s*(\S+)/im)?.[1] || null;
}

function fromLocal(it) {
  const d = it.data;
  const names = (d.creators || []).filter((c) => c.creatorType === 'author' || c.creatorType === 'editor')
    .map((c) => c.name || [c.firstName, c.lastName].filter(Boolean).join(' '));
  return {
    key: localCitekey(d) || it.key,
    library: 'My Library',
    title: d.title || '(untitled)',
    authors: names.slice(0, 4).join(', ') + (names.length > 4 ? ', et al.' : ''),
    year: String(d.date || '').match(/\d{4}/)?.[0],
    venue: d.publicationTitle || d.proceedingsTitle || d.bookTitle,
    doi: d.DOI,
    type: d.itemType,
  };
}

async function localSearch(query, limit) {
  const body = await local(`/items/top?q=${encodeURIComponent(query)}&qmode=titleCreatorYear&limit=${limit}`);
  return JSON.parse(body || '[]').map(fromLocal);
}

async function localExport(key) {
  let itemKey = ITEM_KEY.test(key) ? key : null;
  let citekey = itemKey ? null : key;
  if (!itemKey) {
    const found = JSON.parse(await local(`/items?q=${encodeURIComponent(key)}&qmode=everything&limit=50`) || '[]')
      .find((it) => localCitekey(it.data) === key);
    if (!found) throw new Error(`No item with citation key "${key}" in Zotero's My Library. Use search_zotero to find the right key.`);
    itemKey = found.key;
  } else {
    const item = await local(`/items/${itemKey}`);
    if (!item) throw new Error(`No Zotero item ${itemKey}. Use search_zotero to find the right key.`);
    citekey = localCitekey(JSON.parse(item).data);
  }
  const bib = await local(`/items/${itemKey}?format=bibtex`);
  const [entry] = parseBib(bib || '');
  if (!entry) throw new Error(`Zotero did not return BibTeX for item ${itemKey}`);
  // Keep the citation key the author set in Zotero; otherwise Zotero's exporter picks one.
  return formatEntry({ ...entry, key: citekey || entry.key });
}

// --- PDF attachments -----------------------------------------------------------
// Where the PDF of a cited item lives on this computer, for server/cited-pdf.js (which checks and
// copies the file). Zotero runs on the same machine, so it can give us the file's path.
//  - Better BibTeX: item.attachments(citekey, library) lists {open, path} for every attachment, linked
//    or stored (https://retorque.re/zotero-better-bibtex/exporting/json-rpc/); item.search gives the
//    item's metadata and the name of the library that holds the key (My Library or a group).
//  - Zotero's local API: GET /items/<KEY>/children (attachment items: linkMode, contentType, filename),
//    then GET /items/<KEY>/file/view/url, which answers with the file:// URL of the attachment (older
//    builds: GET .../file, a redirect to it). Group libraries are /api/groups/<id>/... instead of
//    /api/users/0/... and are listed by /api/users/0/groups.

const citekeyOf = (it) => it.citekey || it['citation-key'] || '';

async function bbtFiles(key) {
  const hits = await bbt('item.search', [key]);
  let owners = hits.filter((it) => citekeyOf(it) === key);
  if (!owners.length) owners = hits.filter((it) => citekeyOf(it).toLowerCase() === key.toLowerCase()); // BBT can match keys case-insensitively
  if (!owners.length) throw new Error(`No item with citation key "${key}" in Zotero.`);
  const item = fromCsl(owners[0]);
  const files = [], skipped = [];
  for (const owner of owners.slice(0, 5)) {
    let atts;
    try {
      atts = await bbt('item.attachments', [citekeyOf(owner), owner.library]);
    } catch (e) {
      if (e.rpc?.code === -32601) throw new NoBbt(); // a Better BibTeX too old to list attachments
      throw e;
    }
    for (const a of atts || []) {
      if (typeof a.path === 'string' && a.path) files.push({ path: a.path, name: path.basename(a.path) });
      else skipped.push('an attachment that is a link or has no file on this computer');
    }
    if (files.length) break;
  }
  return { via: 'Better BibTeX', item, files, skipped };
}

// The local path behind an attachment item, or null when Zotero has no file for it.
async function localFilePath(scope, itemKey) {
  const headers = { 'Zotero-API-Version': '3' };
  let res = await request(`${scope}/items/${itemKey}/file/view/url`, { headers });
  if (res.status === 403) throw new Error(NO_API);
  let url = null;
  if (res.ok) url = (await res.text()).trim();
  else {
    res = await request(`${scope}/items/${itemKey}/file`, { headers, redirect: 'manual' });
    if (res.status === 403) throw new Error(NO_API);
    if (res.status >= 300 && res.status < 400) url = res.headers.get('location');
  }
  return url && url.startsWith('file:') ? fileURLToPath(url) : null;
}

async function localScopes() {
  const scopes = [MY_LIBRARY];
  try {
    const groups = JSON.parse(await local('/groups') || '[]');
    for (const g of groups) { const id = g.id ?? g.data?.id; if (id != null && /^\d+$/.test(String(id))) scopes.push(`/api/groups/${id}`); }
  } catch (e) { if (e.message === NO_API || /not running|did not answer/.test(e.message)) throw e; } // no group list: My Library only
  return scopes;
}

async function localFiles(key) {
  let found = null, scope = null;
  for (scope of await localScopes()) {
    if (scope === MY_LIBRARY && ITEM_KEY.test(key)) { // an item key rather than a citation key
      const one = await local(`/items/${key}`, scope);
      if (one) { found = JSON.parse(one); break; }
    }
    const hit = JSON.parse(await local(`/items?q=${encodeURIComponent(key)}&qmode=everything&limit=50`, scope) || '[]')
      .find((it) => localCitekey(it.data) === key);
    if (hit) { found = hit; break; }
  }
  if (!found) throw new Error(`No item with citation key "${key}" in Zotero.`);
  const item = { ...fromLocal(found), library: scope === MY_LIBRARY ? 'My Library' : `group ${scope.split('/').pop()}` };
  const children = JSON.parse(await local(`/items/${found.key}/children`, scope) || '[]')
    .filter((c) => c.data?.itemType === 'attachment');
  // PDFs first, in Zotero's order; the checks in cited-pdf.js decide what is really a PDF.
  const isPdf = (c) => c.data.contentType === 'application/pdf' || /\.pdf$/i.test(c.data.filename || '');
  children.sort((a, b) => Number(isPdf(b)) - Number(isPdf(a)));
  const files = [], skipped = [];
  for (const c of children) {
    const p = c.data.linkMode === 'linked_url' ? null : await localFilePath(scope, c.key);
    if (p) files.push({ path: p, name: c.data.filename || path.basename(p) });
    else skipped.push(`${c.data.title ? `"${c.data.title}"` : 'an attachment'} (${c.data.linkMode === 'linked_url' ? 'a web link' : 'no file on this computer'})`);
  }
  return { via: 'Zotero local API', item, files, skipped };
}

// --- Public ------------------------------------------------------------------

// The files attached to the item with this citation key (any library): { via, item, files: [{ path,
// name }], skipped: [what has no file] }. Throws when Zotero is not running or has no such item.
export async function zoteroAttachments(key) {
  try {
    return await bbtFiles(key);
  } catch (e) {
    if (!(e instanceof NoBbt)) throw e;
  }
  return localFiles(key);
}

export async function searchZotero(query, limit = 10) {
  try {
    return { via: 'Better BibTeX', items: await bbtSearch(query, limit) };
  } catch (e) {
    if (!(e instanceof NoBbt)) throw e;
  }
  return { via: 'Zotero local API', items: await localSearch(query, limit) };
}

// Returns the BibTeX for one item, with local-only fields removed.
export async function exportFromZotero(key, library) {
  let raw;
  try {
    raw = await bbtExport(key, library);
  } catch (e) {
    if (!(e instanceof NoBbt)) throw e;
    raw = await localExport(key);
  }
  const [entry] = parseBib(String(raw));
  if (!entry) throw new Error(`Zotero did not return BibTeX for "${key}"`);
  for (const f of Object.keys(entry.fields)) if (DROP_FIELDS.has(f)) delete entry.fields[f];
  return formatEntry(entry);
}
