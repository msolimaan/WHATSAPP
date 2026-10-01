import type { DB } from "./db.js";
import type { ContactRow, MessageRow } from "./store.js";

export const WINDOW_SECONDS = 24 * 60 * 60;

export type ConversationFilter = "all" | "awaiting_my_reply" | "awaiting_their_reply";

export interface ConversationRow {
  wa_id: string;
  name: string | null;
  last_at: number;
  last_direction: "in" | "out";
  last_body: string | null;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  message_count: number;
}

/** One row per chat with its latest message, newest chat first. */
export function listConversations(
  db: DB,
  opts: { filter?: ConversationFilter; query?: string; limit?: number; offset?: number } = {},
): ConversationRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 20, offset: opts.offset ?? 0 };
  if (opts.filter === "awaiting_my_reply") where.push("l.direction = 'in'");
  if (opts.filter === "awaiting_their_reply") where.push("l.direction = 'out'");
  if (opts.query) {
    where.push("(c.wa_id LIKE @q OR c.profile_name LIKE @q OR c.saved_name LIKE @q)");
    const isNumber = /^\+?[\d\s().-]+$/.test(opts.query.trim());
    params.q = `%${isNumber ? opts.query.replace(/\D/g, "") : opts.query.trim()}%`;
  }
  return db
    .prepare(
      `WITH latest AS (
         SELECT m.wa_id, m.direction, m.body, m.timestamp,
                ROW_NUMBER() OVER (PARTITION BY m.wa_id ORDER BY m.timestamp DESC, m.rowid DESC) AS rn,
                COUNT(*) OVER (PARTITION BY m.wa_id) AS n
         FROM messages m
       )
       SELECT c.wa_id, COALESCE(c.saved_name, c.profile_name) AS name,
              l.timestamp AS last_at, l.direction AS last_direction, l.body AS last_body,
              c.last_inbound_at, c.last_outbound_at, l.n AS message_count
       FROM latest l JOIN contacts c ON c.wa_id = l.wa_id
       WHERE l.rn = 1 ${where.length ? `AND ${where.join(" AND ")}` : ""}
       ORDER BY l.timestamp DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all(params) as ConversationRow[];
}

/** Full-text search across all messages. Plain words are matched as prefixes. */
export function searchMessages(
  db: DB,
  query: string,
  opts: { waId?: string; since?: number; limit?: number } = {},
): (MessageRow & { name: string | null })[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  return db
    .prepare(
      `SELECT m.id, m.wa_id, m.direction, m.source, m.type, m.body, m.media_id, m.media_mime, m.reply_to,
              m.status, m.error, m.timestamp, COALESCE(c.saved_name, c.profile_name) AS name
       FROM messages_fts f
       JOIN messages m ON m.rowid = f.rowid
       JOIN contacts c ON c.wa_id = m.wa_id
       WHERE messages_fts MATCH @match
         AND (@waId IS NULL OR m.wa_id = @waId)
         AND m.timestamp >= @since
       ORDER BY m.timestamp DESC
       LIMIT @limit`,
    )
    .all({ match, waId: opts.waId ?? null, since: opts.since ?? 0, limit: opts.limit ?? 20 }) as (MessageRow & {
    name: string | null;
  })[];
}

/** Escapes user input for FTS5: each word becomes a quoted prefix term. */
export function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ""))
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(" ");
}

export function findContacts(db: DB, query: string, limit = 10): ContactRow[] {
  const d = query.replace(/\D/g, "");
  const byNumber = d.length >= 4 && /^\+?[\d\s().-]+$/.test(query.trim());
  return db
    .prepare(
      byNumber
        ? `SELECT * FROM contacts WHERE wa_id LIKE @q ORDER BY updated_at DESC LIMIT @limit`
        : `SELECT * FROM contacts WHERE profile_name LIKE @q OR saved_name LIKE @q ORDER BY updated_at DESC LIMIT @limit`,
    )
    .all({ q: `%${byNumber ? d : query.trim()}%`, limit }) as ContactRow[];
}

export interface WindowStatus {
  open: boolean;
  /** Unix seconds when free-form messaging stops being allowed. */
  closesAt: number | null;
  lastInboundAt: number | null;
}

/** The customer-service window: free-form messages are allowed for 24h after their last message. */
export function windowStatus(contact: Pick<ContactRow, "last_inbound_at"> | undefined, nowSec = Date.now() / 1000): WindowStatus {
  const last = contact?.last_inbound_at ?? null;
  if (!last) return { open: false, closesAt: null, lastInboundAt: null };
  const closesAt = last + WINDOW_SECONDS;
  return { open: nowSec < closesAt, closesAt, lastInboundAt: last };
}
