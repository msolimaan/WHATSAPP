import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { EventBus } from "../events/bus.js";
import type { NewMessage, Store } from "../store/store.js";
import type { TrelloCard, TrelloClient } from "../trello/client.js";
import { BoardIndex, type Match } from "./board.js";
import { chatFor } from "./chat.js";
import { displayPhone, marketFor, phoneKey } from "./phones.js";
import {
  type ChatMessage,
  type Decision,
  isAutoReply,
  meaningful,
  onMessage,
  overdue,
  reconcile,
  snippet,
  type Stage,
} from "./rules.js";
import { cardDate, localDayAt } from "./time.js";

export type CrmMode = "preview" | "live";
type Trigger = "message" | "overdue" | "preview";

export interface PreviewItem {
  n: number;
  kind: "move" | "create";
  waId: string;
  cardId?: string;
  cardName: string;
  fromListId?: string;
  from?: string;
  to: string;
  toStage: Stage;
  reason: string;
  setDue?: boolean;
  desc?: string;
  labels?: string[];
}

export interface Preview {
  id: string;
  createdAt: number;
  items: PreviewItem[];
  conflicts: { number: string; cards: { name: string; url: string }[] }[];
  untracked: { waId: string; name: string | null; lastAt: number }[];
  archived: { waId: string; card: string; url: string; lastAt: number }[];
  olderUnknown: number;
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
  failed: string[];
  mode: CrmMode;
}

const BOARD_MAX_AGE_MS = 15 * 60 * 1000;
const SWEEP_EVERY_MS = 15 * 60 * 1000;

interface SyncDeps {
  config: Config;
  store: Store;
  bus: EventBus;
  trello: TrelloClient;
  now?: () => number;
  log?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * Keeps the Trello pipeline in step with WhatsApp.
 *
 * Starts in "preview" mode: nothing on Trello changes until you review crm_preview_sync and
 * apply it. After that it runs "live": each new message is checked against the rules as it
 * arrives, and every 15 minutes quiet Contacted leads are moved to Follow Up.
 */
export class CrmSync {
  private board?: BoardIndex;
  private loading?: Promise<BoardIndex>;
  private chain: Promise<void> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private readonly now: () => number;
  private readonly log: Pick<Console, "info" | "warn" | "error">;

  constructor(private readonly deps: SyncDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? console;
  }

  get mode(): CrmMode {
    return this.deps.store.getKv("crm_mode") === "live" ? "live" : "preview";
  }

  setMode(mode: CrmMode): void {
    this.deps.store.setKv("crm_mode", mode);
  }

