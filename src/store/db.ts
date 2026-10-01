import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

// Append-only list: never edit a migration that has shipped, add a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE contacts (
    wa_id            TEXT PRIMARY KEY,          -- digits with country code, e.g. 5511990001111
    profile_name     TEXT,                      -- name the person set in WhatsApp
    saved_name       TEXT,                      -- name in your phone's address book (Coexistence contact sync)
    first_seen_at    INTEGER NOT NULL,          -- unix seconds
    last_inbound_at  INTEGER,                   -- their latest message to you
    last_outbound_at INTEGER,                   -- your latest message to them
    opted_out        INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE messages (
    id                TEXT PRIMARY KEY,         -- WhatsApp message id (wamid.…)
    wa_id             TEXT NOT NULL REFERENCES contacts(wa_id),
    direction         TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    source            TEXT NOT NULL CHECK (source IN ('webhook', 'echo', 'history', 'api')),
    type              TEXT NOT NULL,
    body              TEXT,                     -- text, caption, or a short description for other types
    media_id          TEXT,
    media_mime        TEXT,
    reply_to          TEXT,                     -- id of the quoted message
    status            TEXT,                     -- sent | delivered | read | failed (outbound only)
    error             TEXT,
    timestamp         INTEGER NOT NULL,         -- unix seconds, from WhatsApp
    raw               TEXT NOT NULL,            -- original JSON, for anything not broken out above
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX messages_by_chat ON messages (wa_id, timestamp);
  CREATE INDEX messages_by_time ON messages (timestamp);

  CREATE VIRTUAL TABLE messages_fts USING fts5 (body, content='messages', content_rowid='rowid');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF body ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
    INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;

  -- Every webhook delivery, kept raw so a parsing bug can be fixed and replayed.
  CREATE TABLE webhook_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at INTEGER NOT NULL,
    field       TEXT,
    payload     TEXT NOT NULL,
    error       TEXT
  );

  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
