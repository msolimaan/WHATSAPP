import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { displayPhone } from "../../crm/phones.js";
import { dailyReport } from "../../crm/report.js";
import type { CrmSync, Preview } from "../../crm/sync.js";
import type { ToolContext } from "../context.js";
import { formatTime, resolveContact, safe, text, ToolError } from "../util.js";

function needCrm(ctx: ToolContext): CrmSync {
  if (!ctx.crm) throw new ToolError("Trello isn't connected. Set TRELLO_API_KEY and TRELLO_TOKEN on the server.");
  return ctx.crm;
}

function renderPreview(p: Preview, tz: string): string {
  const lines = [`Preview ${p.id}: ${p.items.length} change(s). Nothing has been changed yet.`, ""];
  const moves = p.items.filter((i) => i.kind === "move");
  const creates = p.items.filter((i) => i.kind === "create");
  if (moves.length) {
    lines.push("Card moves:");
    for (const i of moves) lines.push(`#${i.n} ${i.cardName}: ${i.from} → ${i.to}${i.setDue ? " (due today 09:00)" : ""}. Why: ${i.reason}`);
    lines.push("");
  }
  if (creates.length) {
    lines.push("New cards in Leads (unknown numbers that wrote to you):");
    for (const i of creates) lines.push(`#${i.n} ${i.cardName}. Why: ${i.reason}`);
    lines.push("");
  }
  if (p.conflicts.length) {
    lines.push("Same number on several cards (left alone until fixed):");
    for (const c of p.conflicts) lines.push(`- ${c.number}: ${c.cards.map((x) => `${x.name} ${x.url}`).join(" | ")}`);
    lines.push("");
  }
  if (p.archived.length) {
    lines.push("Leads on ARCHIVED cards who wrote recently (not touched):");
    for (const a of p.archived) lines.push(`- ${a.card} ${a.url} (last message ${formatTime(a.lastAt, tz)})`);
    lines.push("");
  }
  if (p.untracked.length) {
    lines.push("Chats where you wrote but there's no card (not touched):");
    for (const u of p.untracked.slice(0, 30)) lines.push(`- ${u.name ?? "?"} ${displayPhone(u.waId)} (last ${formatTime(u.lastAt, tz)})`);
    if (p.untracked.length > 30) lines.push(`- …and ${p.untracked.length - 30} more`);
    lines.push("");
  }
  if (p.olderUnknown) lines.push(`${p.olderUnknown} older chat(s) from unknown numbers are outside the lookback window and were ignored.`, "");
  lines.push(
    `To apply: crm_apply_sync with preview_id "${p.id}" (optionally only some item numbers). Applying switches the sync to live.`,
    "To keep a number from ever getting a card (a friend, a supplier): crm_link_number_to_card with card omitted.",
  );
  return lines.join("\n");
}