  start(): void {
    this.deps.bus.on("message", (m, meta) => {
      if (!meta.backfill) this.enqueue(() => this.handleMessage(m));
    });
    this.timers.push(
      setInterval(() => this.enqueue(() => this.sweepOverdue().then(() => undefined)), SWEEP_EVERY_MS),
    );
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Resolves when all queued work is done. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Work runs one item at a time so two quick messages can't race on the same card. */
  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err) => this.log.error("crm: sync step failed", err));
  }

  async getBoard(maxAgeMs = BOARD_MAX_AGE_MS): Promise<BoardIndex> {
    // getBoard(0) always reads a fresh copy.
    if (this.board && this.now() - this.board.loadedAt < maxAgeMs) return this.board;
    this.loading ??= this.loadBoard().finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async loadBoard(): Promise<BoardIndex> {
    const id = this.deps.config.TRELLO_BOARD_ID;
    const [lists, labels, cards] = await Promise.all([
      this.deps.trello.getLists(id),
      this.deps.trello.getLabels(id),
      this.deps.trello.getCards(id),
    ]);
    this.board = new BoardIndex(lists, labels, cards, this.now());
    this.deps.store.setKv("crm_board_loaded_at", String(this.now()));
    return this.board;
  }

  // ---- live rules -------------------------------------------------------------------

  async handleMessage(m: NewMessage): Promise<void> {
    if (this.mode !== "live" || m.type === "reaction") return;
    let board = await this.getBoard();
    let match = this.match(board, m.waId);
    // Before creating a card, make sure you didn't just add this lead by hand.
    if (match.kind === "none" && m.direction === "in" && this.now() - board.loadedAt > 60_000) {
      board = await this.getBoard(0);
      match = this.match(board, m.waId);
    }
    const chat = this.chatFor(this.waIdsLike(m.waId));
    const msg = chat.find((c) => c.id === m.id) ?? toChat(m);

    if (match.kind === "card" && match.stage) {
      const decision = onMessage(match.stage, msg, chat);
      if (decision) await this.move(board, match.card, decision, "message", m.waId);
    } else if (match.kind === "none" && m.direction === "in" && !isAutoReply(msg, chat)) {
      await this.createLead(board, m.waId, msg, "message");
    }
  }

  /** Moves Contacted leads that have gone quiet to Follow Up. Returns how many moved. */
  async sweepOverdue(): Promise<number> {
    if (this.mode !== "live") return 0;
    const board = await this.getBoard();
    const byKey = this.contactsByKey();
    const conflicted = new Set(board.conflicts().map((c) => c.key));
    let moved = 0;
    for (const card of board.cardsIn("contacted")) {
      const keys = board.phoneKeysOf(card);
      if (keys.length === 0 || keys.some((k) => conflicted.has(k))) continue;
      const waIds = keys.flatMap((k) => byKey.get(k) ?? []);
      if (waIds.length === 0) continue;
      const d = overdue("contacted", this.chatFor(waIds), this.now() / 1000, this.deps.config.CRM_FOLLOW_UP_DAYS);
      if (d && (await this.move(board, card, d, "overdue", waIds[0]))) moved++;
    }
    return moved;
  }

  // ---- preview / apply --------------------------------------------------------------

  /** Works out every change the rules would make given all WhatsApp history so far. Changes nothing. */
  async preview(): Promise<Preview> {
    const board = await this.getBoard(0);
    const nowSec = this.now() / 1000;
    const days = this.deps.config.CRM_FOLLOW_UP_DAYS;
    const lookback = nowSec - this.deps.config.CRM_NEW_LEAD_LOOKBACK_DAYS * 86400;

    const items: PreviewItem[] = [];
    const untracked: Preview["untracked"] = [];
    const archived: Preview["archived"] = [];
    let olderUnknown = 0;

    // Group the chats by card (a card can list more than one number, a number can have two ids).
    const chatsByCard = new Map<string, { card: TrelloCard; stage: Stage; waIds: string[] }>();
    for (const [, waIds] of this.contactsByKey()) {
      const match = this.match(board, waIds[0]);
      const chat = this.chatFor(waIds);
      const real = meaningful(chat);
      const last = real.at(-1);
      if (match.kind === "card") {
        if (!match.stage) continue;
        const entry = chatsByCard.get(match.card.id) ?? { card: match.card, stage: match.stage, waIds: [] };
        entry.waIds.push(...waIds);
        chatsByCard.set(match.card.id, entry);
      } else if (match.kind === "none" && last) {
        const lastIn = [...real].reverse().find((x) => x.direction === "in");
        if (lastIn && lastIn.timestamp >= lookback) {
          items.push(this.createItem(board, waIds[0], lastIn, items.length + 1));
        } else if (lastIn) {
          olderUnknown++;
        } else if (last.timestamp >= lookback) {
          const c = this.deps.store.getContact(waIds[0]);
          untracked.push({ waId: waIds[0], name: c?.saved_name ?? c?.profile_name ?? null, lastAt: last.timestamp });
        }
      } else if (match.kind === "archived" && last && last.direction === "in" && last.timestamp >= lookback) {
        archived.push({ waId: waIds[0], card: match.card.name, url: match.card.shortUrl, lastAt: last.timestamp });
      }
    }

    for (const { card, stage, waIds } of chatsByCard.values()) {
      const d = reconcile(stage, this.chatFor(waIds), nowSec, days);
      if (!d) continue;
      items.push({
        n: items.length + 1,
        kind: "move",
        waId: waIds[0],
        cardId: card.id,
        cardName: card.name,
        fromListId: card.idList,
        from: board.listName(card.idList),
        to: board.listByStage.get(d.to)!.name,
        toStage: d.to,
        reason: d.reason,
        setDue: d.setDue,
      });
    }

    const preview: Preview = {
      id: randomUUID().slice(0, 8),
      createdAt: this.now(),
      items,
      conflicts: board.conflicts().map((c) => ({
        number: displayPhone(c.number),
        cards: c.cards.map((x) => ({ name: x.name, url: x.shortUrl })),
      })),
      untracked: untracked.sort((a, b) => b.lastAt - a.lastAt),
      archived,
      olderUnknown,
    };
    this.deps.store.setKv("crm_preview", JSON.stringify(preview));
    return preview;
  }

  /** Applies a preview (all items, or the numbered ones) and optionally switches to live mode. */
  async apply(previewId: string, only?: number[], goLive = true): Promise<ApplyResult> {
    const raw = this.deps.store.getKv("crm_preview");
    const preview = raw ? (JSON.parse(raw) as Preview) : undefined;
    if (!preview || preview.id !== previewId) {
      throw new Error(`Preview ${previewId} isn't the latest one. Run crm_preview_sync again and apply its id.`);
    }
    const board = await this.getBoard(0);
    const result: ApplyResult = { applied: [], skipped: [], failed: [], mode: this.mode };
    const chosen = only?.length ? preview.items.filter((i) => only.includes(i.n)) : preview.items;

    for (const item of chosen) {
      const label = `#${item.n} ${item.cardName}`;
      if (item.kind === "move") {
        const card = board.cards.get(item.cardId!);
        if (!card || card.closed || card.idList !== item.fromListId) {
          result.skipped.push(`${label}: the card changed since the preview`);
          continue;
        }
        const ok = await this.move(board, card, { to: item.toStage, reason: item.reason, setDue: item.setDue }, "preview", item.waId);
        (ok ? result.applied : result.failed).push(`${label}: ${item.from} → ${item.to}`);
      } else {
        if (this.match(board, item.waId).kind !== "none") {
          result.skipped.push(`${label}: a card for this number exists now`);
          continue;
        }
        const card = await this.createCard(board, item, "preview");
        (card ? result.applied : result.failed).push(`${label}: new card in ${item.to}`);
      }
    }
    if (goLive) this.setMode("live");
    this.deps.store.setKv("crm_preview", "");
    result.mode = this.mode;
    return result;
  }

  // ---- manual links -----------------------------------------------------------------

  /** Ties a number to a card (overriding what's written on cards), or marks it "not a lead". */
  async link(number: string, cardRef: string | null, note?: string): Promise<string> {
    const digits = number.replace(/\D/g, "");
    const key = phoneKey(digits);
    if (key.length < 8) throw new Error(`"${number}" isn't a full phone number with country code.`);
    let cardId: string | null = null;
    let name = "not a lead (no card will be created)";
    if (cardRef) {
      const short = cardRef.match(/trello\.com\/c\/([A-Za-z0-9]+)/)?.[1] ?? cardRef.trim();
      const card = await this.deps.trello.getCard(short);
      const board = await this.getBoard();
      if (!board.cards.has(card.id)) throw new Error("That card isn't on the CRM board.");
      cardId = card.id;
      name = card.name;
    }
    this.deps.store.db
      .prepare(
        `INSERT INTO crm_links (phone_key, card_id, note, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (phone_key) DO UPDATE SET card_id = excluded.card_id, note = excluded.note`,
      )
      .run(key, cardId, note ?? null, Math.floor(this.now() / 1000));
    return `${displayPhone(digits)} → ${name}`;
  }

  // ---- helpers ----------------------------------------------------------------------

  match(board: BoardIndex, waId: string): Match {
    const link = this.deps.store.db
      .prepare(`SELECT card_id FROM crm_links WHERE phone_key = ?`)
      .get(phoneKey(waId)) as { card_id: string | null } | undefined;
    return board.match(waId, link);
  }

  /** All known WhatsApp ids, grouped by phone key. */
  contactsByKey(): Map<string, string[]> {
    const rows = this.deps.store.db.prepare(`SELECT wa_id FROM contacts`).all() as { wa_id: string }[];
    const map = new Map<string, string[]>();
    for (const { wa_id } of rows) {
      const k = phoneKey(wa_id);
      map.set(k, [...(map.get(k) ?? []), wa_id]);
    }
    return map;
  }

  private waIdsLike(waId: string): string[] {
    return this.contactsByKey().get(phoneKey(waId)) ?? [waId];
  }

  chatFor(waIds: string[]): ChatMessage[] {
    return chatFor(this.deps.store.db, waIds);
  }

  private async move(board: BoardIndex, card: TrelloCard, d: Decision, trigger: Trigger, waId: string): Promise<boolean> {
    const to = board.listByStage.get(d.to)!;
    const from = board.listName(card.idList);
    const due = d.setDue ? localDayAt(this.now(), 9, this.deps.config.TIMEZONE).toISOString() : undefined;
    try {
      await this.deps.trello.moveCard(card.id, to.id, { due });
      board.put({ ...card, idList: to.id, due: due ?? card.due });
      this.record({ kind: "move", card, waId, from, to: to.name, reason: d.reason, trigger });
      this.log.info(`crm: moved "${card.name}" ${from} → ${to.name} (${d.reason})`);
      return true;
    } catch (err) {
      this.record({ kind: "move", card, waId, from, to: to.name, reason: d.reason, trigger, error: (err as Error).message });
      this.log.error(`crm: couldn't move "${card.name}"`, err);
      return false;
    }
  }

  private async createLead(board: BoardIndex, waId: string, msg: ChatMessage, trigger: Trigger): Promise<void> {
    await this.createCard(board, this.createItem(board, waId, msg, 0), trigger);
  }

  private createItem(board: BoardIndex, waId: string, msg: ChatMessage, n: number): PreviewItem {
    const tz = this.deps.config.TIMEZONE;
    const c = this.deps.store.getContact(waId);
    const name = c?.saved_name ?? c?.profile_name ?? null;
    const market = marketFor(waId);
    const phone = displayPhone(waId);
    const when = cardDate(msg.timestamp * 1000, tz);
    const desc = [
      `STATUS: New inbound — wrote first on WhatsApp on ${when}.`,
      "",
      `CONTACT: ${name ?? "unknown (no WhatsApp name)"}`,
      `MARKET: ${market}`,
      "CHANNEL: WhatsApp",
      `WHATSAPP: ${phone}`,
      `WhatsApp link: https://wa.me/${waId}`,
      "",
      `MESSAGE (${when}):`,
      `“${snippet(msg.body, 500)}”`,
      "",
      "NEXT ACTION",
      "Reply on WhatsApp. Then research and fill in company, role and language.",
      "",
      "(Card created automatically by the WhatsApp sync.)",
    ].join("\n");
    return {
      n,
      kind: "create",
      waId,
      cardName: `New inbound — ${name ?? phone} | ${market} | WhatsApp`,
      to: board.listByStage.get("leads")!.name,
      toStage: "leads",
      reason: `unknown number wrote: “${snippet(msg.body)}”`,
      desc,
      labels: [this.deps.config.CRM_CHANNEL_LABEL, market],
    };
  }

  private async createCard(board: BoardIndex, item: PreviewItem, trigger: Trigger): Promise<TrelloCard | undefined> {
    const list = board.listByStage.get("leads")!;
    const idLabels = (item.labels ?? []).map((l) => board.labelId(l)).filter((x): x is string => Boolean(x));
    try {
      const card = await this.deps.trello.createCard({ idList: list.id, name: item.cardName, desc: item.desc ?? "", idLabels });
      board.put({ ...card, desc: card.desc ?? item.desc ?? "", idList: list.id, closed: false });
      this.record({ kind: "create", card, waId: item.waId, to: list.name, reason: item.reason, trigger });
      this.log.info(`crm: created "${item.cardName}"`);
      return card;
    } catch (err) {
      this.record({
        kind: "create",
        card: { id: "", name: item.cardName } as TrelloCard,
        waId: item.waId,
        to: list.name,
        reason: item.reason,
        trigger,
        error: (err as Error).message,
      });
      this.log.error(`crm: couldn't create a card for +${item.waId}`, err);
      return undefined;
    }
  }

  private record(a: {
    kind: "move" | "create";
    card: Pick<TrelloCard, "id" | "name">;
    waId: string;
    from?: string;
    to: string;
    reason: string;
    trigger: Trigger;
    error?: string;
  }): void {
    this.deps.store.db
      .prepare(
        `INSERT INTO crm_actions (at, kind, card_id, card_name, wa_id, from_list, to_list, reason, trigger, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Math.floor(this.now() / 1000),
        a.kind,
        a.card.id || null,
        a.card.name,
        a.waId,
        a.from ?? null,
        a.to,
        a.reason,
        a.trigger,
        a.error ? 0 : 1,
        a.error ?? null,
      );
  }
}

function toChat(m: NewMessage): ChatMessage {
  return { id: m.id, direction: m.direction, type: m.type, body: m.body, timestamp: m.timestamp };
}
