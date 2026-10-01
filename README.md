# whatsapp-mcp

Connects Claude to your WhatsApp Business number through the official WhatsApp Cloud API. It also keeps your **Inhouse Creatives LEADS** Trello board up to date by itself.

What you get:
- **You keep typing on your phone as usual.** Every message, yours and your leads', is saved.
- **Trello cards move on their own:** Contacted, Replied, Follow Up. New numbers that write in get a card in Leads.
- **Claude can work your WhatsApp** from claude.ai, Claude Desktop, Claude Code or the phone app: read and search chats, reply, draft follow-ups for your approval, run automatic follow-up sequences, and give you a morning report.

```
Your phone (WhatsApp Business app) ─┐
Your leads ──────────────── WhatsApp ── Meta partner (Coexistence) ──webhooks──► this server ◄──/mcp── Claude apps
                                                                       │
                                     SQLite (messages, follow-ups) ────┴── Trello sync ──► your CRM board
```

---

## Setup guide
This takes about an hour, most of it waiting for Meta and your partner.

### 1. Connect your WhatsApp number through a Meta partner (Coexistence)
Coexistence keeps the WhatsApp Business app working on your phone while the API sees every message.

1. Choose a Meta Business Solution Provider that supports **Coexistence** and passes Meta's webhooks through unchanged. 360dialog is the default here (`WA_PROVIDER=360dialog`). Compare the partner's monthly fee and Meta's per-message prices for Brazil, the Gulf and Egypt first.
2. In their onboarding, choose the option for a number **already used in the WhatsApp Business app**.
3. Confirm the scan with the QR code shown in the app. You need app version 2.24.17 or newer.
4. Allow **chat history sharing** when asked. That imports up to 6 months of past chats.
5. Copy your **API key**. Also write down your business number with the country code, digits only (e.g. `5511940000000`).
6. Ask the partner to confirm they forward these webhook fields:
   - `messages`
   - `smb_message_echoes` (what you type on the phone)
   - `history`
   - `smb_app_state_sync`

> Keep opening the WhatsApp Business app at least every couple of weeks, or Meta may end Coexistence.
>
> Some app features don't reach the API, for example broadcast lists and view-once messages.

### 2. Get a Trello key and token
1. Go to https://trello.com/power-ups/admin and create a Power-Up. It's only used for its API key, so any name works.
2. Open **API key** and copy the key.
3. Click the **Token** link next to it, allow access, and copy the token.

The board id for *Inhouse Creatives LEADS* is already the default.

### 3. Put the server online
It must run all the time. Webhooks arrive whenever leads write, and follow-ups go out on a schedule. Run **exactly one** copy of it.

First, make three secrets (run on any computer, or use a password generator):
```bash
openssl rand -hex 24   # WEBHOOK_PATH_SECRET
openssl rand -hex 32   # MCP_BEARER_TOKEN (optional, for Claude Code)
```
Then choose a strong **OWNER_PASSWORD**. It's what you type when connecting a Claude app.

**Railway (simplest).**
1. Create a new project from this GitHub repo. Railway finds `railway.json` and the `Dockerfile`.
2. Add a **Volume** to the service, mounted at `/data`.
3. Under Settings → Networking, click **Generate Domain**. That gives you something like `https://whatsapp-mcp-production.up.railway.app`.
4. Under **Variables**, set:

   | Variable | Value |
   |---|---|
   | `WA_PROVIDER` | `360dialog` |
   | `WA_API_KEY` | your partner API key |
   | `WA_BUSINESS_NUMBER` | e.g. `5511940000000` |
   | `WEBHOOK_PATH_SECRET` | the first random string |
   | `PUBLIC_BASE_URL` | your Railway domain, `https://…` |
   | `OWNER_PASSWORD` | your password |
   | `TRELLO_API_KEY`, `TRELLO_TOKEN` | from step 2 |
   | `TIMEZONE` | `America/Sao_Paulo` (already the default) |
   | `MCP_BEARER_TOKEN` | optional, for Claude Code |

5. Deploy. Opening `https://<your-domain>/health` should show `{"ok":true}`.

**Fly.io (alternative):**
```bash
fly launch --no-deploy --copy-config        # pick an app name; fly.toml is already set up
fly volumes create whatsapp_data --region gru --size 1
fly secrets set WA_API_KEY=… WA_BUSINESS_NUMBER=… WEBHOOK_PATH_SECRET=… \
  PUBLIC_BASE_URL=https://<app>.fly.dev OWNER_PASSWORD=… TRELLO_API_KEY=… TRELLO_TOKEN=…
fly deploy
fly scale count 1
```

