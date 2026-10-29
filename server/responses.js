// Response to referees: the referee reports the author pasted, split into numbered
// points (R1.1, R1.2, …), each with a stance, a reply and the suggestions that
// implement it. Stored in .review/responses.json (local only, like review.json: never
// in git, never pushed to Overleaf). ReviewStore owns this class, so the server stays
// the only writer of .review/.
//
// A point's status is never stored. It is derived on every read from the current state
// of the linked review items, so rejecting a suggestion, undoing an accept or editing
// the accepted text away updates it without anyone having to remember to.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VersionedJsonFile, locateApplied, locate, lineOf } from './review.js';

// Schema versioning works exactly as for review.json (see the top of review.js).
export const RESPONSES_VERSION = 1;
const MIGRATIONS = {
  0: (d) => ({ ...d, version: 1 }),
};

export const STANCES = ['agree', 'partly_agree', 'disagree', 'clarify'];
export const STANCE_LABEL = { agree: 'Agree', partly_agree: 'Partly agree', disagree: 'Disagree', clarify: 'Clarify' };
const NEEDS_CHANGE = new Set(['agree', 'partly_agree']);

export class ResponseStore {
  constructor(review) {
    this.review = review;
    this.file = path.join(review.project.reviewDir, 'responses.json');
    this.store = new VersionedJsonFile(this.file, {
      version: RESPONSES_VERSION, migrations: MIGRATIONS, what: 'response',
      check: (raw) => (Array.isArray(raw.reports) && Array.isArray(raw.points) ? null : 'no reports or points array'),
    });
    this.data = { version: RESPONSES_VERSION, reports: [], points: [] };
    this.deferred = 0;
    this.pending = false;
    const r = this.store.load();
    if (r) { this.data = r.data; if (r.migrated) this.save(); }
  }

  save() {
    if (this.deferred) { this.pending = true; return; }
    this.store.save(this.data);
    this.review.emit('responses-change');
  }

  // Run several changes and write the file once.
  batch(fn) {
    this.deferred++;
    try { return fn(); } finally {
      this.deferred--;
      if (!this.deferred && this.pending) { this.pending = false; this.save(); }
    }
  }

  // ---------- reports ----------

  report(id) {
    const r = id && this.data.reports.find((x) => x.id === id || x.id.startsWith(id));
    if (!r) throw new Error(`No referee report with id ${id}`);
    return r;
  }

  addReport({ reviewer, round, text }, by = 'you') {
    if (typeof text !== 'string' || !text.trim()) throw new Error('The report text is empty');
    const n = round == null || round === '' ? (this.latestRound() || 1) : Number(round);
    if (!Number.isInteger(n) || n < 1) throw new Error('round must be a whole number from 1');
    const label = typeof reviewer === 'string' && reviewer.trim() ? reviewer.trim() : `Reviewer ${this.data.reports.filter((r) => r.round === n).length + 1}`;
    const report = { id: crypto.randomUUID(), reviewer: label, round: n, text: text.replace(/\r\n?/g, '\n').trim(), createdAt: new Date().toISOString(), by };
    this.data.reports.push(report);
    this.save();
    return report;
  }

  // Removes the report and every point drawn from it.
  removeReport(id) {
    const r = this.report(id);
    this.data.reports = this.data.reports.filter((x) => x !== r);
    this.data.points = this.data.points.filter((p) => p.reportId !== r.id);
    this.save();
    return r;
  }

  latestRound() { return this.data.reports.reduce((m, r) => Math.max(m, r.round), 0); }

  // The reviewer's number for automatic point numbers: "Reviewer 2" -> 2, otherwise the
  // report's position among the reports of its round.
  reviewerNumber(report) {
    const m = report.reviewer.match(/(\d+)\s*$/);
    if (m) return Number(m[1]);
    return this.data.reports.filter((r) => r.round === report.round).sort(byCreated).indexOf(report) + 1;
  }

