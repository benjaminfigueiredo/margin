// Bibliography helpers: parse .bib files, cross-check against \cite commands,
// look up DOIs (doi.org content negotiation) and search Crossref.

const SKIP_TYPES = new Set(['string', 'comment', 'preamble']);

export function parseBib(text) {
  const entries = [];
  const re = /@(\w+)\s*([{(])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const type = m[1].toLowerCase();
    const open = m[2];
    const close = open === '{' ? '}' : ')';
    let depth = 1;
    let i = re.lastIndex;
    let inQuote = false;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (c === '\\') { i++; continue; }
      if (c === '"' && open === '{' && depth === 1) inQuote = !inQuote;
      if (inQuote) continue;
      if (c === open || (open === '(' && c === '{')) depth++;
      else if (c === close || (open === '(' && c === '}')) depth--;
    }
    const start = m.index;
    const end = i;
    re.lastIndex = end;
    if (SKIP_TYPES.has(type)) continue;
    const body = text.slice(m.index + m[0].length, end - 1);
    const comma = body.indexOf(',');
    const key = (comma === -1 ? body : body.slice(0, comma)).trim();
    const fields = parseFields(comma === -1 ? '' : body.slice(comma + 1));
    entries.push({ type, key, fields, start, end });
  }
  return entries;
}