### 4. Point WhatsApp at the server
Your webhook address is:
```
https://<your-domain>/webhook/<WEBHOOK_PATH_SECRET>
```
Set it in your partner's dashboard. With 360dialog, you can also set it through their API (check their current docs if this call has changed):
```bash
curl -X POST https://waba-v2.360dialog.io/v1/configs/webhook \
  -H "D360-API-KEY: <your API key>" -H "Content-Type: application/json" \
  -d '{"url": "https://<your-domain>/webhook/<WEBHOOK_PATH_SECRET>"}'
```
To check it works, send a WhatsApp message to your business number from another phone. Then ask Claude to "list my WhatsApp conversations" after step 5.

<details><summary>Using Meta directly instead of a partner</summary>

Set:
- `WA_PROVIDER=meta`
- `WA_API_KEY=<system user token>`
- `WA_PHONE_NUMBER_ID`
- `WA_BUSINESS_ACCOUNT_ID`
- `WA_APP_SECRET`
- `WEBHOOK_VERIFY_TOKEN`

In the Meta app dashboard, the webhook URL is `https://<your-domain>/webhook` (signatures are checked with the app secret), and the verify token is `WEBHOOK_VERIFY_TOKEN`. Subscribe to the fields listed in step 1.

Coexistence through Meta directly requires being a Tech Provider.
</details>

### 5. Connect Claude
- **claude.ai, Claude Desktop and the phone app:**
  1. Go to Settings → Connectors → **Add custom connector**.
  2. Paste `https://<your-domain>/mcp`.
  3. A page asks "Allow access to your WhatsApp?" Enter your `OWNER_PASSWORD` and click Allow.
  4. Do this once on claude.ai. Desktop and the phone app use the same account's connectors.
- **Claude Code:** run `claude mcp add --transport http whatsapp https://<your-domain>/mcp`, which logs in through the browser. Or add `--header "Authorization: Bearer <MCP_BEARER_TOKEN>"`.

### 6. Turn on the Trello sync
The sync starts in **preview mode**: nothing changes on Trello until you say so.
1. Wait until the history import has arrived. `crm_sync_status` and `whatsapp_list_conversations` show it.
2. Ask Claude: **"Preview the Trello sync."** It lists every card move and new card your history implies, plus numbers that appear on two cards and chats with no card.
3. Fix anything odd on the board, then ask Claude to **"apply the sync"** (all of it, or by item number). The sync is live from then on.

### 7. Create follow-up templates
Meta must approve every message the system sends after the 24-hour window. That includes follow-ups to leads who haven't replied.
1. Ask Claude to draft templates in your style, e.g. "create a Portuguese MARKETING template for a first follow-up with {{1}} = first name".
2. Approval usually takes minutes; Claude can check with `whatsapp_list_templates`.
3. Then set up sequences: "create a sequence: template `followup_1_pt` after 3 days, `followup_2_pt` 4 days later" and "enroll the Follow Up list". Claude always shows who'd be enrolled before confirming.

---

## Daily use
Ask Claude things like:
- **"Run my morning WhatsApp review"** (the `morning_whatsapp_review` prompt). You get:
  - the report;
  - drafted replies to everyone waiting on you;
  - follow-ups due today.

  Nothing is sent until you approve it.
- "Who's waiting on my reply?" · "Show my chat with Bia" · "Search WhatsApp for 'orçamento'"
- "Reply to Bia: … " · "Send Sara our portfolio PDF: https://…" · "Schedule a follow-up to LUMA for Monday 10:00"
- "Which leads went quiet this week?" · "Take Sara out of the sequence"

To get the report every morning without asking, set up a scheduled Claude routine with the prompt "Run my morning WhatsApp review".

---

## Reference

### Tools Claude gets
| Area | Tools |
|---|---|
| Reading | `whatsapp_list_conversations` (filter *awaiting my reply* / *awaiting theirs*), `whatsapp_get_messages`, `whatsapp_search_messages`, `whatsapp_find_contacts`, `whatsapp_get_contact`, `whatsapp_download_media` |
| Sending | `whatsapp_send_text`, `whatsapp_send_media`, `whatsapp_send_template`, `whatsapp_send_buttons`, `whatsapp_send_location`, `whatsapp_react`, `whatsapp_mark_read` |
| Templates | `whatsapp_list_templates`, `whatsapp_create_template`, `whatsapp_delete_template` |
| Drafts & scheduling | `whatsapp_draft_message`, `whatsapp_list_drafts`, `whatsapp_approve_drafts`, `whatsapp_cancel_pending`, `whatsapp_schedule_message` |
| Sequences | `followup_create_sequence`, `followup_list_sequences`, `followup_enroll`, `followup_stop`, `followup_status` |
| CRM | `crm_daily_report`, `crm_preview_sync`, `crm_apply_sync`, `crm_set_mode`, `crm_find_card`, `crm_link_number_to_card`, `crm_sync_status` |

Every message goes out through one path that checks two things:
- **The 24-hour window:** free text only within 24h of the lead's last message, otherwise an approved template.
- **Opt-outs:** no templates to people who asked to stop.

