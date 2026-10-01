# whatsapp-mcp

Connects Claude to your WhatsApp Business number through the official Cloud API
(Coexistence via a Meta partner such as 360dialog, or Meta directly), and keeps the
**Inhouse Creatives LEADS** Trello board in sync automatically.

> Status: **stage 5 of 7.** Everything works locally, including OAuth for Claude apps.
> Deployment files and the setup guide come next.

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

### Connecting Claude
With `PUBLIC_BASE_URL` and `OWNER_PASSWORD` set, the server is its own OAuth 2.1 login server:
- dynamic client registration;
- PKCE;
- the standard `/.well-known` discovery documents.

**How a Claude app connects:**
- **claude.ai, Claude Desktop and the phone app:** Settings → Connectors → Add custom connector → `https://<host>/mcp`. A page asks for your owner password, then the app is connected.
- **Claude Code:** `claude mcp add --transport http whatsapp https://<host>/mcp` (OAuth), or add `--header "Authorization: Bearer $MCP_BEARER_TOKEN"` to use the static token.

**Safeguards:**
- Only hosts in `OAUTH_ALLOWED_REDIRECT_HOSTS` (claude.ai, claude.com, local apps) can receive a login.
- Codes and tokens are stored as SHA-256 hashes.
- Access tokens last 60 minutes. Refresh tokens are single-use, and reusing one signs that login out everywhere.
- Tokens only work for this server's `/mcp`.
- Wrong passwords are limited to 10 per 15 minutes per address. Logins pause after 20 failures in an hour from anywhere.
- The login page can't be framed and loads nothing from outside.

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

## Follow-ups
**Drafts (the default).**
1. Claude prepares a message with `whatsapp_draft_message`.
2. You review it (`whatsapp_list_drafts`).
3. `whatsapp_approve_drafts` sends it, or schedules it.

**Scheduled messages.** `whatsapp_schedule_message` sends at a set local time and is cancelled automatically if they write first.

**Sequences.**
- `followup_create_sequence` sets up steps, e.g. a template after 3 days, another after 4 more.
- `followup_enroll` adds leads by contact or a whole Trello list, with `{{name}}`, `{{first_name}}` and `{{company}}` read from the card. It always previews before confirming.
- A lead leaves the sequence when they reply (away messages don't count), opt out, or **you message them from your phone**.

**Text or template.** Every follow-up can carry both. Text is used while their 24h window is open, the template otherwise. Placeholders that can't be filled are never sent.

**Limits on automatic sends:**
- `FOLLOWUP_QUIET_HOURS` (default 20:00–08:30) and optional `FOLLOWUP_SKIP_WEEKENDS`.
- `FOLLOWUP_DAILY_TEMPLATE_CAP` (default 30 paid templates a day).

**Opt-outs.** "Parar", "STOP", "não tenho interesse", "not interested" and Arabic equivalents mark the contact opted out, stop everything, and block future templates.

## Develop
```bash
npm install
npm test          # vitest, everything mocked
npm run build
cp .env.example .env   # fill in, then:
npm run dev
```

Every setting is described in `.env.example`.
