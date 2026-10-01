import type { Config } from "../config.js";
import { formatTime } from "../mcp/util.js";
import type { Store } from "../store/store.js";
import type { BoardIndex } from "./board.js";
import { chatFor } from "./chat.js";
import { displayPhone } from "./phones.js";
import { isAutoReply, meaningful, snippet } from "./rules.js";
import type { CrmSync } from "./sync.js";
import { localDayAt } from "./time.js";

interface ActionRow {
  at: number;
  kind: string;
  card_name: string;
  from_list: string | null;
  to_list: string;
  reason: string;
  ok: number;
  error: string | null;
}

/**
 * The morning briefing: what happened on WhatsApp, what the sync changed on Trello,
 * and what needs you today. Plain text so it reads well in any Claude app.
 */
export async function dailyReport(
  deps: { config: Config; store: Store; sync?: CrmSync; now?: () => number },
  hours = 24,
): Promise<string> {
  const { config, store, sync } = deps;
  const tz = config.TIMEZONE;
  const nowMs = (deps.now ?? Date.now)();
  const since = Math.floor(nowMs / 1000) - hours * 3600;
  const out: string[] = [`# WhatsApp & CRM report: last ${hours}h (to ${formatTime(nowMs / 1000, tz)}, ${tz})`];

  let board: BoardIndex | undefined;
  let boardError: string | undefined;
  if (sync) {
    try {
      board = await sync.getBoard();
    } catch (err) {
      boardError = (err as Error).message;
    }
  }
  const cardFor = (waId: string) => {
    if (!board || !sync) return null;
    const m = sync.match(board, waId);
    return m.kind === "card" ? `${m.card.name} [${board.listName(m.card.idList)}]` : null;
  };
  const nameOf = (waId: string) => {
    const c = store.getContact(waId);
    return c?.saved_name ?? c?.profile_name ?? null;
  };
  const who = (waId: string) => cardFor(waId) ?? `${nameOf(waId) ?? displayPhone(waId)} (no card)`;

  // ---- activity
  const counts = store.db
    .prepare(
      `SELECT direction, COUNT(*) AS n, COUNT(DISTINCT wa_id) AS people FROM messages
       WHERE timestamp >= ? AND source != 'history' AND type != 'reaction' GROUP BY direction`,
    )
    .all(since) as { direction: "in" | "out"; n: number; people: number }[];
  const inb = counts.find((c) => c.direction === "in");
  const outb = counts.find((c) => c.direction === "out");
  out.push(
    "",
    "## Activity",
    `- Received ${inb?.n ?? 0} messages from ${inb?.people ?? 0} people; sent ${outb?.n ?? 0} to ${outb?.people ?? 0}.`,
  );

  // ---- waiting on you: the latest real message in the chat is theirs
  const recent = store.db
    .prepare(`SELECT DISTINCT wa_id FROM messages WHERE timestamp >= ? - 14 * 86400`)
    .all(since) as { wa_id: string }[];
  const waiting: { waId: string; at: number; body: string | null }[] = [];
  const autoReplies: { waId: string; body: string | null }[] = [];
  for (const { wa_id } of recent) {
    const chat = chatFor(store.db, [wa_id]);
    const last = meaningful(chat).at(-1);
    if (last?.direction === "in") waiting.push({ waId: wa_id, at: last.timestamp, body: last.body });
    for (const m of chat) {
      if (m.timestamp >= since && isAutoReply(m, chat)) autoReplies.push({ waId: wa_id, body: m.body });
    }
  }
  waiting.sort((a, b) => a.at - b.at);
  out.push("", `## Waiting on your reply (${waiting.length})`);
  if (waiting.length === 0) out.push("- Nobody. 🎉");
  for (const w of waiting.slice(0, 25)) {
    out.push(`- ${who(w.waId)}, since ${formatTime(w.at, tz)}: “${snippet(w.body)}” (+${w.waId})`);
  }
  if (waiting.length > 25) out.push(`- …and ${waiting.length - 25} more (whatsapp_list_conversations filter awaiting_my_reply)`);

  // ---- what the sync did
  const actions = store.db
    .prepare(`SELECT at, kind, card_name, from_list, to_list, reason, ok, error FROM crm_actions WHERE at >= ? ORDER BY at`)
    .all(since) as ActionRow[];
  const done = actions.filter((a) => a.ok);
  const failed = actions.filter((a) => !a.ok);
  out.push("", `## Trello changes made automatically (${done.length})`);
  if (done.length === 0) out.push("- None.");
  for (const a of done) {
    out.push(
      a.kind === "create"
        ? `- ➕ ${a.card_name} → ${a.to_list} (${a.reason})`
        : `- ${a.card_name}: ${a.from_list} → ${a.to_list} (${a.reason})`,
    );
  }

  // ---- follow-ups due
  if (board && sync) {
    const endOfToday = localDayAt(nowMs, 0, tz, 1).getTime() / 1000;
    const quietDays = config.CRM_FOLLOW_UP_DAYS;
    const byKey = sync.contactsByKey();
    const due: { line: string; sortKey: number }[] = [];
    for (const c of board.cardsIn("follow_up")) {
      const chat = chatFor(store.db, board.phoneKeysOf(c).flatMap((k) => byKey.get(k) ?? []));
      const lastOut = [...meaningful(chat)].reverse().find((m) => m.direction === "out");
      const lastAny = meaningful(chat).at(-1);
      const dueSec = c.due ? Date.parse(c.due) / 1000 : null;
      // When the card entered Follow Up: our own move if we made it, else a day before its due date.
      const moved = store.db
        .prepare(`SELECT MAX(at) AS at FROM crm_actions WHERE card_id = ? AND to_list = ? AND ok = 1`)
        .get(c.id, board.listByStage.get("follow_up")!.name) as { at: number | null };
      const enteredAt = moved.at ?? (dueSec ? dueSec - 86400 : 0);
      const followedUp = lastOut !== undefined && lastOut.timestamp > enteredAt;
      const url = c.shortUrl;
      if (!followedUp && (dueSec === null || dueSec < endOfToday)) {
        due.push({ line: `- ${c.name}${dueSec ? ` (due ${formatTime(dueSec, tz)})` : " (no due date)"} ${url}`, sortKey: dueSec ?? 0 });
      } else if (followedUp && lastAny?.direction === "out" && nowMs / 1000 - lastAny.timestamp >= quietDays * 86400) {
        const days = Math.floor((nowMs / 1000 - lastAny.timestamp) / 86400);
        due.push({ line: `- ${c.name}: follow up again, no reply ${days} days after your last follow-up ${url}`, sortKey: lastAny.timestamp });
      }
    }
    due.sort((a, b) => a.sortKey - b.sortKey);
    out.push("", `## Follow-ups due today or earlier (${due.length})`);
    if (due.length === 0) out.push("- None.");
    for (const d of due.slice(0, 30)) out.push(d.line);
  }

  // ---- needs attention
  const attention: string[] = [];
  if (sync && sync.mode === "preview") {
    attention.push("The Trello sync is in PREVIEW mode, so nothing changes on Trello yet. Run crm_preview_sync, review it, then crm_apply_sync.");
  }
  if (boardError) attention.push(`Couldn't read the Trello board: ${boardError}`);
  for (const f of failed) attention.push(`Failed: ${f.card_name} ${f.from_list ?? ""} → ${f.to_list}: ${f.error}`);
  for (const a of autoReplies) attention.push(`Automatic reply (not counted as a reply) from ${who(a.waId)}: “${snippet(a.body, 60)}”`);
  if (board) {
    for (const c of board.conflicts()) {
      attention.push(`${displayPhone(c.number)} is on ${c.cards.length} cards (${c.cards.map((x) => x.name).join("; ")}). Nothing moves for it until you fix it or use crm_link_number_to_card.`);
    }
    const untracked = store.db
      .prepare(
        `SELECT DISTINCT wa_id FROM messages WHERE timestamp >= ? AND direction = 'out' AND source != 'history' AND type != 'reaction'`,
      )
      .all(since) as { wa_id: string }[];
    for (const { wa_id } of untracked) {
      if (sync && sync.match(board, wa_id).kind === "none") {
        attention.push(`You messaged ${nameOf(wa_id) ?? displayPhone(wa_id)} (+${wa_id}), who has no card. Add the number to their card, or crm_link_number_to_card.`);
      }
    }
  } else if (!sync) {
    attention.push("Trello isn't connected (TRELLO_API_KEY and TRELLO_TOKEN aren't set).");
  }
  out.push("", `## Needs your attention (${attention.length})`);
  if (attention.length === 0) out.push("- Nothing.");
  for (const a of attention) out.push(`- ${a}`);
  return out.join("\n");
}
