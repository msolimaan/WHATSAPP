# whatsapp-mcp

Connects Claude to your WhatsApp Business number through the official Cloud API
(Coexistence via a Meta partner such as 360dialog, or Meta directly), and keeps the
**Inhouse Creatives LEADS** Trello board in sync automatically.

> Status: **stage 3 of 7.** Webhook intake, message store, WhatsApp tools and the Trello sync work.
> Follow-up sequences, OAuth and deployment come in the next stages.

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

## Trello CRM sync
The server keeps the **Inhouse Creatives LEADS** board in step with WhatsApp:

| When | Card moves |
|---|---|
| You message a lead (from your phone or through Claude) | Leads / Ready to Contact → **Contacted** |
| A lead replies | Leads / Ready to Contact / Contacted / Follow Up → **Replied** |
| A Contacted lead is quiet for `CRM_FOLLOW_UP_DAYS` (3) | → **Follow Up**, due today 09:00 |
| An unknown number writes in | New card in **Leads**, labelled WP and by market |

- **Forward only:** cards in Replied, Meeting, Won and Dead never move, and descriptions are never edited.
- **How cards are matched:** by the WhatsApp number written on the card (`WHATSAPP: +55 …`, `WhatsApp verificado: …`, any `wa.me/…` link). Numbers without a `+` country code are ignored.
- **Older Brazilian ids:** ids without the mobile 9 match their card.
- **Not counted as replies:** Business-app greeting and away messages (pt/en/es/ar, or an instant first answer), and reactions.
- **Starts in preview mode.** `crm_preview_sync` lists every change the history implies. `crm_apply_sync` applies it and turns the sync live. `crm_set_mode` pauses or resumes it.
- **Overrides:** `crm_link_number_to_card` ties a number to a card, or marks it "not a lead".
- **Daily report:** `crm_daily_report` covers who's waiting on you, what moved, follow-ups due (including "follow up again"), automatic replies, numbers on two cards, and chats with no card. The `morning_whatsapp_review` prompt runs the whole routine.

## Develop
```bash
npm install
npm test          # vitest, everything mocked
npm run build
cp .env.example .env   # fill in, then:
npm run dev
```

Every setting is described in `.env.example`.