  // ---------- points ----------

  // A point by id (or its first characters) or by number ("1.3" or "R1.3"). Numbers
  // refer to the latest round that has that number; use the id for earlier rounds.
  point(ref) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('point is required');
    const s = ref.trim();
    const byId = this.data.points.find((p) => p.id === s) || (s.length >= 6 ? this.data.points.find((p) => p.id.startsWith(s)) : null);
    if (byId) return byId;
    const num = normNumber(s);
    if (num) {
      const hits = this.data.points.filter((p) => p.number === num);
      const round = Math.max(0, ...hits.map((p) => this.roundOf(p)));
      const latest = hits.filter((p) => this.roundOf(p) === round);
      if (latest.length === 1) return latest[0];
      if (latest.length > 1) throw new Error(`Several points are numbered ${num} in round ${round}; use the point id instead.`);
    }
    throw new Error(`No response point ${ref}. Call get_response for the point ids and numbers.`);
  }

  roundOf(p) { return this.data.reports.find((r) => r.id === p.reportId)?.round ?? 0; }

  createPoint({ reportId, number, refereeText, stance, reply }, by = 'claude') {
    const report = reportId ? this.report(reportId) : this.onlyReport();
    if (typeof refereeText !== 'string' || !refereeText.trim()) throw new Error('referee_text is required for a new point');
    let num;
    if (number != null && String(number).trim() !== '') {
      num = normNumber(String(number));
      if (!num) throw new Error(`Point number ${number} should look like 1.3 (reviewer.point)`);
    } else {
      const r = this.reviewerNumber(report);
      const used = this.data.points.filter((p) => p.reportId === report.id).map((p) => Number(p.number.split('.')[1]) || 0);
      num = `${r}.${Math.max(0, ...used) + 1}`;
    }
    const clash = this.data.points.find((p) => p.number === num && this.roundOf(p) === report.round);
    if (clash) throw new Error(`Round ${report.round} already has a point ${num} (${clash.id.slice(0, 8)}); revise that one or pick another number.`);
    if (stance != null && !STANCES.includes(stance)) throw new Error(`stance must be one of ${STANCES.join(', ')}`);
    const now = new Date().toISOString();
    const p = {
      id: crypto.randomUUID(), reportId: report.id, number: num, refereeText: refereeText.trim(),
      stance: stance ?? null, confirmed: false, reply: reply ?? '', replyBy: reply ? by : null,
      itemIds: [], createdAt: now, updatedAt: now,
    };
    this.data.points.push(p);
    this.save();
    return p;
  }

  onlyReport() {
    const latest = this.latestRound();
    const rs = this.data.reports.filter((r) => r.round === latest);
    if (rs.length === 1) return rs[0];
    throw new Error(rs.length ? 'There are several reports; say which one the point belongs to (report_id from get_response).' : 'There is no referee report yet. Ask the author to paste it in Margin (Response view), or save it with the report parameter.');
  }

  // Only the author confirms a stance. A stance the author picks is confirmed by that
  // choice; a stance Claude changes needs the author's confirmation again.
  revisePoint(ref, { stance, confirmed, reply, refereeText, number } = {}, by = 'claude') {
    const p = this.point(ref);
    if (stance !== undefined) {
      if (stance !== null && !STANCES.includes(stance)) throw new Error(`stance must be one of ${STANCES.join(', ')}`);
      if (by === 'you') { p.stance = stance; p.confirmed = stance != null; }
      else if (stance !== p.stance) { p.stance = stance; p.confirmed = false; }
    }
    if (confirmed !== undefined && by === 'you') {
      if (confirmed && !p.stance) throw new Error('Pick a stance before confirming it');
      p.confirmed = !!confirmed;
    }
    if (p.confirmed && (stance !== undefined || confirmed !== undefined)) p.confirmedAt = new Date().toISOString();
    if (!p.confirmed) delete p.confirmedAt;
    if (reply !== undefined) {
      if (typeof reply !== 'string') throw new Error('reply must be text');
      if (reply !== p.reply) { p.reply = reply; p.replyBy = by; }
    }
    if (refereeText !== undefined) {
      if (typeof refereeText !== 'string' || !refereeText.trim()) throw new Error('referee_text cannot be empty');
      p.refereeText = refereeText.trim();
    }
    if (number !== undefined && number !== null && String(number).trim() !== '') {
      const num = normNumber(String(number));
      if (!num) throw new Error(`Point number ${number} should look like 1.3 (reviewer.point)`);
      const clash = this.data.points.find((x) => x !== p && x.number === num && this.roundOf(x) === this.roundOf(p));
      if (clash) throw new Error(`Round ${this.roundOf(p)} already has a point ${num}`);
      p.number = num;
    }
    p.updatedAt = new Date().toISOString();
    this.save();
    return p;
  }

  // Only suggestions can be linked: a point's status says whether the change its reply
  // describes is in the manuscript, and only a suggestion changes the manuscript.
  link(ref, itemId) {
    const p = this.point(ref);
    const it = this.review.get(itemId);
    if (it.kind !== 'suggestion') throw new Error(`${it.id.slice(0, 8)} is a comment; only suggestions can be linked to a point`);
    if (!p.itemIds.includes(it.id)) { p.itemIds.push(it.id); p.updatedAt = new Date().toISOString(); this.save(); }
    return p;
  }

  unlink(ref, itemId) {
    const p = this.point(ref);
    const id = p.itemIds.find((x) => x === itemId || (itemId && itemId.length >= 6 && x.startsWith(itemId)));
    if (!id) throw new Error(`Suggestion ${itemId} is not linked to point ${p.number}`);
    p.itemIds = p.itemIds.filter((x) => x !== id);
    p.updatedAt = new Date().toISOString();
    this.save();
    return p;
  }

  removePoint(ref) {
    const p = this.point(ref);
    this.data.points = this.data.points.filter((x) => x !== p);
    this.save();
    return p;
  }

  // ---------- derived status ----------

  // Everything the UI and get_response show: reports and points of one round (default:
  // the latest), each point with its linked suggestions and derived status.
  view({ round } = {}) {
    const rounds = [...new Set(this.data.reports.map((r) => r.round))].sort((a, b) => a - b);
    const shown = round ? Number(round) : rounds[rounds.length - 1] ?? null;
    const reports = this.data.reports.filter((r) => r.round === shown)
      .sort((a, b) => this.reviewerNumber(a) - this.reviewerNumber(b) || byCreated(a, b));
    const ctx = this.linkContext();
    const all = this.data.points.map((p) => this.withStatus(p, ctx));
    const order = new Map(reports.map((r, i) => [r.id, i]));
    const points = all.filter((p) => order.has(p.reportId))
      .sort((a, b) => order.get(a.reportId) - order.get(b.reportId) || compareNumbers(a.number, b.number));
    const summary = { done: 0, pending: 0, mismatch: 0 };
    for (const p of points) summary[p.status]++;
    // Across all rounds, for the badge on the Response tab.
    const mismatchAll = all.filter((p) => p.status === 'mismatch').length;
    return { rounds, round: shown, reports, points, summary, mismatchAll };
  }

  linkContext() {
    const items = new Map(this.review.list({ status: 'all' }).map((it) => [it.id, it]));
    let archived = new Map();
    try {
      const a = JSON.parse(fs.readFileSync(path.join(path.dirname(this.review.file), 'archive.json'), 'utf8')).items || [];
      archived = new Map(a.map((it) => [it.id, it]));
    } catch { /* nothing archived yet */ }
    const texts = new Map();
    const textOf = (f) => {
      if (!texts.has(f)) { try { texts.set(f, this.review.project.read(f)); } catch { texts.set(f, null); } }
      return texts.get(f);
    };
    return { items, archived, textOf };
  }

  // One linked suggestion as seen now. `problem` is set when the reply may claim a change
  // the manuscript does not contain.
  linkInfo(id, { items, archived, textOf }) {
    const it = items.get(id) || archived.get(id);
    const short = id.slice(0, 8);
    if (!it) return { id, missing: true, status: 'deleted', problem: `suggestion ${short} was deleted` };
    const out = { id: it.id, file: it.file, quote: it.quote, replacement: it.replacement, status: it.status, author: it.author, line: it.line ?? null, archived: !items.has(id) };
    if (it.status === 'rejected') out.problem = `suggestion ${short} was ${it.decidedBy === 'claude' ? 'withdrawn by Claude' : 'rejected'}`;
    else if (it.status === 'resolved') out.problem = `suggestion ${short} was closed without being applied`;
    else if (it.status === 'open') {
      const text = textOf(it.file);
      const loc = text == null ? null : locate(it, text);
      if (!loc) { out.orphaned = true; out.problem = `the text suggestion ${short} would change has been edited since, so it can no longer be accepted`; }
      else out.line = lineOf(text, loc.from);
    } else if (it.status === 'accepted') {
      out.appliedReplacement = it.appliedReplacement ?? it.replacement;
      const text = textOf(it.file);
      if (text == null) out.problem = `${it.file}, where suggestion ${short} was accepted, no longer exists`;
      else {
        const span = locateApplied(it, text);
        if (span) out.line = lineOf(text, span.from);
        // A deletion leaves nothing to look for; only its surroundings, which may have been
        // edited for other reasons. Only an inserted text that is gone counts as a mismatch.
        else if (out.appliedReplacement.trim()) { out.orphaned = true; out.problem = `suggestion ${short} was accepted, but its text is no longer in ${it.file}`; }
      }
    }
    return out;
  }

  withStatus(p, ctx) {
    const links = p.itemIds.map((id) => this.linkInfo(id, ctx));
    const report = this.data.reports.find((r) => r.id === p.reportId);
    const base = { ...p, label: `R${p.number}`, reviewer: report?.reviewer, round: report?.round, links };
    const problems = links.filter((l) => l.problem).map((l) => l.problem);
    if (problems.length) return { ...base, status: 'mismatch', reasons: problems };
    const reasons = [];
    if (!p.stance) reasons.push('no stance yet');
    else if (!p.confirmed) reasons.push('stance not confirmed by the author');
    if (!p.reply || !p.reply.trim()) reasons.push('no reply yet');
    const open = links.filter((l) => l.status === 'open').length;
    if (open) reasons.push(`${open} linked suggestion${open > 1 ? 's' : ''} still open`);
    if (!links.length && NEEDS_CHANGE.has(p.stance)) reasons.push('no suggestion linked yet');
    return { ...base, status: reasons.length ? 'pending' : 'done', reasons };
  }

  // ---------- export ----------

  // The response letter as text, for download. Never written to disk.
  letter({ format = 'md', round } = {}) {
    const v = this.view({ round });
    if (!v.reports.length) throw new Error('There is no referee report to respond to yet');
    const multi = v.rounds.length > 1;
    const groups = v.reports.map((r) => ({ r, points: v.points.filter((p) => p.reportId === r.id) }));
    if (format === 'tex') {
      const out = [
        '% Response to the reviewers, exported from Margin. Plain text: special characters are escaped.',
        '\\documentclass[11pt]{article}',
        '\\usepackage[T1]{fontenc}',
        '\\usepackage[utf8]{inputenc}',
        '\\usepackage[margin=2.5cm]{geometry}',
        '\\setlength{\\parindent}{0pt}',
        '\\setlength{\\parskip}{0.6em}',
        '\\newenvironment{referee}{\\begin{quote}\\itshape}{\\end{quote}}',
        '\\begin{document}',
        '',
        `\\section*{Response to the reviewers${multi ? ` (round ${v.round})` : ''}}`,
      ];
      for (const { r, points } of groups) {
        out.push('', `\\subsection*{${texEscape(r.reviewer)}}`);
        for (const p of points) {
          out.push('', `\\paragraph{Comment ${p.number}}`, '\\begin{referee}', texEscape(p.refereeText), '\\end{referee}',
            p.reply.trim() ? `\\textbf{Response.} ${texEscape(p.reply.trim())}` : '\\textbf{Response.} \\textit{[No reply yet.]}');
        }
      }
      out.push('', '\\end{document}', '');
      return out.join('\n');
    }
    const out = [`# Response to the reviewers${multi ? ` (round ${v.round})` : ''}`];
    for (const { r, points } of groups) {
      out.push('', `## ${r.reviewer}`);
      for (const p of points) {
        out.push('', `### Comment ${p.number}`, '', p.refereeText.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n'), '',
          p.reply.trim() ? `**Response.** ${p.reply.trim()}` : '**Response.** _[No reply yet.]_');
      }
    }
    return out.join('\n') + '\n';
  }
}

