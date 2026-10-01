import type { DB } from "./db.js";

export type Direction = "in" | "out";
export type Source = "webhook" | "echo" | "history" | "api";

export interface NewMessage {
  id: string;
  waId: string;
  direction: Direction;
  source: Source;
  type: string;
  body: string | null;
  mediaId?: string | null;
  mediaMime?: string | null;
  replyTo?: string | null;
  status?: string | null;
  timestamp: number;
  raw: unknown;
}

export interface MessageRow {
  id: string;
  wa_id: string;
  direction: Direction;
  source: Source;
  type: string;
  body: string | null;
  media_id: string | null;
  media_mime: string | null;
  reply_to: string | null;
  status: string | null;
  error: string | null;
  timestamp: number;
}

export interface ContactRow {
  wa_id: string;
  profile_name: string | null;
  saved_name: string | null;
  first_seen_at: number;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  opted_out: number;
  updated_at: number;
}

// A status only moves forward; "failed" always wins so errors aren't hidden by a late "sent".
const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

const now = () => Math.floor(Date.now() / 1000);

export class Store {
  constructor(readonly db: DB) {}

  upsertContact(c: { waId: string; profileName?: string | null; savedName?: string | null; at?: number }): void {
    const t = c.at ?? now();
    this.db
      .prepare(
        `INSERT INTO contacts (wa_id, profile_name, saved_name, first_seen_at, updated_at)
         VALUES (@waId, @profileName, @savedName, @t, @now)
         ON CONFLICT (wa_id) DO UPDATE SET
           profile_name  = COALESCE(excluded.profile_name, contacts.profile_name),
           saved_name    = COALESCE(excluded.saved_name, contacts.saved_name),
           first_seen_at = MIN(contacts.first_seen_at, excluded.first_seen_at),
           updated_at    = excluded.updated_at`,
      )
      .run({ waId: c.waId, profileName: c.profileName ?? null, savedName: c.savedName ?? null, t, now: now() });
  }

  /** Sets or clears the address-book name (Coexistence contact sync). */
  setSavedName(waId: string, name: string | null): void {
    this.upsertContact({ waId });
    this.db.prepare(`UPDATE contacts SET saved_name = ?, updated_at = ? WHERE wa_id = ?`).run(name, now(), waId);
  }

  /** Stores a message once. Returns false when it was already stored (webhooks are redelivered). */
  recordMessage(m: NewMessage): boolean {
    return this.db.transaction(() => {
      this.upsertContact({ waId: m.waId, at: m.timestamp });
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO messages
             (id, wa_id, direction, source, type, body, media_id, media_mime, reply_to, status, timestamp, raw, created_at)
           VALUES (@id, @waId, @direction, @source, @type, @body, @mediaId, @mediaMime, @replyTo, @status, @timestamp, @raw, @createdAt)`,
        )
        .run({
          id: m.id,
          waId: m.waId,
          direction: m.direction,
          source: m.source,
          type: m.type,
          body: m.body,
          mediaId: m.mediaId ?? null,
          mediaMime: m.mediaMime ?? null,
          replyTo: m.replyTo ?? null,
          status: m.status ?? null,
          timestamp: m.timestamp,
          raw: JSON.stringify(m.raw),
          createdAt: now(),
        });
      if (result.changes === 0) return false;
      const column = m.direction === "in" ? "last_inbound_at" : "last_outbound_at";
      this.db
        .prepare(`UPDATE contacts SET ${column} = MAX(COALESCE(${column}, 0), ?), updated_at = ? WHERE wa_id = ?`)
        .run(m.timestamp, now(), m.waId);
      return true;
    })();
  }

  /** Applies a delivery status. Returns false for unknown messages or out-of-order updates. */
  updateStatus(id: string, status: string, error?: string | null): boolean {
    const row = this.db.prepare(`SELECT status FROM messages WHERE id = ?`).get(id) as { status: string | null } | undefined;
    if (!row) return false;
    const current = STATUS_RANK[row.status ?? ""] ?? 0;
    const next = STATUS_RANK[status] ?? 0;
    if (next <= current) return false;
    this.db.prepare(`UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE id = ?`).run(status, error ?? null, id);
    return true;
  }

  logWebhook(field: string | null, payload: unknown, error?: string): number {
    const r = this.db
      .prepare(`INSERT INTO webhook_events (received_at, field, payload, error) VALUES (?, ?, ?, ?)`)
      .run(now(), field, JSON.stringify(payload), error ?? null);
    return Number(r.lastInsertRowid);
  }

  setWebhookError(id: number, error: string): void {
    this.db.prepare(`UPDATE webhook_events SET error = ? WHERE id = ?`).run(error, id);
  }

  getContact(waId: string): ContactRow | undefined {
    return this.db.prepare(`SELECT * FROM contacts WHERE wa_id = ?`).get(waId) as ContactRow | undefined;
  }

  getMessage(id: string): MessageRow | undefined {
    return this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
  }

  /** Messages in one chat, newest first. */
  getMessages(waId: string, opts: { limit?: number; before?: number } = {}): MessageRow[] {
    return this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
         WHERE wa_id = ? AND timestamp < ?
         ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      )
      .all(waId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 50) as MessageRow[];
  }

  getKv(key: string): string | undefined {
    return (this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
  }

  setKv(key: string, value: string): void {
    this.db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, value);
  }
}

const MESSAGE_COLUMNS =
  "id, wa_id, direction, source, type, body, media_id, media_mime, reply_to, status, error, timestamp";
