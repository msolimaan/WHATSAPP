# whatsapp-mcp

Connects Claude to your WhatsApp Business number through the official Cloud API
(Coexistence via a Meta partner such as 360dialog, or Meta directly), and keeps the
**Inhouse Creatives LEADS** Trello board in sync automatically.

> Status: **stage 1 of 7.** The webhook intake and message store work. MCP tools,
> Trello sync, follow-ups and OAuth come in the next stages.

## What works now
- `POST /webhook/<secret>` receives these webhooks, stores them, and skips duplicates:
  - `messages`: leads → you;
  - `smb_message_echoes`: what you type in the Business app;
  - `statuses`: sent, delivered, read, failed;
  - `history`: Coexistence backfill of up to 6 months;
  - `smb_app_state_sync`: contact names.
- `GET /webhook` answers Meta's verify-token check.
- `GET /health` shows the message count and when the last message arrived.
- A WhatsApp client with Meta-format payloads for both 360dialog and Meta direct. It retries on rate limits and turns errors into plain fixes.
- SQLite store with full-text search over every message type.

## Develop
```bash
npm install
npm test          # vitest, everything mocked
npm run build
cp .env.example .env   # fill in, then:
npm run dev
```

Every setting is described in `.env.example`.
