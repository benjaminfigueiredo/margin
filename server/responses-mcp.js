// MCP tools for the response to referees (see responses.js). Two tools: one reads,
// one writes. Linking a suggestion when it is created goes through the `responds_to`
// parameter of suggest_edit / suggest_edits in mcp.js (pointForEdit below).
import { z } from 'zod';
import { STANCES, STANCE_LABEL } from './responses.js';

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s);

// The point a new suggestion will be linked to, checked before the suggestion is made.
// Implementing a point is only allowed once the author has confirmed its stance.
export function pointForEdit(review, ref) {
  if (!ref) return null;
  const p = review.responses.point(ref);
  if (!p.confirmed) throw new Error(`The author has not confirmed the stance on R${p.number} yet. Do not implement it until they confirm or change it in Margin's Response view.`);
  return p;
}

export const respondsToSchema = z.string().optional().describe('Response point this edit implements: its id or number such as "R1.3" (from get_response). Links the suggestion to that point. Only for points whose stance the author has confirmed.');

function describePoint(p, { full }) {
  const stance = p.stance ? `${STANCE_LABEL[p.stance]} (${p.confirmed ? 'confirmed by the author' : 'proposed, NOT confirmed by the author yet'})` : 'no stance yet';
  const status = p.status === 'mismatch' ? `MISMATCH: ${p.reasons.join('; ')} — the reply may claim a change the manuscript does not contain`
    : p.status === 'pending' ? `pending: ${p.reasons.join('; ')}` : 'done';
  const lines = [`R${p.number} [${p.id.slice(0, 8)}] — ${stance} — ${status}`];
  lines.push(`  referee: ${JSON.stringify(full ? p.refereeText : clip(p.refereeText, 300))}`);
  lines.push(p.reply ? `  reply${p.replyBy === 'you' ? ' (last edited by the author)' : ''}: ${JSON.stringify(p.reply)}` : '  reply: (none yet)');
  for (const l of p.links) {
    if (l.missing) { lines.push(`  linked ${l.id.slice(0, 8)}: deleted`); continue; }
    const where = l.line ? `${l.file}:${l.line}` : l.file;
    lines.push(`  linked ${l.id.slice(0, 8)}: ${l.status}${l.orphaned ? ' (text changed)' : ''}${l.archived ? ' (archived)' : ''} — ${where} — ${JSON.stringify(clip(l.quote, 80))} → ${JSON.stringify(clip(l.replacement, 80))}`);
  }
  return lines.join('\n');
}

