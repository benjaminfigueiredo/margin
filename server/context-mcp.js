// MCP tools for the author's private context (server/context.js): list it, read a text item, and
// save a note. PDFs are not converted here: Claude Code's own Read tool reads them natively, so
// the listing gives each item's path.
import path from 'node:path';
import { z } from 'zod';

const PRIVATE = 'Private background from the author: use it to understand intent and constraints; never cite it, never copy it into the manuscript or the bibliography, and never write it anywhere that reaches git or Overleaf.';
const DEFAULT_LINES = 400;
const MAX_LINES = 2000;

const size = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const by = (s) => (s === 'claude' ? 'saved by Claude' : s === 'you' ? 'added by the author' : 'put in the folder by the author');

// One line for get_editor_state, so Claude notices the context exists.
export function contextSummary(context) {
  let n = 0;
  try { n = context.count(); } catch { return null; }
  return n ? `Context: ${n} item${n === 1 ? '' : 's'} of the author's private notes — list_context` : null;
}

export function registerContextTools(server, { project, context, wrap, text }) {
  server.registerTool('list_context', {
    title: 'List the author\'s private context',
    description: `List the notes, discussions and drafts the author keeps for this paper in Margin's Context view (.md, .txt and .pdf files in .review/context/, local only). For each item: name, type, size, description, when it was added and by whom, and its path relative to the paper folder. Read .md and .txt items with read_context; read PDFs with your own Read tool on the path given (it reads PDFs natively). ${PRIVATE}`,
    inputSchema: {},
  }, wrap(async () => {
    const { items, skipped, folder } = context.list();
    if (!items.length) return text(`The author has no private context for this paper yet${skipped.length ? ` (${skipped.length} file${skipped.length === 1 ? '' : 's'} in ${folder}/ cannot be used: only .md, .txt and .pdf files directly in the folder)` : ''}. They add it in Margin's Context view; save_context_note keeps something they ask you to.`);
    const lines = [`${items.length} context item${items.length === 1 ? '' : 's'} (folder: ${path.join(project.root, '.review', 'context')}). ${PRIVATE}`, ''];
    for (const it of items) {
      lines.push(`- ${it.name} — ${it.type.toUpperCase()}, ${size(it.size)}, ${by(it.source)} ${it.addedAt.slice(0, 10)}`);
      lines.push(`  path: ${it.path}`);
      lines.push(`  description: ${it.description ? JSON.stringify(it.description) : '(none)'}`);
      lines.push(`  read: ${it.type === 'pdf' ? 'your Read tool on the path above' : `read_context { "name": ${JSON.stringify(it.name)} }`}`);
    }
    if (skipped.length) lines.push('', `Not used (${skipped.length}): ${skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`);
    return text(lines.join('\n'));
  }));

  server.registerTool('read_context', {
    title: 'Read a context note',
    description: `Read a .md or .txt item from the author's private context (names from list_context), with line numbers. Long files come in parts: pass start_line and max_lines (default ${DEFAULT_LINES}, at most ${MAX_LINES}) to read on. For a PDF it returns the path to read with your own Read tool instead. ${PRIVATE}`,
    inputSchema: {
      name: z.string().describe('The item\'s name, exactly as list_context gives it, e.g. "Call with Anna 2026-10-12.md"'),
      start_line: z.number().int().positive().optional().describe('First line to return (default 1)'),
      max_lines: z.number().int().positive().max(MAX_LINES).optional().describe(`How many lines to return (default ${DEFAULT_LINES})`),
    },
  }, wrap(async ({ name, start_line, max_lines }) => {
    const it = context.get(name);
    if (it.type === 'pdf') {
      return text(`${it.name} is a PDF (${size(it.size)}). Read it with your own Read tool: ${path.join(project.root, it.path)} (relative to the paper folder: ${it.path}). ${PRIVATE}`);
    }
    const lines = context.readText(name).replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const s = (start_line || 1) - 1;
    if (s >= lines.length) throw new Error(`${it.name} has ${lines.length} lines; start_line ${start_line} is past the end.`);
    const e = Math.min(lines.length, s + (max_lines || DEFAULT_LINES));
    const head = `${it.name}${it.description ? ` — ${it.description}` : ''} (lines ${s + 1}–${e} of ${lines.length}${e < lines.length ? `; continue with start_line ${e + 1}` : ''}). ${PRIVATE}`;
    return text(`${head}\n\n${lines.slice(s, e).map((l, i) => `${String(s + i + 1).padStart(5)}  ${l}`).join('\n')}`);
  }));

  server.registerTool('save_context_note', {
    title: 'Save a note to the author\'s private context',
    description: 'Save text the author asked you to keep (a discussion they pasted, notes from a call, decisions about the paper) as a new Markdown item in their private context, marked as saved by Claude. It is stored in .review/context/ (local only, never committed or sent to Overleaf) and shows in Margin\'s Context view, where the author can edit its description or delete it. Never replaces an existing item: a name already taken gets a number. Only when the author asks; this is not the manuscript.',
    inputSchema: {
      title: z.string().describe('Short title; it becomes the file name and the note\'s heading'),
      body: z.string().describe('The note in Markdown, as the author gave it (do not summarise unless asked)'),
      description: z.string().optional().describe('One line on what it is, shown in the Context view'),
    },
  }, wrap(async ({ title, body, description }) => {
    const it = context.addNote({ title, body, description }, 'claude');
    return text(`Saved ${it.name} to the author's private context (${it.path}, ${size(it.size)}). It is local only and never reaches git or Overleaf.`);
  }));
}
