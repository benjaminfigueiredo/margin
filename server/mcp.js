// MCP tools that let a Claude Code session act as a reviewer on the manuscript.
// Served over Streamable HTTP at /mcp by the main server, so Claude and the
// browser UI share one review store, one compile, and one view of the selection.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { checkCitations, lookupDoi, addEntry, searchCrossref, parseBib, formatEntry, bibKeys } from './bib.js';
import { searchZotero, exportFromZotero } from './zotero.js';
import { registerResponseTools, pointForEdit, respondsToSchema } from './responses-mcp.js';
import { formatAsks } from './asks.js';
import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('../package.json');

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] });
const wrap = (fn) => async (args) => { try { return await fn(args || {}); } catch (e) { return fail(e); } };

function describeItem(it) {
  const where = it.orphaned ? `${it.file} (text no longer found)` : `${it.file}:${it.line}`;
  const kind = it.ask ? `ask for Claude (${it.askState})` : it.kind;
  const head = `[${it.id.slice(0, 8)}] ${kind} by ${it.author} — ${it.status} — ${where}${it.askId ? ` — for ask ${it.askId.slice(0, 8)}` : ''}`;
  const lines = [head, `  quote: ${JSON.stringify(clip(it.quote, 300))}`];
  if (it.kind === 'suggestion') lines.push(`  replacement: ${JSON.stringify(clip(it.replacement, 300))}`);
  if (it.body) lines.push(`  ${it.kind === 'suggestion' ? 'rationale' : 'comment'}: ${it.body}`);
  for (const r of it.replies || []) lines.push(`  ↳ ${r.author}: ${r.body}`);
  return lines.join('\n');
}

function clip(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s; }

function summarizeCompile(r) {
  const out = [`Compile ${r.ok ? (r.warnings.some((w) => w.kind !== 'box') ? 'succeeded with warnings' : 'succeeded') : r.pdf ? 'finished with errors (a PDF was still produced)' : 'failed'} in ${(r.durationMs / 1000).toFixed(1)}s.`];
  if (r.errors.length) {
    out.push(`\nErrors (${r.errors.length}):`);
    for (const e of r.errors.slice(0, 20)) out.push(`- ${e.file ?? '?'}:${e.line ?? '?'}: ${e.message}${e.context ? '\n    ' + e.context.split('\n').slice(0, 3).join('\n    ') : ''}`);
  }
  const important = r.warnings.filter((w) => w.kind !== 'box' && w.kind !== 'rerun');
  if (important.length) {
    out.push(`\nWarnings (${important.length}):`);
    for (const w of important.slice(0, 30)) out.push(`- ${w.file ? `${w.file}:${w.line}: ` : ''}${w.message}`);
  }
  const boxes = r.warnings.filter((w) => w.kind === 'box').length;
  if (boxes) out.push(`\n(${boxes} overfull/underfull box warnings omitted)`);
  return out.join('\n');
}

