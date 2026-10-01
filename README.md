# whatsapp-mcp

Connects Claude to your WhatsApp Business number through the official Cloud API
(Coexistence via a Meta partner such as 360dialog, or Meta directly), and keeps the
**Inhouse Creatives LEADS** Trello board in sync automatically.

> Status: **stage 2 of 7.** Webhook intake, message store and the WhatsApp tools work.
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

## Claude's WhatsApp tools (`/mcp`)
| Tool | What it does |
|---|---|
| `whatsapp_list_conversations` | Chats newest first; filter *awaiting my reply* or *awaiting their reply* |
| `whatsapp_get_messages` | Read a chat, with the 24h window state; page back with `before` |
| `whatsapp_search_messages` | Full-text search across all chats |
| `whatsapp_find_contacts` / `whatsapp_get_contact` | Look people up by name or number |
| `whatsapp_send_text` | Free text (24h window only), optionally quoting a message |
| `whatsapp_send_media` | Image, video, audio, document or sticker, by URL or upload |
| `whatsapp_send_template` | Approved template with variables, media header and URL button (works any time) |
| `whatsapp_send_buttons` | Text with up to 3 quick-reply buttons |
| `whatsapp_send_location` | Map pin |
| `whatsapp_react` / `whatsapp_mark_read` | Emoji reaction; blue ticks, optionally with "typing…" |
| `whatsapp_download_media` | Open a received photo, voice note or document |
| `whatsapp_list_templates` / `whatsapp_create_template` / `whatsapp_delete_template` | Manage templates |

Every send goes through one place, which refuses free text outside the 24-hour window, refuses templates to
people who opted out, and stores the message so it shows in the chat history.

Until OAuth lands (stage 5), `/mcp` needs `Authorization: Bearer $MCP_BEARER_TOKEN`, e.g.
`claude mcp add --transport http whatsapp https://<host>/mcp --header "Authorization: Bearer <token>"`.

## Develop
```bash
npm install
npm test          # vitest, everything mocked
npm run build
cp .env.example .env   # fill in, then:
npm run dev
```

Every setting is described in `.env.example`.