### Trello sync rules
| When | Card moves |
|---|---|
| You message a lead (from your phone or through Claude) | Leads / Ready to Contact → **Contacted** |
| A lead replies | Leads / Ready to Contact / Contacted / Follow Up → **Replied** |
| A Contacted lead is quiet for `CRM_FOLLOW_UP_DAYS` (3) | → **Follow Up**, due today 09:00 |
| An unknown number writes in | New card in **Leads**, labelled WP and by market |

- **Forward only:** cards in Replied, Meeting, Won and Dead never move, and card descriptions are never edited.
- **How cards are matched:** by the number written on the card (`WHATSAPP: +55 …`, `WhatsApp verificado: …`, any `wa.me/…` link). Numbers without a `+` country code are ignored, and older Brazilian WhatsApp ids without the mobile 9 still match.
- **Not counted as replies:** Business-app greeting and away messages, and reactions.
- **Overrides:** `crm_link_number_to_card` ties a number to a card, or marks it "not a lead" (friends, suppliers).

### Follow-ups
- **Drafts and scheduled messages:**
  - Drafts wait for your approval.
  - Scheduled messages go out at a local time, and are cancelled if the lead writes first.
- **Sequences:**
  - Steps carry text and/or a template: text inside the 24h window, the template outside it.
  - `{{name}}`, `{{first_name}}` and `{{company}}` come from the card's `CONTACT:` and `COMPANY:` lines.
  - A lead leaves when they really reply, opt out, or you message them from your phone.
- **Limits:**
  - Quiet hours (`FOLLOWUP_QUIET_HOURS`, default 20:00–08:30).
  - Optional weekend pause.
  - At most `FOLLOWUP_DAILY_TEMPLATE_CAP` (30) paid templates a day.
- **Opt-outs:** "Parar", "STOP", "não tenho interesse", "not interested" and Arabic equivalents stop everything and block templates.

### Security
- **Webhooks:** checked by Meta's signature or a secret URL. Raw payloads are deleted after 30 days.
- **Claude apps:** log in with OAuth 2.1:
  - dynamic registration and PKCE;
  - your password page, which can't be framed;
  - 10 wrong passwords per 15 min per address, and a pause after 20 failures an hour.
- **Logins only go back to `OAUTH_ALLOWED_REDIRECT_HOSTS`** (claude.ai, claude.com, local apps). Tokens only work for this server's `/mcp`.
- **Stored logins:**
  - Tokens and codes are stored as SHA-256 hashes.
  - Access tokens last 60 min.
  - Refresh tokens are single-use, and reusing one signs that login out everywhere.
- **API key:** the WhatsApp key is only ever sent to your provider's (or Meta's) own hosts.
- **Public endpoints:** `/health` reveals nothing about your messages.

### Settings
Every setting is described in [`.env.example`](.env.example). The main ones:

| Setting | Default | |
|---|---|---|
| `WA_PROVIDER` | `360dialog` | or `meta` |
| `WA_API_KEY` | (required) | partner API key or Meta token |
| `WA_BUSINESS_NUMBER` | | your number, digits only |
| `WEBHOOK_PATH_SECRET` / `WA_APP_SECRET` | | at least one is required |
| `PUBLIC_BASE_URL` + `OWNER_PASSWORD` | | turn on login for Claude apps |
| `MCP_BEARER_TOKEN` | | static token for Claude Code |
| `TRELLO_API_KEY`, `TRELLO_TOKEN` | | turn on the CRM sync |
| `TRELLO_BOARD_ID` | Inhouse Creatives LEADS | |
| `CRM_FOLLOW_UP_DAYS` | `3` | |
| `FOLLOWUP_QUIET_HOURS` | `20:00-08:30` | |
| `FOLLOWUP_DAILY_TEMPLATE_CAP` | `30` | |
| `TIMEZONE` | `America/Sao_Paulo` | |
| `DATA_DIR` | `./data` (`/data` in Docker) | keep it on a persistent volume |

### Troubleshooting
| Symptom | Check |
|---|---|
| No messages arrive | The webhook URL ends with your `WEBHOOK_PATH_SECRET`; the partner forwards the fields in step 1; the server logs |
| Your phone messages don't appear | The partner must forward `smb_message_echoes` |
| "window is closed" when sending | That person last wrote over 24h ago: use a template |
| Trello doesn't change | `crm_sync_status`: is it LIVE? Is the number on the card with a `+` country code? |
| A number "is on several cards" | Remove the duplicate number or use `crm_link_number_to_card` |
| Claude app can't connect | `PUBLIC_BASE_URL` is the exact https address; `/.well-known/oauth-authorization-server` loads |

**Backups:** everything lives in `whatsapp.db` on the volume. Railway and Fly can snapshot volumes.

---

## Develop
```bash
npm install
npm test            # vitest; WhatsApp and Trello are simulated
npm run typecheck
npm run build
cp .env.example .env && npm run dev
```
CI runs the type check, the tests, and a Docker build with a health check on every pull request.
