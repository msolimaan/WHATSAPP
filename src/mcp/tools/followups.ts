import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractPhones } from "../../crm/phones.js";
import { snippet } from "../../crm/rules.js";
import { parseLocalTime } from "../../crm/time.js";
import { build, type Content } from "../../followups/content.js";
import type { EnrollTarget, Step } from "../../followups/engine.js";
import { type LeadVars, varsFromCard } from "../../followups/vars.js";
import { windowStatus } from "../../store/queries.js";
import type { ToolContext } from "../context.js";
import { contactName, formatTime, label, resolveContact, safe, text, ToolError } from "../util.js";

const templateArg = z
  .object({
    name: z.string().min(1),
    language: z.string().min(2).describe("e.g. pt_BR, en"),
    body_params: z.array(z.string()).default([]).describe("Values for {{1}}, {{2}}…; may use {{name}}, {{first_name}}, {{company}}"),
  })
  .describe("Approved template, used when their 24h window is closed (it can't be a draft-only template)");

const contentArgs = {
  text: z.string().min(1).max(4096).optional().describe("Free text. Only sent if their 24h window is open at send time"),
  template: templateArg.optional(),
};

const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export function registerFollowupTools(server: McpServer, ctx: ToolContext): void {
  const tz = ctx.config.TIMEZONE;
  const fu = ctx.followups;
  const who = (waId: string) => label(waId, contactName(ctx.store.getContact(waId)));
  const nowWindow = (waId: string) => windowStatus(ctx.store.getContact(waId)).open;
  const when = (input: string) => {
    const ms = parseLocalTime(input, tz);
    if (Number.isNaN(ms)) throw new ToolError(`"${input}" isn't a time I can read. Use "YYYY-MM-DD HH:MM" (${tz}).`);
    if (ms < Date.now() - 60_000) throw new ToolError(`${input} is in the past.`);
    return Math.floor(ms / 1000);
  };
  const content = (a: { text?: string; template?: { name: string; language: string; body_params: string[] } }): Content => {
    if (!a.text && !a.template) throw new ToolError("Give text, a template, or both (text inside the 24h window, template outside it).");
    return { text: a.text, template: a.template };
  };
  const willSend = (waId: string, c: Content) => {
    const b = build(c, nowWindow(waId));
    return b.ok ? `If sent now: ${b.preview}${b.paid ? " (paid template)" : ""}` : `If sent now it would FAIL: ${b.reason}`;
  };

  // ---- drafts ---------------------------------------------------------------------

  server.registerTool(
    "whatsapp_draft_message",
    {
      title: "Draft a WhatsApp message for approval",
      description:
        "Saves a message as a draft for the owner to review. Nothing is sent. Use this for follow-ups you prepare; send with whatsapp_approve_drafts once the owner says yes.",
      inputSchema: { to: z.string().min(1).describe("Phone number or contact name"), ...contentArgs, note: z.string().optional().describe("Why, e.g. 'follow-up 1 after presentation'") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe((a) => {
      const waId = resolveContact(ctx.store, a.to);
      const c = content(a);
      const row = fu.createDraft(waId, c, a.note);
      return text(`Draft #${row.id} for ${who(row.wa_id)}: ${row.preview}\n${willSend(row.wa_id, c)}`);
    }),
  );

  server.registerTool(
    "whatsapp_list_drafts",
    {
      title: "List drafts and scheduled messages",
      description: "Shows drafts waiting for approval and messages scheduled for later, with ids for approving or cancelling.",
      inputSchema: { include_recent: z.boolean().default(false).describe("Also show the last sent, failed or cancelled ones") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(({ include_recent }) => {
      const pending = fu.listOutbox(["draft", "scheduled"]);
      const lines = pending.map((r) => {
        const stale = r.status === "draft" && (ctx.store.getContact(r.wa_id)?.last_inbound_at ?? 0) > r.created_at ? " ⚠ they wrote after this was drafted" : "";
        const status = r.status === "draft" ? "DRAFT" : `SCHEDULED ${formatTime(r.send_at, tz)}`;
        return `#${r.id} ${status} → ${who(r.wa_id)}: ${r.preview}${r.note ? ` (${r.note})` : ""}${stale}`;
      });
      if (include_recent) {
        for (const r of fu.listOutbox(["sent", "failed", "cancelled", "rejected"], 20).reverse()) {
          lines.push(`#${r.id} ${r.status.toUpperCase()} ${formatTime(r.updated_at, tz)} → ${who(r.wa_id)}: ${r.preview}${r.error ? ` (${r.error})` : ""}`);
        }
      }
      return text(lines.length ? `Times are ${tz}.\n${lines.join("\n")}` : "No drafts or scheduled messages.");
    }),
  );

  server.registerTool(
    "whatsapp_approve_drafts",
    {
      title: "Send or schedule approved drafts",
      description: "Sends the given drafts now, or schedules them for send_at. Only call after the owner approved these exact drafts.",
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1),
        send_at: z.string().optional().describe(`"YYYY-MM-DD HH:MM" in ${tz}; omit to send now`),
      },
      annotations: writes,
    },
    safe(async ({ ids, send_at }) => {
      const results = await fu.approve(ids, send_at ? when(send_at) : undefined);
      return text(results.map((r) => `${r.ok ? "✓" : "✗"} #${r.id}: ${r.detail}`).join("\n"));
    }),
  );

  server.registerTool(
    "whatsapp_cancel_pending",
    {
      title: "Reject drafts or cancel scheduled messages",
      description: "Rejects drafts or cancels scheduled messages by id.",
      inputSchema: { ids: z.array(z.number().int().positive()).min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(({ ids }) => text(fu.discard(ids).map((r) => `${r.ok ? "✓" : "✗"} #${r.id}: ${r.detail}`).join("\n"))),
  );

  server.registerTool(
    "whatsapp_schedule_message",
    {
      title: "Schedule a WhatsApp message",
      description:
        "Sends a message at a set time. By default it's cancelled if they write before then. At send time, text is used if their 24h window is open, otherwise the template.",
      inputSchema: {
        to: z.string().min(1),
        ...contentArgs,
        send_at: z.string().describe(`"YYYY-MM-DD HH:MM" in ${tz}`),
        cancel_on_reply: z.boolean().default(true),
        note: z.string().optional(),
      },
      annotations: writes,
    },
    safe((a) => {
      const waId = resolveContact(ctx.store, a.to);
      const c = content(a);
      const row = fu.schedule(waId, c, when(a.send_at), a.cancel_on_reply, a.note);
      return text(`Scheduled #${row.id} for ${formatTime(row.send_at, tz)} (${tz}) → ${who(row.wa_id)}: ${row.preview}${a.cancel_on_reply ? ". Cancelled automatically if they write first." : ""}`);
    }),
  );

  // ---- sequences ------------------------------------------------------------------

  server.registerTool(
    "followup_create_sequence",
    {
      title: "Create an automatic follow-up sequence",
      description:
        "Defines follow-up steps sent automatically to enrolled leads, e.g. step 1 three days after enrolling, step 2 four days later. A lead leaves the sequence when they reply, opt out, or the owner messages them from the phone. Steps to leads who haven't replied need an approved template (free text only works inside the 24h window). Placeholders: {{name}}, {{first_name}}, {{company}}.",
      inputSchema: {
        name: z.string().min(1).max(60),
        steps: z
          .array(
            z.object({
              after_days: z.number().min(0).max(60).describe("Days after the previous step (first step: after enrolling)"),
              ...contentArgs,
            }),
          )
          .min(1)
          .max(6),
        replace: z.boolean().default(false).describe("Overwrite an existing sequence with this name (active leads continue with the new steps)"),
      },
      annotations: writes,
    },
    safe(({ name, steps, replace }) => {
      let r;
      try {
        r = fu.saveSequence(name, steps as Step[], replace);
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
      const lines = [`Saved sequence "${name}" with ${steps.length} step(s).`];
      steps.forEach((s, i) => lines.push(`${i + 1}. after ${s.after_days} day(s): ${[s.text && `“${snippet(s.text, 60)}”`, s.template && `template ${s.template.name}/${s.template.language}`].filter(Boolean).join(" · else ")}`));
      for (const w of r.warnings) lines.push(`⚠ ${w}`);
      lines.push(`Quiet hours ${ctx.config.FOLLOWUP_QUIET_HOURS}${ctx.config.FOLLOWUP_SKIP_WEEKENDS ? ", no weekends" : ""}; at most ${ctx.config.FOLLOWUP_DAILY_TEMPLATE_CAP} paid templates a day.`);
      return text(lines.join("\n"));
    }),
  );

  server.registerTool(
    "followup_list_sequences",
    {
      title: "List follow-up sequences",
      description: "Shows each sequence's steps and how many leads are active, finished or stopped.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(() => {
      const rows = fu.listSequences();
      if (!rows.length) return text("No sequences yet. Create one with followup_create_sequence.");
      return text(
        rows
          .map((s) => {
            const steps = (JSON.parse(s.steps) as Step[]).map((st, i) => `   ${i + 1}. +${st.after_days}d: ${[st.text && `“${snippet(st.text, 50)}”`, st.template && `${st.template.name}/${st.template.language}`].filter(Boolean).join(" · else ")}`);
            return [`"${s.name}": ${s.active ?? 0} active, ${s.completed ?? 0} finished, ${s.stopped ?? 0} stopped`, ...steps].join("\n");
          })
          .join("\n\n"),
      );
    }),
  );

  server.registerTool(
    "followup_enroll",
    {
      title: "Add leads to a follow-up sequence",
      description:
        "Enrolls leads by contact, or every card in a Trello list (e.g. 'Follow Up'). {{name}}/{{company}} come from the card's CONTACT and COMPANY lines. Leads who opted out, are already enrolled, or are waiting on your reply are skipped. First call without confirm to preview; then call again with confirm=true after the owner agrees.",
      inputSchema: {
        sequence: z.string().min(1),
        contacts: z.array(z.string()).optional().describe("Phone numbers or contact names"),
        trello_list: z.string().optional().describe("A list on the CRM board, e.g. 'Follow Up' or 'Contacted'"),
        confirm: z.boolean().default(false),
      },
      annotations: writes,
    },
    safe(async ({ sequence, contacts, trello_list, confirm }) => {
      if (!contacts?.length && !trello_list) throw new ToolError("Give contacts or a trello_list.");
      const targets: EnrollTarget[] = [];
      const notes: string[] = [];
      if (contacts?.length) {
        for (const c of contacts) {
          const waId = resolveContact(ctx.store, c);
          targets.push({ waId, vars: await varsFor(ctx, waId), label: who(waId) });
        }
      }
      if (trello_list) {
        if (!ctx.crm) throw new ToolError("Trello isn't connected, so I can't read the list.");
        const board = await ctx.crm.getBoard();
        const stage = [...board.listByStage.entries()].find(([, l]) => l.name.toLowerCase() === trello_list.trim().toLowerCase())?.[0];
        if (!stage) throw new ToolError(`No list named "${trello_list}" in the pipeline. Lists: ${[...board.listByStage.values()].map((l) => l.name).join(", ")}.`);
        for (const card of board.cardsIn(stage)) {
          const digits = extractPhones(`${card.name}\n${card.desc}`)[0];
          if (!digits) {
            notes.push(`- ${card.name}: no WhatsApp number on the card`);
            continue;
          }
          if (ctx.crm.match(board, digits).kind === "conflict") {
            notes.push(`- ${card.name}: its number is on more than one card`);
            continue;
          }
          targets.push({ waId: digits, cardId: card.id, vars: varsFromCard(card, contactName(ctx.store.getContact(digits))), label: card.name });
        }
      }
      let check;
      try {
        check = fu.checkEnroll(sequence, targets);
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
      const skipped = [...check.skipped.map((s) => `- ${s.target.label ?? s.target.waId}: ${s.reason}`), ...notes];
      if (!confirm) {
        const seq = fu.sequence(sequence)!;
        const first = (JSON.parse(seq.steps) as Step[])[0];
        const sample = check.ok[0] ? build(first, false, check.ok[0].vars) : undefined;
        return text(
          [
            `Would enroll ${check.ok.length} lead(s) in "${seq.name}":`,
            ...check.ok.map((t) => `- ${t.label ?? t.waId}${t.vars?.name ? ` (name: ${t.vars.name}${t.vars.company ? `, company: ${t.vars.company}` : ""})` : ""}`),
            skipped.length ? `Skipped ${skipped.length}:` : "",
            ...skipped,
            sample ? `First step for ${check.ok[0].label}: ${sample.ok ? sample.preview : `can't send: ${sample.reason}`}` : "",
            "Nothing is enrolled yet. Call again with confirm=true once the owner agrees.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      const r = fu.enroll(sequence, targets);
      return text([`Enrolled ${r.enrolled.length} lead(s) in "${sequence}".`, skipped.length ? `Skipped ${skipped.length}:` : "", ...skipped].filter(Boolean).join("\n"));
    }),
  );

  server.registerTool(
    "followup_stop",
    {
      title: "Take a lead out of follow-up sequences",
      description: "Stops automatic follow-ups for a contact, in one sequence or all of them.",
      inputSchema: { contact: z.string().min(1), sequence: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(({ contact, sequence }) => {
      const waId = resolveContact(ctx.store, contact);
      const n = fu.stopFor(waId, "stopped by you", sequence);
      return text(n ? `Stopped ${n} sequence(s) for ${who(waId)}.` : `${who(waId)} isn't in ${sequence ? `"${sequence}"` : "any sequence"}.`);
    }),
  );

  server.registerTool(
    "followup_status",
    {
      title: "Follow-up sequence status",
      description: "Who is in which sequence, which step is next and when, and why finished ones stopped.",
      inputSchema: {
        contact: z.string().optional(),
        sequence: z.string().optional(),
        status: z.enum(["active", "completed", "stopped"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(({ contact, sequence, status }) => {
      const waId = contact ? resolveContact(ctx.store, contact) : undefined;
      const rows = fu.enrollments({ waId, sequenceName: sequence, status });
      if (!rows.length) return text("No matching enrollments.");
      return text(
        rows
          .slice(0, 60)
          .map((e) => {
            const total = (JSON.parse(e.steps) as Step[]).length;
            const state =
              e.status === "active"
                ? `next: step ${e.step + 1}/${total} at ${formatTime(e.next_at, tz)}`
                : e.status === "completed"
                  ? `finished all ${total} steps`
                  : `stopped (${e.stop_reason})`;
            return `- ${who(e.wa_id)} · "${e.sequence}" · ${state}`;
          })
          .join("\n") + (rows.length > 60 ? `\n…and ${rows.length - 60} more` : ""),
      );
    }),
  );
}

async function varsFor(ctx: ToolContext, waId: string): Promise<LeadVars> {
  if (ctx.crm) {
    try {
      const board = await ctx.crm.getBoard();
      const m = ctx.crm.match(board, waId);
      if (m.kind === "card") return varsFromCard(m.card, contactName(ctx.store.getContact(waId)));
    } catch {
      // Fall back to the WhatsApp name.
    }
  }
  const name = contactName(ctx.store.getContact(waId));
  return name ? { name, first_name: name.split(/\s+/)[0] } : {};
}
