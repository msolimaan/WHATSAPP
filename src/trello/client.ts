// Minimal Trello REST client: only what the CRM sync needs.
// Auth: an API key and token from https://trello.com/power-ups/admin.

export interface TrelloList {
  id: string;
  name: string;
  pos: number;
}

export interface TrelloLabel {
  id: string;
  name: string;
  color: string | null;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idLabels: string[];
  due: string | null;
  closed: boolean;
  shortUrl: string;
  dateLastActivity: string;
}

export class TrelloError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TrelloError";
  }
}

const CARD_FIELDS = "name,desc,idList,idLabels,due,closed,shortUrl,dateLastActivity";

export class TrelloClient {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly key: string,
    private readonly token: string,
    opts: { fetch?: typeof fetch; baseUrl?: string } = {},
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.base = (opts.baseUrl ?? "https://api.trello.com/1").replace(/\/$/, "");
  }

  private readonly base: string;

  getLists(boardId: string): Promise<TrelloList[]> {
    return this.call("GET", `/boards/${boardId}/lists`, { filter: "open", fields: "name,pos" });
  }

  getLabels(boardId: string): Promise<TrelloLabel[]> {
    return this.call("GET", `/boards/${boardId}/labels`, { fields: "name,color", limit: "1000" });
  }

  /** Every card on the board, archived ones included (so a known lead is never re-created). */
  async getCards(boardId: string): Promise<TrelloCard[]> {
    const all: TrelloCard[] = [];
    let before: string | undefined;
    // Trello returns at most 1000 cards per call; page backwards by id.
    for (let page = 0; page < 50; page++) {
      const batch = await this.call<TrelloCard[]>("GET", `/boards/${boardId}/cards/all`, {
        fields: CARD_FIELDS,
        limit: "1000",
        ...(before && { before }),
      });
      all.push(...batch);
      if (batch.length < 1000) break;
      before = batch.reduce((min, c) => (c.id < min ? c.id : min), batch[0].id);
    }
    return all;
  }

  getCard(cardId: string): Promise<TrelloCard> {
    return this.call("GET", `/cards/${cardId}`, { fields: CARD_FIELDS });
  }

  /** Moves a card to the top of a list, optionally setting a due date (ISO, UTC). */
  moveCard(cardId: string, idList: string, opts: { due?: string } = {}): Promise<TrelloCard> {
    return this.call("PUT", `/cards/${cardId}`, { idList, pos: "top", ...(opts.due && { due: opts.due }) });
  }

  setDue(cardId: string, due: string): Promise<TrelloCard> {
    return this.call("PUT", `/cards/${cardId}`, { due });
  }

  createCard(card: { idList: string; name: string; desc: string; idLabels: string[] }): Promise<TrelloCard> {
    return this.call("POST", "/cards", {
      idList: card.idList,
      name: card.name,
      desc: card.desc,
      idLabels: card.idLabels.join(","),
      pos: "top",
    });
  }

  private async call<T>(method: string, path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // Credentials go in a header, not the URL, so they never show up in logs.
    const headers = { Authorization: `OAuth oauth_consumer_key="${this.key}", oauth_token="${this.token}"`, Accept: "application/json" };
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url.toString(), { method, headers });
      if (res.ok) return (await res.json()) as T;
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      const body = (await res.text()).slice(0, 300).trim().replace(/\.$/, "");
      const hint =
        res.status === 401
          ? " Check TRELLO_API_KEY and TRELLO_TOKEN."
          : res.status === 404
            ? " The board, list or card doesn't exist or the token can't see it."
            : "";
      throw new TrelloError(res.status, `Trello ${method} ${path} failed (${res.status}): ${body}.${hint}`);
    }
  }
}