export function registerResponseTools(server, { review, wrap, text }) {
  const responses = review.responses;

  server.registerTool('get_response', {
    title: 'Read the response to referees',
    description: 'Read the referee reports the author pasted into Margin\'s Response view and the point-by-point response drafted so far. For each point (R1.1, R1.2, …): the referee\'s text, the stance and whether the author has confirmed it, the reply, the linked suggestions, and a status derived from them: done, pending (with what is missing), or mismatch (a linked suggestion was rejected, deleted, or its text changed, so the reply may claim a change the manuscript does not contain). Reports are private: never copy them into the manuscript files.',
    inputSchema: {
      round: z.number().int().positive().optional().describe('Revision round (default: the latest)'),
      report_text: z.boolean().optional().describe('Include the full text of each report (default true). Pass false once the points are drafted.'),
    },
  }, wrap(async ({ round, report_text = true }) => {
    const v = responses.view({ round });
    if (!v.reports.length) return text(v.rounds.length ? `No reports in round ${round}. Rounds: ${v.rounds.join(', ')}.` : 'No referee report yet. Ask the author to paste it into Margin (Review panel → Response → Add report), or, if they pasted it here, save it with update_response\'s report parameter.');
    const s = v.summary;
    const out = [`Response to referees, round ${v.round}${v.rounds.length > 1 ? ` (rounds: ${v.rounds.join(', ')})` : ''}: ${v.points.length} point${v.points.length === 1 ? '' : 's'} — ${s.done} done, ${s.pending} pending, ${s.mismatch} mismatch.`];
    for (const r of v.reports) {
      const pts = v.points.filter((p) => p.reportId === r.id);
      out.push('', `## ${r.reviewer} — report ${r.id.slice(0, 8)}, ${pts.length} point${pts.length === 1 ? '' : 's'}`);
      if (report_text) out.push('', r.text, '');
      for (const p of pts) out.push(describePoint(p, { full: !report_text }));
    }
    const unconfirmed = v.points.filter((p) => !p.confirmed).map((p) => `R${p.number}`);
    if (unconfirmed.length) out.push('', `Waiting for the author to confirm the stance on: ${unconfirmed.join(', ')}. Do not implement those points yet.`);
    return text(out.join('\n'));
  }));

  server.registerTool('update_response', {
    title: 'Draft or revise the response to referees',
    description: 'Create, revise or delete points of the point-by-point response to the referees, and link or unlink the suggestions that implement them. Use it to split a report into numbered points, each quoting the referee verbatim with a proposed stance (agree, partly_agree, disagree, clarify — clarify for points that need an explanation but no change) and a draft reply; to revise a reply; or to link existing suggestions (or pass responds_to to suggest_edit instead). You cannot confirm a stance: the author confirms or changes each one in Margin, and changing a stance clears the confirmation. Do not suggest edits for a point before its stance is confirmed. A reply must only describe changes that are in linked suggestions. To save a report the author pasted in this conversation, pass report; new points then attach to it.',
    inputSchema: {
      report: z.object({
        reviewer: z.string().describe('Label such as "Reviewer 1"'),
        text: z.string().describe('The full report, verbatim'),
        round: z.number().int().positive().optional().describe('Revision round (default: the latest, or 1)'),
      }).optional().describe('Save a new referee report before applying the points'),
      points: z.array(z.object({
        point: z.string().optional().describe('Existing point to change: its id or number such as "R1.3". Omit to create a new point.'),
        report_id: z.string().optional().describe('Report a new point belongs to (default: the report saved in this call, or the only report of the latest round)'),
        number: z.string().optional().describe('Point number such as "1.3" (reviewer.point). Default: the next number for that reviewer.'),
        referee_text: z.string().optional().describe('The referee\'s point, quoted verbatim from the report. Required for a new point.'),
        stance: z.enum(STANCES).optional().describe('Proposed stance; the author confirms it in Margin'),
        reply: z.string().optional().describe('Draft reply to the referee, plain text'),
        link: z.array(z.string()).optional().describe('Suggestion ids to link (only once the author has confirmed the stance)'),
        unlink: z.array(z.string()).optional().describe('Suggestion ids to unlink'),
        delete: z.boolean().optional().describe('Delete this point'),
      })).max(100).optional(),
    },
  }, wrap(async ({ report, points = [] }) => {
    const out = [];
    responses.batch(() => {
      let saved = null;
      if (report) {
        saved = responses.addReport(report, 'claude');
        out.push(`Saved ${saved.reviewer}'s report (${saved.id.slice(0, 8)}, round ${saved.round}).`);
      }
      points.forEach((a, i) => {
        try {
          let p;
          if (a.delete && !a.point) throw new Error('delete needs point');
          if (a.point && a.delete) { p = responses.removePoint(a.point); out.push(`${i + 1}. deleted R${p.number}`); return; }
          if (a.point) {
            p = responses.revisePoint(a.point, { stance: a.stance, reply: a.reply, refereeText: a.referee_text, number: a.number }, 'claude');
          } else {
            p = responses.createPoint({ reportId: a.report_id || saved?.id, number: a.number, refereeText: a.referee_text, stance: a.stance, reply: a.reply }, 'claude');
          }
          for (const id of a.unlink || []) responses.unlink(p.id, id);
          if (a.link?.length) {
            if (!p.confirmed) throw new Error(`R${p.number} saved, but not linked: the author has not confirmed its stance yet`);
            for (const id of a.link) responses.link(p.id, id);
          }
          out.push(`${i + 1}. ${a.point ? 'revised' : 'created'} R${p.number} [${p.id.slice(0, 8)}]${p.stance ? ` — ${STANCE_LABEL[p.stance]}${p.confirmed ? '' : ', awaiting the author\'s confirmation'}` : ''}${p.itemIds.length ? ` — ${p.itemIds.length} linked` : ''}`);
        } catch (e) { out.push(`${i + 1}. FAILED: ${e.message}`); }
      });
    });
    if (!out.length) return text('Nothing to do: pass report and/or points.');
    return text(out.join('\n'));
  }));
}
