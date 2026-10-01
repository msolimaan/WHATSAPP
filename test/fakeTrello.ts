import type { TrelloCard, TrelloLabel, TrelloList } from "../src/trello/client.js";

// An in-memory copy of the "Inhouse Creatives LEADS" board that speaks just enough of
// Trello's REST API for the sync. Every write is recorded so tests can check exact calls.
export const LISTS: TrelloList[] = [
  ["L_leads", "Leads"], ["L_ready", "Ready to Contact"], ["L_contacted", "Contacted"], ["L_follow", "Follow Up"],
  ["L_replied", "Replied"], ["L_meeting", "Meeting"], ["L_won", "Won"], ["L_dead", "Dead"],
].map(([id, name], i) => ({ id, name, pos: (i + 1) * 100 }));

export const LABELS: TrelloLabel[] = [
  { id: "LB_wp", name: "WP", color: "orange_dark" },
  { id: "LB_br", name: "Brazil", color: "sky" },
  { id: "LB_gulf", name: "Gulf / Arab", color: "sky" },
  { id: "LB_intl", name: "International (EN)", color: "blue" },
];

let seq = 0;
export function card(idList: string, name: string, desc: string, extra: Partial<TrelloCard> = {}): TrelloCard {
  const id = extra.id ?? `C${++seq}`;
  return {
    id, name, desc, idList, idLabels: [], due: null, closed: false,
    shortUrl: `https://trello.com/c/${id}`, dateLastActivity: "2026-09-29T00:00:00.000Z", ...extra,
  };
}

export function fakeTrello(cards: TrelloCard[], lists: TrelloList[] = LISTS) {
  const writes: { method: string; path: string; params: Record<string, string> }[] = [];
  let created = 0;
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/1/, "");
    const params = Object.fromEntries(url.searchParams);
    const method = init.method ?? "GET";
    const auth = (init.headers as Record<string, string>)?.Authorization ?? "";
    if (!auth.includes('oauth_consumer_key="key"') || !auth.includes('oauth_token="token"')) {
      return new Response("invalid key", { status: 401 });
    }
    if (method !== "GET") writes.push({ method, path, params });
    if (method === "GET" && /^\/boards\/[^/]+\/lists$/.test(path)) return Response.json(lists);
    if (method === "GET" && /^\/boards\/[^/]+\/labels$/.test(path)) return Response.json(LABELS);
    if (method === "GET" && /^\/boards\/[^/]+\/cards\/all$/.test(path)) return Response.json(cards);
    const one = path.match(/^\/cards\/([^/]+)$/);
    if (one) {
      const c = cards.find((x) => x.id === one[1] || x.shortUrl.endsWith(`/${one[1]}`));
      if (!c) return new Response("not found", { status: 404 });
      if (method === "PUT") {
        if (params.idList) c.idList = params.idList;
        if (params.due) c.due = params.due;
      }
      return Response.json(c);
    }
    if (method === "POST" && path === "/cards") {
      const c = card(params.idList, params.name, params.desc, { id: `NEW${++created}`, idLabels: params.idLabels ? params.idLabels.split(",") : [] });
      cards.push(c);
      return Response.json(c);
    }
    return new Response(`unexpected ${method} ${path}`, { status: 500 });
  }) as unknown as typeof fetch;
  return { cards, writes, fetchFn };
}
