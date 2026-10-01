import type { DB } from "../store/db.js";
import type { ChatMessage } from "./rules.js";

/** The conversation across one or more WhatsApp ids, oldest first (last 300 messages). */
export function chatFor(db: DB, waIds: string[]): ChatMessage[] {
  if (waIds.length === 0) return [];
  const marks = waIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, direction, type, body, timestamp FROM messages
       WHERE wa_id IN (${marks}) ORDER BY timestamp DESC, rowid DESC LIMIT 300`,
    )
    .all(...waIds) as ChatMessage[];
  return rows.reverse();
}
