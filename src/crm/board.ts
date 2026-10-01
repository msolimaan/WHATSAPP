import type { TrelloCard, TrelloLabel, TrelloList } from "../trello/client.js";
import { extractPhones, phoneKey } from "./phones.js";
import { DEFAULT_LIST_NAMES, STAGES, type Stage } from "./rules.js";

export type Match =
  | { kind: "card"; card: TrelloCard; stage: Stage | null }
  | { kind: "archived"; card: TrelloCard }
  | { kind: "conflict"; cards: TrelloCard[] }
  | { kind: "ignored" }
  | { kind: "none" };

const norm = (s: string) => s.trim().toLowerCase();

/** A snapshot of the CRM board: lists mapped to pipeline stages, and cards indexed by phone. */
export class BoardIndex {
  readonly cards = new Map<string, TrelloCard>();
  private readonly byKey = new Map<string, Set<string>>();
  /** The number as written on a card, for each key (keys can drop Brazil's mobile 9). */
  private readonly written = new Map<string, string>();
  private readonly stageByList = new Map<string, Stage>();
  readonly listByStage = new Map<Stage, TrelloList>();
  private readonly labelIds = new Map<string, string>();

  constructor(
    lists: TrelloList[],
    labels: TrelloLabel[],
    cards: TrelloCard[],
    readonly loadedAt: number,
    listNames: Record<Stage, string> = DEFAULT_LIST_NAMES,
  ) {
    for (const stage of STAGES) {
      const list = lists.find((l) => norm(l.name) === norm(listNames[stage]));
      if (!list) {
        throw new Error(
          `The CRM board has no list named "${listNames[stage]}". Rename the list back or update the list names in the server's settings.`,
        );
      }
      this.listByStage.set(stage, list);
      this.stageByList.set(list.id, stage);
    }
    for (const l of labels) if (l.name) this.labelIds.set(norm(l.name), l.id);
    for (const c of cards) this.put(c);
  }

  /** Adds or replaces a card (after we create or move one), keeping the phone index current. */
  put(card: TrelloCard): void {
    const old = this.cards.get(card.id);
    if (old) for (const k of keysOf(old)) this.byKey.get(k)?.delete(card.id);
    this.cards.set(card.id, card);
    for (const digits of extractPhones(`${card.name}\n${card.desc}`)) {
      if (!this.written.has(phoneKey(digits))) this.written.set(phoneKey(digits), digits);
    }
    for (const k of keysOf(card)) {
      if (!this.byKey.has(k)) this.byKey.set(k, new Set());
      this.byKey.get(k)!.add(card.id);
    }
  }

  stageOf(card: TrelloCard): Stage | null {
    return this.stageByList.get(card.idList) ?? null;
  }

  listName(listId: string): string {
    const stage = this.stageByList.get(listId);
    return stage ? this.listByStage.get(stage)!.name : "another list";
  }

  labelId(name: string): string | undefined {
    return this.labelIds.get(norm(name));
  }

  /**
   * Finds the card for a phone number. A manual link wins; otherwise the number written
   * on the card. Archived cards only count when no open card has the number.
   */
  match(waId: string, link?: { card_id: string | null }): Match {
    if (link) {
      if (link.card_id === null) return { kind: "ignored" };
      const card = this.cards.get(link.card_id);
      if (card) return card.closed ? { kind: "archived", card } : { kind: "card", card, stage: this.stageOf(card) };
    }
    const ids = [...(this.byKey.get(phoneKey(waId)) ?? [])];
    const cards = ids.map((id) => this.cards.get(id)!).filter(Boolean);
    const open = cards.filter((c) => !c.closed);
    if (open.length === 1) return { kind: "card", card: open[0], stage: this.stageOf(open[0]) };
    if (open.length > 1) return { kind: "conflict", cards: open };
    if (cards.length > 0) return { kind: "archived", card: cards[0] };
    return { kind: "none" };
  }

  /** Open cards in a stage. */
  cardsIn(stage: Stage): TrelloCard[] {
    const listId = this.listByStage.get(stage)!.id;
    return [...this.cards.values()].filter((c) => !c.closed && c.idList === listId);
  }

  /** Phone keys that are written on more than one open card. */
  conflicts(): { key: string; number: string; cards: TrelloCard[] }[] {
    const out: { key: string; number: string; cards: TrelloCard[] }[] = [];
    for (const [key, ids] of this.byKey) {
      const open = [...ids].map((id) => this.cards.get(id)!).filter((c) => c && !c.closed);
      if (open.length > 1) out.push({ key, number: this.written.get(key) ?? key, cards: open });
    }
    return out;
  }

  phoneKeysOf(card: TrelloCard): string[] {
    return keysOf(card);
  }
}

function keysOf(card: TrelloCard): string[] {
  return [...new Set(extractPhones(`${card.name}\n${card.desc}`).map(phoneKey))];
}