function parseFields(s) {
  const fields = {};
  let i = 0;
  while (i < s.length) {
    const m = /\s*([\w:.-]+)\s*=\s*/y;
    m.lastIndex = i;
    const r = m.exec(s);
    if (!r) break;
    const name = r[1].toLowerCase();
    i = m.lastIndex;
    let value = '';
    if (s[i] === '{') {
      let depth = 0; const st = i;
      for (; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === '{') depth++; else if (s[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
      value = s.slice(st + 1, i - 1);
    } else if (s[i] === '"') {
      const st = ++i;
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
      value = s.slice(st, i); i++;
    } else {
      const st = i;
      while (i < s.length && s[i] !== ',') i++;
      value = s.slice(st, i).trim();
    }
    fields[name] = value.replace(/\s+/g, ' ').trim();
    while (i < s.length && s[i] !== ',') i++;
    i++;
  }
  return fields;
}

const CITE_RE = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/g;

export function citations(project) {
  const cited = new Map(); // key -> [{file,line}]
  let nocite = false;
  const bibFiles = new Set();
  for (const f of project.textFiles('.tex')) {
    const text = stripComments(project.read(f));
    for (const m of text.matchAll(CITE_RE)) {
      const line = text.slice(0, m.index).split('\n').length;
      for (const raw of m[1].split(',')) {
        const key = raw.trim();
        if (!key) continue;
        if (key === '*') { nocite = true; continue; }
        if (!cited.has(key)) cited.set(key, []);
        cited.get(key).push({ file: f, line });
      }
    }
    for (const m of text.matchAll(/\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
      for (const b of m[1].split(',')) {
        const name = b.trim();
        if (name) bibFiles.add(name.endsWith('.bib') ? name : name + '.bib');
      }
    }
  }
  let bibs = [...bibFiles].map((b) => resolveBib(project, b)).filter(Boolean);
  if (bibs.length === 0) bibs = project.textFiles('.bib');
  return { cited, nocite, bibs };
}

function resolveBib(project, name) {
  if (project.exists(name)) return name;
  const hit = project.textFiles('.bib').find((f) => f.endsWith('/' + name) || f === name);
  return hit || null;
}

function stripComments(text) {
  // Remove % comments but keep line structure (and escaped \%)
  return text.split('\n').map((l) => l.replace(/(^|[^\\])%.*$/, '$1')).join('\n');
}

export function checkCitations(project) {
  const { cited, nocite, bibs } = citations(project);
  const defined = new Map(); // key -> [{file, type, title, doi}]
  const byDoi = new Map();
  for (const b of bibs) {
    for (const e of parseBib(project.read(b))) {
      if (!defined.has(e.key)) defined.set(e.key, []);
      defined.get(e.key).push({ file: b, type: e.type, title: e.fields.title, doi: e.fields.doi });
      const doi = normalizeDoi(e.fields.doi || '');
      if (doi) { if (!byDoi.has(doi)) byDoi.set(doi, []); byDoi.get(doi).push(e.key); }
    }
  }
  const missing = [...cited.entries()].filter(([k]) => !defined.has(k)).map(([key, uses]) => ({ key, uses }));
  const unused = nocite ? [] : [...defined.keys()].filter((k) => !cited.has(k));
  const duplicateKeys = [...defined.entries()].filter(([, v]) => v.length > 1).map(([key, v]) => ({ key, files: v.map((x) => x.file) }));
  const duplicateDois = [...byDoi.entries()].filter(([, keys]) => new Set(keys).size > 1).map(([doi, keys]) => ({ doi, keys: [...new Set(keys)] }));
  const missingDoi = [...defined.entries()].filter(([, v]) => ['article', 'inproceedings'].includes(v[0].type) && !v[0].doi).map(([k]) => k);
  return { bibFiles: bibs, citedCount: cited.size, definedCount: defined.size, missing, unused, duplicateKeys, duplicateDois, articlesWithoutDoi: missingDoi };
}

export function normalizeDoi(doi) {
  return doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
}

export async function lookupDoi(doi, { key } = {}) {
  const clean = normalizeDoi(doi);
  if (!/^10\.\d{4,9}\/\S+$/.test(clean)) throw new Error(`Not a DOI: ${doi}`);
  const res = await fetch(`https://doi.org/${encodeURI(clean)}`, {
    headers: { Accept: 'application/x-bibtex; charset=utf-8', 'User-Agent': 'margin-latex-review/0.1 (mailto:unknown@example.org)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`doi.org returned ${res.status} for ${clean}`);
  const raw = (await res.text()).trim();
  const [entry] = parseBib(raw);
  if (!entry) throw new Error('doi.org did not return BibTeX');
  entry.fields.doi = entry.fields.doi || clean;
  delete entry.fields.url; // doi.org URLs are redundant with the DOI field
  return formatEntry({ ...entry, key: key || makeKey(entry) });
}

export async function searchCrossref(query, rows = 5) {
  const url = `https://api.crossref.org/works?rows=${rows}&query.bibliographic=${encodeURIComponent(query)}&select=DOI,title,author,issued,container-title,type`;
  const res = await fetch(url, { headers: { 'User-Agent': 'margin-latex-review/0.1 (mailto:unknown@example.org)' } });
  if (!res.ok) throw new Error(`Crossref returned ${res.status}`);
  const json = await res.json();
  return (json.message?.items || []).map((it) => ({
    doi: it.DOI,
    title: (it.title || [])[0],
    authors: (it.author || []).slice(0, 4).map((a) => [a.given, a.family].filter(Boolean).join(' ')).join(', ') + ((it.author || []).length > 4 ? ', et al.' : ''),
    year: it.issued?.['date-parts']?.[0]?.[0],
    venue: (it['container-title'] || [])[0],
    type: it.type,
  }));
}

export function makeKey(entry) {
  const author = (entry.fields.author || 'anon').split(/\s+and\s+/i)[0];
  const last = (author.includes(',') ? author.split(',')[0] : author.split(/\s+/).pop()) || 'anon';
  const year = (entry.fields.year || '').match(/\d{4}/)?.[0] || '';
  const stop = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'from', 'by', 'at', 'via']);
  const word = (entry.fields.title || '').replace(/[{}\\$]/g, '').split(/[^A-Za-z0-9]+/).find((w) => w && !stop.has(w.toLowerCase())) || '';
  return ascii(last).toLowerCase() + year + ascii(word).toLowerCase();
}

function ascii(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\\[`'^"~=.uvHtcdbk]\{?(\w)\}?/g, '$1').replace(/[^A-Za-z0-9]/g, '');
}

const FIELD_ORDER = ['author', 'title', 'journal', 'booktitle', 'year', 'month', 'volume', 'number', 'pages', 'publisher', 'doi'];

export function formatEntry({ type, key, fields }) {
  const names = Object.keys(fields).sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a); const ib = FIELD_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const width = Math.max(...names.map((n) => n.length), 0);
  const body = names.map((n) => `  ${n.padEnd(width)} = ${value(n, fields[n])}`).join(',\n');
  return `@${type}{${key},\n${body}\n}`;
}

// Month macros (month = sep) must stay bare: BibTeX prints {sep} literally.
const MONTHS = new Set(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);
const value = (name, v) => (name === 'month' && MONTHS.has(v.toLowerCase()) ? v.toLowerCase() : `{${v}}`);

export function addEntry(project, bibtex, file) {
  const [entry] = parseBib(bibtex);
  if (!entry || !entry.key) throw new Error('Could not parse a BibTeX entry from the input');
  const { bibs } = citations(project);
  const target = file || bibs[0] || 'references.bib';
  // Check every bib in use for clashes, not just the target
  for (const b of new Set([...bibs, target])) {
    if (!project.exists(b)) continue;
    for (const e of parseBib(project.read(b))) {
      if (e.key === entry.key) throw new Error(`Key "${entry.key}" already exists in ${b}`);
      const d1 = normalizeDoi(e.fields.doi || ''); const d2 = normalizeDoi(entry.fields.doi || '');
      if (d1 && d1 === d2) throw new Error(`DOI ${d2} is already in ${b} under key "${e.key}" — cite that key instead`);
    }
  }
  const existing = project.exists(target) ? project.read(target) : '';
  const sep = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  project.write(target, existing + sep + formatEntry(entry) + '\n');
  return { file: target, key: entry.key };
}