export function buildMcpServer(ctx) {
  const { project, review } = ctx;
  const server = new McpServer({ name: 'margin', version }, {
    instructions: [
      `You are reviewing the LaTeX manuscript "${project.name}" (main file ${project.main}) alongside the author, who sees your work live in the Margin editor.`,
      'For prose, wording and argument changes, use suggest_edit / add_comment so the author can accept or reject them; do not rewrite prose directly.',
      'Direct file edits are fine for mechanical fixes the author asked for (compile errors, bibliography entries, formatting).',
      'Start with get_editor_state to see what the author is looking at and list_review to see open threads, including comments the author left for you.',
      'Requests the author sends with "Ask Claude" in the editor arrive with their prompt or through get_asks: answer each with reply, and pass its id as `ask` to the suggestions and comments you make for it.',
      'Quote text exactly as it appears in the source, including LaTeX commands; whitespace may differ. Keep each suggestion to one sentence or clause so it can be accepted on its own.',
    ].join(' '),
  });

  server.registerTool('get_editor_state', {
    title: 'What the author is looking at',
    description: 'Returns the file open in the author\'s editor, the cursor line, and the currently selected text (if any). Use this when the author refers to "this", "here", or "my selection".',
    inputSchema: {},
  }, wrap(async () => {
    const s = ctx.state.editor;
    if (!s || !s.file) return text('The editor is not open, or no file is selected.');
    const parts = [`Open file: ${s.file}`, `Cursor at line ${s.cursorLine}`];
    if (s.selection && s.selection.text) parts.push(`Selected text (lines ${s.selection.fromLine}-${s.selection.toLine}):\n${s.selection.text}`);
    else parts.push('No text selected.');
    return text(parts.join('\n'));
  }));

  server.registerTool('list_files', {
    title: 'List project files',
    description: 'List the files in the manuscript repository (build output excluded).',
    inputSchema: {},
  }, wrap(async () => text(`Main file: ${project.main}\n` + project.tree().filter((f) => f.type === 'file').map((f) => `${f.path}${f.text ? '' : ' (binary)'}`).join('\n'))));

  server.registerTool('read_file', {
    title: 'Read a project file',
    description: 'Read a text file from the manuscript with line numbers.',
    inputSchema: {
      path: z.string().describe('Repo-relative path, e.g. sections/intro.tex'),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional(),
    },
  }, wrap(async ({ path, start_line, end_line }) => {
    const lines = project.read(path).split('\n');
    const s = (start_line || 1) - 1;
    const e = Math.min(lines.length, end_line || lines.length);
    return text(lines.slice(s, e).map((l, i) => `${String(s + i + 1).padStart(5)}  ${l}`).join('\n'));
  }));

  server.registerTool('suggest_edit', {
    title: 'Suggest an edit (tracked change)',
    description: 'Propose replacing a passage with new text. The author sees it inline as a tracked change and can accept, edit, or reject it. The source file is NOT changed until accepted.',
    inputSchema: {
      file: z.string().describe('Repo-relative .tex/.bib path'),
      original: z.string().describe('Exact text currently in the file (LaTeX included). Keep it short but unique.'),
      replacement: z.string().describe('Proposed new text. Empty string proposes a deletion.'),
      rationale: z.string().describe('One or two sentences on why — shown to the author'),
      line: z.number().int().positive().optional().describe('Approximate line number, used only if the quote occurs more than once'),
      responds_to: respondsToSchema,
      ask: z.string().optional().describe('Id of the author\'s ask this answers (from get_asks), so the author sees it linked to their request'),
    },
  }, wrap(async (a) => {
    const point = pointForEdit(review, a.responds_to);
    const it = review.addSuggestion({ file: a.file, original: a.original, replacement: a.replacement, rationale: a.rationale, line: a.line, askId: a.ask });
    if (point) review.responses.link(point.id, it.id);
    return text(`Suggestion ${it.id.slice(0, 8)} added at ${it.file}:${it.line}${point ? `, linked to R${point.number}` : ''}.`);
  }));

  server.registerTool('suggest_edits', {
    title: 'Suggest several edits',
    description: 'Batch version of suggest_edit for reviewing a section. Each edit is added independently; failures are reported per edit.',
    inputSchema: {
      edits: z.array(z.object({
        file: z.string(), original: z.string(), replacement: z.string(), rationale: z.string(), line: z.number().int().positive().optional(),
        responds_to: respondsToSchema,
        ask: z.string().optional(),
      })).min(1).max(50),
      responds_to: respondsToSchema.describe('Default responds_to for edits that do not set their own'),
    },
  }, wrap(async ({ edits, responds_to }) => {
    const out = edits.map((e, i) => {
      try {
        const point = pointForEdit(review, e.responds_to || responds_to);
        const it = review.addSuggestion({ file: e.file, original: e.original, replacement: e.replacement, rationale: e.rationale, line: e.line, askId: e.ask });
        if (point) review.responses.link(point.id, it.id);
        return `${i + 1}. added ${it.id.slice(0, 8)} at ${it.file}:${it.line}${point ? `, linked to R${point.number}` : ''}`;
      } catch (err) { return `${i + 1}. FAILED: ${err.message}`; }
    });
    return text(out.join('\n'));
  }));

  server.registerTool('add_comment', {
    title: 'Comment on a passage',
    description: 'Attach a margin comment to a passage (a question, a concern, a request for data) without proposing specific wording.',
    inputSchema: {
      file: z.string(),
      quote: z.string().describe('Exact text the comment refers to'),
      comment: z.string(),
      line: z.number().int().positive().optional(),
      ask: z.string().optional().describe('Id of the author\'s ask this answers (from get_asks), so the author sees it linked to their request'),
    },
  }, wrap(async (a) => {
    const it = review.addComment({ file: a.file, quote: a.quote, comment: a.comment, line: a.line, askId: a.ask });
    return text(`Comment ${it.id.slice(0, 8)} added at ${it.file}:${it.line}.`);
  }));

  server.registerTool('list_review', {
    title: 'List suggestions and comments',
    description: 'List review threads with their current location. Includes comments the author wrote for you (author "you"); treat those as requests to address.',
    inputSchema: {
      status: z.enum(['open', 'accepted', 'rejected', 'resolved', 'all']).optional().describe('Default: open'),
      file: z.string().optional(),
      author: z.enum(['claude', 'you']).optional(),
    },
  }, wrap(async ({ status = 'open', file, author }) => {
    const items = review.list({ status, file, author });
    review.markPickedUp(items.filter((it) => it.askState === 'waiting').map((it) => it.id), 'list_review');
    if (items.length === 0) return text(`No ${status === 'all' ? '' : status + ' '}review items${file ? ' in ' + file : ''}.`);
    return text(items.map(describeItem).join('\n\n'));
  }));

  server.registerTool('get_asks', {
    title: 'Requests the author sent you from the editor',
    description: 'Requests the author addressed to you with "Ask Claude" on a selection in the editor, oldest first, with the selected text, its file:line and any follow-up. Returns the ones still waiting for your answer and shows the author that you have picked them up. Answer each with `reply` on its id; pass its id as `ask` to suggest_edit / suggest_edits / add_comment so what you propose is linked to the request. Leave asks open: the author resolves them.',
    inputSchema: {},
  }, wrap(async () => {
    const asks = review.pendingAsks();
    if (!asks.length) return text('No requests from the author are waiting. (Their other comments for you are in list_review with author "you".)');
    review.markPickedUp(asks.map((a) => a.id), 'get_asks');
    return text(formatAsks(asks));
  }));

  server.registerTool('reply', {
    title: 'Reply in a thread',
    description: 'Reply to a suggestion or comment thread (e.g. answer the author\'s question or explain a suggestion).',
    inputSchema: { id: z.string().describe('Item id or its first 8 characters'), text: z.string() },
  }, wrap(async ({ id, text: body }) => { const it = review.reply(id, { body, author: 'claude' }); return text(`Replied on ${it.id.slice(0, 8)}.`); }));

  server.registerTool('revise_suggestion', {
    title: 'Revise an open suggestion',
    description: 'Change the proposed text of one of your open suggestions (e.g. after the author\'s feedback).',
    inputSchema: { id: z.string(), replacement: z.string(), note: z.string().optional().describe('Optional reply explaining the revision') },
  }, wrap(async ({ id, replacement, note }) => {
    const it = review.updateReplacement(id, replacement);
    if (note) review.reply(id, { body: note, author: 'claude' });
    return text(`Revised ${it.id.slice(0, 8)}.`);
  }));

  server.registerTool('resolve', {
    title: 'Resolve or withdraw',
    description: 'Resolve a comment thread once addressed, or withdraw one of your own open suggestions.',
    inputSchema: { id: z.string(), note: z.string().optional() },
  }, wrap(async ({ id, note }) => {
    const item = review.get(id);
    if (note) review.reply(id, { body: note, author: 'claude' });
    const it = item.kind === 'suggestion' ? review.reject(id, { by: 'claude' }) : review.resolve(id, { by: 'claude' });
    return text(`${it.kind === 'suggestion' ? 'Withdrew' : 'Resolved'} ${it.id.slice(0, 8)}.`);
  }));

  server.registerTool('compile', {
    title: 'Compile the PDF',
    description: 'Recompile with latexmk (the author\'s PDF view refreshes) and return errors and warnings with file:line.',
    inputSchema: {},
  }, wrap(async () => text(summarizeCompile(await ctx.compile('claude')))));

  server.registerTool('show_location', {
    title: 'Point the author to a location',
    description: 'Open a file at a line in the author\'s editor and scroll the PDF there, e.g. "look at this paragraph".',
    inputSchema: { file: z.string(), line: z.number().int().positive() },
  }, wrap(async ({ file, line }) => {
    if (!project.exists(file)) throw new Error(`No such file: ${file}`);
    const n = ctx.broadcast({ type: 'goto', file, line });
    return text(n > 0 ? `Showing ${file}:${line} in the editor.` : 'The editor is not open in a browser right now.');
  }));

  server.registerTool('check_citations', {
    title: 'Check citations against the bibliography',
    description: 'Cross-check every \\cite key in the .tex files against the .bib files in use: missing keys, unused entries, duplicate keys or DOIs, articles without a DOI.',
    inputSchema: {},
  }, wrap(async () => {
    const r = checkCitations(project);
    const o = [`Bibliography files: ${r.bibFiles.join(', ') || '(none found)'}`, `${r.citedCount} keys cited, ${r.definedCount} entries defined.`];
    o.push(r.missing.length ? `\nMissing (cited but not defined):\n${r.missing.map((m) => `- ${m.key} (${m.uses.map((u) => `${u.file}:${u.line}`).join(', ')})`).join('\n')}` : '\nNo missing keys.');
    if (r.duplicateKeys.length) o.push(`\nDuplicate keys:\n${r.duplicateKeys.map((d) => `- ${d.key} in ${d.files.join(', ')}`).join('\n')}`);
    if (r.duplicateDois.length) o.push(`\nSame DOI under several keys:\n${r.duplicateDois.map((d) => `- ${d.doi}: ${d.keys.join(', ')}`).join('\n')}`);
    if (r.unused.length) o.push(`\nDefined but never cited (${r.unused.length}): ${r.unused.join(', ')}`);
    if (r.articlesWithoutDoi.length) o.push(`\nArticles without a DOI (${r.articlesWithoutDoi.length}): ${r.articlesWithoutDoi.join(', ')}`);
    return text(o.join('\n'));
  }));

  server.registerTool('search_references', {
    title: 'Search Crossref for a reference',
    description: 'Find candidate papers (with DOIs) by title, authors, or a free-text citation. Confirm the right one before adding it.',
    inputSchema: { query: z.string(), rows: z.number().int().min(1).max(20).optional() },
  }, wrap(async ({ query, rows }) => {
    const hits = await searchCrossref(query, rows || 5);
    if (!hits.length) return text('No matches.');
    return text(hits.map((h, i) => `${i + 1}. ${h.title} — ${h.authors} (${h.year ?? 'n.d.'}) ${h.venue ? '· ' + h.venue : ''}\n   doi: ${h.doi}`).join('\n'));
  }));

  server.registerTool('add_bib_entry', {
    title: 'Add a bibliography entry',
    description: 'Add an entry to the .bib file, from a DOI (fetched from doi.org) or from BibTeX you supply. Refuses duplicate keys and duplicate DOIs. Returns the key to cite.',
    inputSchema: {
      doi: z.string().optional(),
      bibtex: z.string().optional().describe('Full BibTeX entry, if not using a DOI'),
      key: z.string().optional().describe('Citation key to use (default: lastnameYEARfirstword)'),
      file: z.string().optional().describe('Target .bib (default: the first one the manuscript uses)'),
    },
  }, wrap(async ({ doi, bibtex, key, file }) => {
    if (!doi && !bibtex) throw new Error('Give either doi or bibtex');
    const entry = doi ? await lookupDoi(doi, { key }) : bibtex;
    const r = addEntry(project, entry, file);
    return text(`Added \\cite{${r.key}} to ${r.file}:\n\n${formatEntry(parseBib(entry)[0])}`);
  }));

  server.registerTool('search_zotero', {
    title: 'Search the author\'s Zotero library',
    description: 'Search the author\'s Zotero library (Zotero must be open on this computer) by title, author, year or DOI words. Returns citation keys; entries already in the manuscript\'s .bib are marked. Prefer this over search_references for papers the author already has.',
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional().describe('Default 10') },
  }, wrap(async ({ query, limit }) => {
    const { via, items } = await searchZotero(query, limit || 10);
    if (!items.length) return text(`No matches in Zotero (searched via ${via}).`);
    const have = bibKeys(project);
    const lines = items.map((h, i) => {
      const where = [h.library && h.library !== 'My Library' ? `library: ${h.library}` : '', h.doi ? `doi: ${h.doi}` : '', have.has(h.key) ? `already in ${have.get(h.key)}` : ''].filter(Boolean).join(' · ');
      return `${i + 1}. ${h.key} — ${h.title} — ${h.authors || 'no authors'} (${h.year ?? 'n.d.'})${h.venue ? ' · ' + h.venue : ''}${where ? '\n   ' + where : ''}`;
    });
    return text(lines.join('\n'));
  }));

  server.registerTool('cite_from_zotero', {
    title: 'Copy a Zotero entry into the bibliography',
    description: 'Copy one entry from the author\'s Zotero library into the manuscript\'s .bib under its Zotero citation key (local fields such as file paths and abstracts are dropped). Refuses duplicate keys and duplicate DOIs. Returns the key to cite. Does not edit the .tex.',
    inputSchema: {
      key: z.string().describe('Citation key from search_zotero'),
      library: z.string().optional().describe('Zotero library name from search_zotero, if not My Library (found automatically when omitted)'),
      file: z.string().optional().describe('Target .bib (default: the first one the manuscript uses)'),
    },
  }, wrap(async ({ key, library, file }) => {
    const entry = await exportFromZotero(key, library);
    const r = addEntry(project, entry, file);
    return text(`Added \\cite{${r.key}} to ${r.file}:\n\n${formatEntry(parseBib(entry)[0])}`);
  }));

  registerResponseTools(server, { review, wrap, text });

  return server;
}