function byCreated(a, b) { return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0; }

// "R1.3", "r 1.3", "1.3" -> "1.3"; anything else -> null.
function normNumber(s) {
  const m = s.trim().match(/^r?\s*(\d+(?:\.\d+)*[a-z]?)$/i);
  return m ? m[1] : null;
}

function compareNumbers(a, b) {
  const pa = a.split('.'), pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] ?? '-1', 10), y = parseInt(pb[i] ?? '-1', 10);
    if (x !== y) return x - y;
    if ((pa[i] ?? '') !== (pb[i] ?? '')) return (pa[i] ?? '').localeCompare(pb[i] ?? '');
  }
  return 0;
}

const TEX_SPECIAL = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}', '<': '\\textless{}', '>': '\\textgreater{}' };
export function texEscape(s) { return s.replace(/[\\{}&%$#_^~<>]/g, (c) => TEX_SPECIAL[c]); }

// REST routes for the Response view, mounted on the app's /api router. The UI is the
// author, so it may confirm stances; the letter export is a download only and never
// creates a file in the paper folder.
export function mountResponseRoutes(api, { review, handle, broadcast }) {
  const responses = review.responses;
  review.on('responses-change', () => broadcast({ type: 'responses-changed' }));
  const fields = (b = {}) => ({ stance: b.stance, confirmed: b.confirmed, reply: b.reply, refereeText: b.refereeText, number: b.number });
  api.get('/responses', handle(async (req) => responses.view({ round: req.query.round })));
  api.post('/responses/reports', handle(async (req) => responses.addReport({ reviewer: req.body.reviewer, round: req.body.round, text: req.body.text }, 'you')));
  api.delete('/responses/reports/:id', handle(async (req) => responses.removeReport(req.params.id)));
  api.post('/responses/points/:id', handle(async (req) => responses.revisePoint(req.params.id, fields(req.body), 'you')));
  api.post('/responses/points/:id/unlink', handle(async (req) => responses.unlink(req.params.id, String(req.body.itemId || ''))));
  api.delete('/responses/points/:id', handle(async (req) => responses.removePoint(req.params.id)));
  api.get('/responses/export', (req, res) => {
    const format = req.query.format === 'tex' ? 'tex' : 'md';
    let body;
    try { body = responses.letter({ format, round: req.query.round }); } catch (e) { res.status(400).json({ error: e.message }); return; }
    res.set('Content-Type', `${format === 'tex' ? 'application/x-tex' : 'text/markdown'}; charset=utf-8`);
    res.set('Content-Disposition', `attachment; filename="response-to-reviewers.${format}"`);
    res.set('Cache-Control', 'no-store');
    res.send(body);
  });
}
