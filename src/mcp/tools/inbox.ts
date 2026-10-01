import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findContacts, listConversations, searchMessages, windowStatus } from "../../store/queries.js";
import type { ToolContext } from "../context.js";
import { contactName, formatMessage, formatTime, json, label, resolveContact, safe, text, ToolError } from "../util.js";

const contactArg = z
  .string()
  .min(1)
  .describe('Phone number with country code in any format ("+55 11 99000-1111"), or part of the contact\'s name');

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

export function registerInboxTools(server: McpServer, ctx: ToolContext): void {
  const tz = ctx.config.TIMEZONE;

  server.registerTool(
    "whatsapp_list_conversations",
    {
      title: "List WhatsApp conversations",
      description:
        "Lists chats, newest first, with each chat's last message. Use filter 'awaiting_my_reply' to see who is waiting on you, 'awaiting_their_reply' for leads who haven't answered yet.",
      inputSchema: {
        filter: z.enum(["all", "awaiting_my_reply", "awaiting_their_reply"]).default("all"),
        query: z.string().optional().describe("Only chats whose name or number contains this"),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: readOnly,
    },
    safe(({ filter, query, limit, offset }) => {
      const rows = listConversations(ctx.store.db, { filter, query, limit: limit + 1, offset });
      const more = rows.length > limit;
      if (rows.length === 0) return text(offset ? "No more conversations." : "No conversations match.");
      const lines = rows.slice(0, limit).map((r) => {
        const arrow = r.last_direction === "in" ? "←" : "→";
        const body = (r.last_body ?? "").replace(/\s+/g, " ").slice(0, 120);
        const window = windowStatus(r).open ? " · window open" : "";
        return `- ${label(r.wa_id, r.name)} · ${formatTime(r.last_at, tz)} ${arrow} ${body} · ${r.message_count} msgs${window}`;
      });
      if (more) lines.push(`(more: call again with offset ${offset + limit})`);
      return text(`Times are ${tz}. ← = they wrote last, → = you wrote last.\n${lines.join("\n")}`);
    }),
  );

  server.registerTool(
    "whatsapp_get_messages",
    {
      title: "Read a WhatsApp chat",
      description:
        "Returns messages from one chat in chronological order (most recent page by default). Each line ends with the message id ‹wamid…› for replies, reactions and media downloads.",
      inputSchema: {
        contact: contactArg,
        limit: z.number().int().min(1).max(200).default(30),
        before: z.string().optional().describe("Message id: return messages older than this one (for paging back)"),
      },
      annotations: readOnly,
    },
    safe(({ contact, limit, before }) => {
      const waId = resolveContact(ctx.store, contact);
      let beforeTs: number | undefined;
      if (before) {
        const m = ctx.store.getMessage(before);
        if (!m) throw new ToolError(`Message ${before} not found.`);
        beforeTs = m.timestamp;
      }
      const c = ctx.store.getContact(waId);
      const rows = ctx.store.getMessages(waId, { limit, before: beforeTs }).reverse();
      if (rows.length === 0) return text(`No messages with +${waId}${before ? " before that message" : ""}.`);
      const name = contactName(c);
      const w = windowStatus(c);
      const header = [
        `Chat with ${label(waId, name)} (times ${tz})`,
        w.open
          ? `24h window OPEN until ${formatTime(w.closesAt, tz)}: free text allowed.`
          : "24h window CLOSED: only approved templates can be sent.",
        c?.opted_out ? "⚠ This contact has opted out of messages." : null,
        rows.length === limit ? `Older messages exist: pass before="${rows[0].id}".` : null,
      ].filter(Boolean);
      return text([...header, "", ...rows.map((m) => formatMessage(m, tz, name))].join("\n"));
    }),
  );

  server.registerTool(
    "whatsapp_search_messages",
    {
      title: "Search WhatsApp messages",
      description: "Full-text search across all chats (words match as prefixes, all words must appear). Optionally limit to one contact or a start date.",
      inputSchema: {
        query: z.string().min(1),
        contact: contactArg.optional(),
        since: z.string().optional().describe("ISO date, e.g. 2026-09-01"),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: readOnly,
    },
    safe(({ query, contact, since, limit }) => {
      const waId = contact ? resolveContact(ctx.store, contact) : undefined;
      const sinceSec = since ? Date.parse(since) / 1000 : undefined;
      if (since && Number.isNaN(sinceSec)) throw new ToolError(`"${since}" isn't a valid date. Use YYYY-MM-DD.`);
      const rows = searchMessages(ctx.store.db, query, { waId, since: sinceSec, limit });
      if (rows.length === 0) return text(`No messages match "${query}".`);
      return text(rows.map((m) => `- ${formatMessage(m, tz, m.name)} [chat: ${label(m.wa_id, m.name)}]`).join("\n"));
    }),
  );

  server.registerTool(
    "whatsapp_find_contacts",
    {
      title: "Find WhatsApp contacts",
      description: "Finds people who have a chat with your business number, by part of their name or number.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(10) },
      annotations: readOnly,
    },
    safe(({ query, limit }) => {
      const rows = findContacts(ctx.store.db, query, limit);
      if (rows.length === 0) return text(`No contacts match "${query}".`);
      return text(
        rows
          .map((c) => `- ${label(c.wa_id, contactName(c))} · last from them ${formatTime(c.last_inbound_at, tz)} · last from you ${formatTime(c.last_outbound_at, tz)}`)
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "whatsapp_get_contact",
    {
      title: "WhatsApp contact details",
      description: "Shows a contact's names, when each side last wrote, whether the 24-hour window is open, and opt-out status.",
      inputSchema: { contact: contactArg },
      annotations: readOnly,
    },
    safe(({ contact }) => {
      const waId = resolveContact(ctx.store, contact);
      const c = ctx.store.getContact(waId);
      if (!c) return text(`+${waId} has never messaged or been messaged from this number.`);
      const w = windowStatus(c);
      return json({
        wa_id: c.wa_id,
        whatsapp_link: `https://wa.me/${c.wa_id}`,
        profile_name: c.profile_name,
        saved_name: c.saved_name,
        first_seen: formatTime(c.first_seen_at, tz),
        last_message_from_them: formatTime(c.last_inbound_at, tz),
        last_message_from_you: formatTime(c.last_outbound_at, tz),
        window_open: w.open,
        window_closes: w.open ? formatTime(w.closesAt, tz) : null,
        opted_out: Boolean(c.opted_out),
        timezone: tz,
      });
    }),
  );
}