export function registerCrmTools(server: McpServer, ctx: ToolContext): void {
  const tz = ctx.config.TIMEZONE;

  server.registerTool(
    "crm_daily_report",
    {
      title: "WhatsApp & CRM daily report",
      description:
        "Morning briefing: message activity, who is waiting on your reply, cards the sync moved or created, follow-ups due today, automatic replies, and anything needing attention.",
      inputSchema: { hours: z.number().int().min(1).max(24 * 14).default(24).describe("How far back to look") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ hours }) => text(await dailyReport({ config: ctx.config, store: ctx.store, sync: ctx.crm }, hours))),
  );

  server.registerTool(
    "crm_preview_sync",
    {
      title: "Preview Trello changes",
      description:
        "Compares all WhatsApp history with the Trello board and lists every card move and new card the rules would make. Changes nothing. Run before switching the sync to live, or any time to catch up.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async () => text(renderPreview(await needCrm(ctx).preview(), tz))),
  );

  server.registerTool(
    "crm_apply_sync",
    {
      title: "Apply previewed Trello changes",
      description:
        "Applies the latest preview from crm_preview_sync: all items, or only the numbers listed. Cards that changed since the preview are skipped. By default this also switches the sync to live.",
      inputSchema: {
        preview_id: z.string(),
        items: z.array(z.number().int().positive()).optional().describe("Item numbers to apply; omit for all"),
        go_live: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ preview_id, items, go_live }) => {
      let r;
      try {
        r = await needCrm(ctx).apply(preview_id, items, go_live);
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
      const lines = [`Applied ${r.applied.length}, skipped ${r.skipped.length}, failed ${r.failed.length}. Sync mode: ${r.mode.toUpperCase()}.`];
      for (const a of r.applied) lines.push(`✓ ${a}`);
      for (const s of r.skipped) lines.push(`– ${s}`);
      for (const f of r.failed) lines.push(`✗ ${f}`);
      return text(lines.join("\n"));
    }),
  );

  server.registerTool(
    "crm_set_mode",
    {
      title: "Pause or resume the Trello sync",
      description: "'live' moves and creates cards automatically; 'preview' pauses all automatic Trello changes (crm_preview_sync still works).",
      inputSchema: { mode: z.enum(["live", "preview"]) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(({ mode }) => {
      needCrm(ctx).setMode(mode);
      return text(mode === "live" ? "Sync is LIVE: Trello updates automatically." : "Sync PAUSED (preview mode): no automatic Trello changes.");
    }),
  );

  server.registerTool(
    "crm_find_card",
    {
      title: "Find the Trello card for a WhatsApp contact",
      description: "Shows which CRM card a contact matches (by the number written on the card or a manual link), its list, and why.",
      inputSchema: { contact: z.string().describe("Phone number with country code, or part of a contact's name") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ contact }) => {
      const crm = needCrm(ctx);
      const waId = resolveContact(ctx.store, contact);
      const board = await crm.getBoard();
      const m = crm.match(board, waId);
      switch (m.kind) {
        case "card":
          return text(`${displayPhone(waId)} → ${m.card.name} [${board.listName(m.card.idList)}] ${m.card.shortUrl}`);
        case "archived":
          return text(`${displayPhone(waId)} is only on an ARCHIVED card: ${m.card.name} ${m.card.shortUrl}`);
        case "conflict":
          return text(`${displayPhone(waId)} is on several open cards:\n${m.cards.map((c) => `- ${c.name} [${board.listName(c.idList)}] ${c.shortUrl}`).join("\n")}\nUse crm_link_number_to_card to pick one.`);
        case "ignored":
          return text(`${displayPhone(waId)} is marked "not a lead": the sync never creates a card for it.`);
        default:
          return text(`No card has ${displayPhone(waId)}. If they write in, the sync will create one in Leads (when live).`);
      }
    }),
  );

  server.registerTool(
    "crm_link_number_to_card",
    {
      title: "Link a WhatsApp number to a Trello card",
      description:
        "Ties a number to a specific card (use when the number isn't written on the card, or is on several), or, with card omitted, marks the number as not a lead so no card is ever created for it.",
      inputSchema: {
        number: z.string().describe("Phone number with country code"),
        card: z.string().optional().describe("Card URL (https://trello.com/c/…) or id; omit to mark 'not a lead'"),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ number, card, note }) => {
      try {
        return text(`Linked: ${await needCrm(ctx).link(number, card ?? null, note)}`);
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    }),
  );

  server.registerTool(
    "crm_sync_status",
    {
      title: "Trello sync status",
      description: "Shows whether the sync is live or paused, when the board was last read, and recent failures.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async () => {
      const crm = needCrm(ctx);
      const board = await crm.getBoard();
      const day = Math.floor(Date.now() / 1000) - 86400;
      const stats = ctx.store.db
        .prepare(`SELECT SUM(ok) AS ok, SUM(1 - ok) AS failed FROM crm_actions WHERE at >= ?`)
        .get(day) as { ok: number | null; failed: number | null };
      const lastErr = ctx.store.db
        .prepare(`SELECT at, card_name, error FROM crm_actions WHERE ok = 0 ORDER BY at DESC LIMIT 1`)
        .get() as { at: number; card_name: string; error: string } | undefined;
      const open = [...board.cards.values()].filter((c) => !c.closed);
      return text(
        [
          `Mode: ${crm.mode.toUpperCase()}${crm.mode === "preview" ? " (nothing changes on Trello automatically)" : ""}`,
          `Board read at ${formatTime(board.loadedAt / 1000, tz)}: ${open.length} open cards, ${open.filter((c) => board.phoneKeysOf(c).length).length} with a WhatsApp number`,
          `Numbers on several cards: ${board.conflicts().length}`,
          `Last 24h: ${stats.ok ?? 0} changes, ${stats.failed ?? 0} failures`,
          lastErr ? `Last failure ${formatTime(lastErr.at, tz)} on "${lastErr.card_name}": ${lastErr.error}` : "No failures recorded.",
          `Rules: Contacted → Follow Up after ${ctx.config.CRM_FOLLOW_UP_DAYS} days without a reply.`,
        ].join("\n"),
      );
    }),
  );

  server.registerPrompt(
    "morning_whatsapp_review",
    {
      title: "Morning WhatsApp review",
      description: "Daily routine: report, reply to who's waiting, and plan follow-ups.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Run my morning WhatsApp review:",
              "1. Call crm_daily_report and give me the short version first.",
              "2. For each person waiting on my reply, read the chat (whatsapp_get_messages) and the Trello card, then draft a reply in their language. Use the inhouse-cold-whatsapp-format style for outreach messages.",
              "3. For follow-ups due today, draft the follow-up. If their 24h window is closed, pick a fitting approved template (whatsapp_list_templates) instead of free text.",
              "4. Show me every draft with the recipient. Don't send anything until I approve each one.",
              "5. After sending, update the card's STATUS, OUTREACH / REPLY HISTORY and NEXT ACTION on Trello in the card's existing format.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
