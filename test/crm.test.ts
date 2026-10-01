import { beforeEach, describe, expect, it } from "vitest";
import { displayPhone, extractPhones, marketFor, phoneKey } from "../src/crm/phones.js";
import { dailyReport } from "../src/crm/report.js";
import { type ChatMessage, isAutoReply, onMessage, overdue, reconcile } from "../src/crm/rules.js";
import { CrmSync } from "../src/crm/sync.js";
import { localDayAt } from "../src/crm/time.js";
import { EventBus } from "../src/events/bus.js";
import { openDb } from "../src/store/db.js";
import { type NewMessage, Store } from "../src/store/store.js";
import { TrelloClient, type TrelloCard } from "../src/trello/client.js";
import { card, fakeTrello } from "./fakeTrello.js";
import { setup, testConfig } from "./helpers.js";

// "Now" is 1 Oct 2026, 12:00 in São Paulo.
const NOW_MS = Date.parse("2026-10-01T15:00:00Z");
const NOW = NOW_MS / 1000;
const DAY = 86400;

describe("phone numbers on cards", () => {
  it("finds every format used on the board", () => {
    const desc = [
      "WHATSAPP: +55 11 93000-2222",
      "WHATSAPP: +55 11 94000 4444",
      "WhatsApp verificado: +55 11 99000-5555",
      "VERIFIED WHATSAPP ROUTE FROM DAVI'S GMAIL SIGNATURE: +55 11 4000-6666",
      "WHATSAPP: +971 56 000 3333 — previously verified",
      "READY-TO-SEND:",
      "https://wa.me/5511970007777?text=Oi%2C%20tudo%20bem%3F%20+55%2011",
      "Official site explicitly publishes WhatsApp 11 99000-1111 for Marina Teste.",
      "Fonte: https://www.example.com.br/ (call +55 11 3333-4444 for the shop)",
      "VERIFIED EMAIL: diego@lentefilmes.example",
    ].join("\n");
    expect(extractPhones(desc).sort()).toEqual(
      ["5511930002222", "5511940004444", "5511990005555", "551140006666", "971560003333", "5511970007777"].sort(),
    );
  });

  it("treats Brazilian ids with and without the mobile 9 as the same number", () => {
    expect(phoneKey("+55 11 99000-1111")).toBe(phoneKey("551190001111"));
    expect(phoneKey("+55 11 4000-6666")).toBe("551140006666"); // landline untouched
    expect(phoneKey("5215512345678")).toBe(phoneKey("+52 55 1234 5678"));
    expect(phoneKey("+971 56 000 3333")).toBe("971560003333");
  });

  it("formats numbers and picks the market label", () => {
    expect(displayPhone("5511990001111")).toBe("+55 11 99000-1111");
    expect(displayPhone("971560003333")).toBe("+971560003333");
    expect(marketFor("5511990001111")).toBe("Brazil");
    expect(marketFor("971560003333")).toBe("Gulf / Arab");
    expect(marketFor("201001234567")).toBe("Gulf / Arab");
    expect(marketFor("447700900123")).toBe("International (EN)");
  });
});

let id = 0;
const m = (direction: "in" | "out", body: string, timestamp: number, type = "text"): ChatMessage => ({
  id: `m${++id}`, direction, type, body, timestamp,
});

describe("pipeline rules", () => {
  it("spots Business-app away messages, like the one a lead's studio sent", () => {
    const out = m("out", "Olá Marina!", NOW - 3600);
    const away = m("in", "Não estamos disponíveis no momento. Assim que possível entraremos em contato.", NOW - 3000);
    expect(isAutoReply(away, [out, away])).toBe(true);
    const human = m("in", "Thanks! I'll get back to you next week.", NOW - 3000);
    expect(isAutoReply(human, [out, human])).toBe(false);
  });

  it("treats an instant first reply as automatic", () => {
    const out = m("out", "Hi Sara", NOW - 100);
    const instant = m("in", "Hello! Welcome to Horizonte Produções.", NOW - 95);
    expect(isAutoReply(instant, [out, instant])).toBe(true);
    const later = m("in", "Hi, who is this?", NOW - 95);
    expect(isAutoReply(later, [out, m("in", "earlier", NOW - 200), later].sort((a, b) => a.timestamp - b.timestamp))).toBe(false);
  });

  it("moves forward on messages and never back", () => {
    const out = m("out", "Oi!", NOW);
    expect(onMessage("ready", out, [out])?.to).toBe("contacted");
    expect(onMessage("leads", out, [out])?.to).toBe("contacted");
    expect(onMessage("follow_up", out, [out])).toBeNull();
    expect(onMessage("replied", out, [out])).toBeNull();

    const chat = [m("out", "Oi!", NOW - DAY), m("in", "Interessante. Pode enviar sim.", NOW)];
    for (const s of ["leads", "ready", "contacted", "follow_up"] as const) expect(onMessage(s, chat[1], chat)?.to).toBe("replied");
    for (const s of ["replied", "meeting", "won", "dead"] as const) expect(onMessage(s, chat[1], chat)).toBeNull();

    const react = m("in", "[reaction 👍]", NOW, "reaction");
    expect(onMessage("contacted", react, [chat[0], react])).toBeNull();
  });

  it("flags Contacted leads after N quiet days", () => {
    const sent = m("out", "Oi!", NOW - 3 * DAY);
    expect(overdue("contacted", [sent], NOW, 3)).toMatchObject({ to: "follow_up", setDue: true });
    expect(overdue("contacted", [sent], NOW - 60, 3)).toBeNull();
    expect(overdue("follow_up", [sent], NOW, 3)).toBeNull();
    const away = m("in", "Não estamos disponíveis no momento.", NOW - 3 * DAY + 5);
    expect(overdue("contacted", [sent, away], NOW, 3)?.to).toBe("follow_up"); // an away message isn't a reply
    expect(overdue("contacted", [sent, m("in", "Oi, tudo bem?", NOW - DAY)], NOW, 3)).toBeNull();
  });

  it("reconciles a whole history", () => {
    expect(reconcile("ready", [m("out", "Oi", NOW - DAY)], NOW, 3)?.to).toBe("contacted");
    expect(reconcile("ready", [m("out", "Oi", NOW - 5 * DAY)], NOW, 3)?.to).toBe("follow_up");
    expect(reconcile("follow_up", [m("out", "Oi", NOW - 5 * DAY), m("in", "Sim!", NOW - DAY)], NOW, 3)?.to).toBe("replied");
    expect(reconcile("replied", [m("in", "Sim!", NOW - 9 * DAY), m("out", "Segue", NOW - 5 * DAY)], NOW, 3)).toBeNull();
    expect(reconcile("contacted", [], NOW, 3)).toBeNull();
  });

  it("puts the follow-up due date at 09:00 São Paulo time", () => {
    expect(localDayAt(NOW_MS, 9, "America/Sao_Paulo").toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(localDayAt(NOW_MS, 9, "Asia/Dubai").toISOString()).toBe("2026-10-01T05:00:00.000Z");
  });
});

// ---- the sync, against a fake copy of the board ---------------------------------------

const RITA = "5511990001111"; // Replied
const RITA_OLD_ID = "551190001111"; // the same line, as an older WhatsApp id
const LUMA = "5511930002222"; // Ready to Contact
const SARA = "971560003333"; // Contacted
const OFICINA = "5511940004444"; // Follow Up
const BISTRO = "5511990005555"; // Contacted
const LENTE = "551140006666"; // Meeting
const STRANGER = "5521987654321"; // no card
const FRIEND = "5511955554444"; // no card, marked "not a lead"
const DUP = "5511970000001"; // on two cards
const ARCHIVED = "5521999990000"; // only on an archived card

function board(): TrelloCard[] {
  return [
    card("L_ready", "LUMA — Bia Teste | Brazil | WhatsApp", "STATUS: Ready to Contact\nWHATSAPP: +55 11 93000-2222", { id: "luma" }),
    card("L_contacted", "Horizonte Produções — Sara Demo | Gulf / Arab | WhatsApp", "WHATSAPP: +971 56 000 3333\nWhatsApp link: https://wa.me/971560003333", { id: "sara" }),
    card("L_follow", "Oficina & Cia — Lia Exemplo | Brazil | WhatsApp", "WHATSAPP: +55 11 94000 4444", { id: "oficina" }),
    card("L_replied", "Estúdio Barro Azul — Marina Teste | Brazil | WhatsApp", "Official site publishes WhatsApp 11 99000-1111.\nWHATSAPP: +55 11 99000-1111", { id: "rita" }),
    card("L_contacted", "Bistrô Um — Tati Exemplo | WhatsApp | Brazil small business", "WhatsApp verificado: +55 11 99000-5555\nREADY-TO-SEND:\nhttps://wa.me/5511990005555?text=Oi", { id: "bistro" }),
    card("L_meeting", "Lente Filmes | Email/WhatsApp | Brazil", "VERIFIED WHATSAPP ROUTE FROM DAVI'S GMAIL SIGNATURE: +55 11 4000-6666", { id: "lente" }),
    card("L_ready", "Dup A", "WHATSAPP: +55 11 97000-0001", { id: "dupA" }),
    card("L_contacted", "Dup B", "WHATSAPP: +55 11 97000-0001", { id: "dupB" }),
    card("L_dead", "Old lead", "WHATSAPP: +55 21 99999-0000", { id: "old", closed: true }),
  ];
}

let store: Store;
let bus: EventBus;
let trello: ReturnType<typeof fakeTrello>;
let sync: CrmSync;
let clock = NOW_MS;

beforeEach(() => {
  clock = NOW_MS;
  store = new Store(openDb(":memory:"));
  bus = new EventBus();
  trello = fakeTrello(board());
  sync = new CrmSync({
    config: testConfig({ TRELLO_API_KEY: "key", TRELLO_TOKEN: "token", TRELLO_BOARD_ID: "B1", CRM_FOLLOW_UP_DAYS: 3, CRM_NEW_LEAD_LOOKBACK_DAYS: 30, CRM_CHANNEL_LABEL: "WP" }),
    store,
    bus,
    trello: new TrelloClient("key", "token", { fetch: trello.fetchFn }),
    now: () => clock,
    log: { info() {}, warn() {}, error() {} },
  });
  sync.start();
});

let mid = 0;
/** Stores a message and announces it the way the webhook does. */
async function say(waId: string, direction: "in" | "out", body: string, ts: number, opts: { type?: string; source?: NewMessage["source"]; name?: string } = {}) {
  const msg: NewMessage = {
    id: `wamid.${++mid}`, waId, direction, source: opts.source ?? (direction === "in" ? "webhook" : "echo"),
    type: opts.type ?? "text", body, timestamp: ts, raw: {},
  };
  store.recordMessage(msg);
  if (opts.name) store.upsertContact({ waId, profileName: opts.name });
  bus.emit("message", msg, { backfill: msg.source === "history" });
  await sync.idle();
  return msg;
}
const cardList = (id: string) => trello.cards.find((c) => c.id === id)!.idList;

describe("CRM sync: preview mode (the default)", () => {
  it("changes nothing on Trello when messages arrive", async () => {
    await say(LUMA, "out", "Oi Bia!", NOW - 60);
    await say(STRANGER, "in", "Oi, vi o perfil de vocês", NOW - 30);
    expect(sync.mode).toBe("preview");
    expect(trello.writes).toEqual([]);
  });

  it("previews every change from history, then applies it and goes live", async () => {
    const hist = { source: "history" as const };
    await say(LUMA, "out", "Oi Bia! Sou o Mohammed da Inhouse.", NOW - DAY, hist); // Ready → Contacted
    await say(SARA, "out", "Hi Sara, Mohammed from Inhouse.", NOW - 5 * DAY, hist); // Contacted, quiet 5 days → Follow Up
    await say(OFICINA, "out", "Oi Lia!", NOW - 4 * DAY, hist);
    await say(OFICINA, "in", "Oi! Pode mandar sim.", NOW - DAY, { ...hist, name: "Lia F" }); // Follow Up → Replied
    await say(RITA_OLD_ID, "out", "Olá Marina!", NOW - 3 * DAY, hist);
    await say(RITA_OLD_ID, "in", "Interessante. Pode enviar sim.", NOW - 2 * DAY, hist); // already Replied: stays
    await say(LENTE, "in", "Davi aqui, vamos marcar?", NOW - DAY, hist); // Meeting: never moved
    await say(STRANGER, "in", "Olá, quanto custa um vídeo?", NOW - 2 * DAY, { ...hist, name: "Carla" }); // new card
    await say("5531911112222", "in", "Oi sumido", NOW - 90 * DAY, hist); // unknown but old: ignored
    await say("5541933334444", "out", "Oi Paulo, tudo certo?", NOW - DAY, hist); // you wrote, no card
    await say(ARCHIVED, "in", "Voltei! Ainda fazem vídeos?", NOW - DAY, hist); // archived card
    await say(DUP, "in", "Oi", NOW - DAY, hist); // conflict

    const p = await sync.preview();
    expect(trello.writes).toEqual([]);
    const summary = p.items.map((i) => `${i.kind} ${i.cardName.split(" ")[0]} ${i.from ?? "-"}→${i.to}`).sort();
    expect(summary).toEqual([
      "create New -→Leads",
      "move Oficina Follow Up→Replied",
      "move Horizonte Contacted→Follow Up",
      "move LUMA Ready to Contact→Contacted",
    ].sort());
    expect(p.items.find((i) => i.kind === "create")!.cardName).toBe("New inbound — Carla | Brazil | WhatsApp");
    expect(p.conflicts).toEqual([{ number: "+55 11 97000-0001", cards: [{ name: "Dup A", url: "https://trello.com/c/dupA" }, { name: "Dup B", url: "https://trello.com/c/dupB" }] }]);
    expect(p.untracked.map((u) => u.waId)).toEqual(["5541933334444"]);
    expect(p.archived.map((a) => a.card)).toEqual(["Old lead"]);
    expect(p.olderUnknown).toBe(1);

    const r = await sync.apply(p.id);
    expect(r).toMatchObject({ mode: "live", skipped: [], failed: [] });
    expect(r.applied).toHaveLength(4);
    expect(cardList("luma")).toBe("L_contacted");
    expect(cardList("sara")).toBe("L_follow");
    expect(trello.cards.find((c) => c.id === "sara")!.due).toBe("2026-10-01T12:00:00.000Z");
    expect(cardList("oficina")).toBe("L_replied");
    expect(cardList("rita")).toBe("L_replied");
    expect(cardList("lente")).toBe("L_meeting");
    const created = trello.cards.find((c) => c.id === "NEW1")!;
    expect(created).toMatchObject({ idList: "L_leads", idLabels: ["LB_wp", "LB_br"] });
    expect(created.desc).toContain("WHATSAPP: +55 21 98765-4321");
    expect(created.desc).toContain("“Olá, quanto custa um vídeo?”");
  });

  it("applies only chosen items, and skips cards you moved after the preview", async () => {
    await say(LUMA, "out", "Oi Bia!", NOW - DAY, { source: "history" });
    await say(SARA, "out", "Hi Sara", NOW - 5 * DAY, { source: "history" });
    const p = await sync.preview();
    const saraItem = p.items.find((i) => i.cardId === "sara")!;
    trello.cards.find((c) => c.id === "sara")!.idList = "L_meeting"; // you moved it by hand
    const r = await sync.apply(p.id, [saraItem.n], false);
    expect(r.skipped).toEqual([`#${saraItem.n} ${saraItem.cardName}: the card changed since the preview`]);
    expect(cardList("luma")).toBe("L_ready"); // not chosen
    expect(r.mode).toBe("preview");
    await expect(sync.apply(p.id)).rejects.toThrow(/isn't the latest/);
  });
});

describe("CRM sync: live", () => {
  beforeEach(() => sync.setMode("live"));

  it("moves Ready to Contact → Contacted when you message from your phone", async () => {
    await say(LUMA, "out", "Oi Bia! Sou o Mohammed da Inhouse.", NOW);
    expect(cardList("luma")).toBe("L_contacted");
    expect(trello.writes).toEqual([{ method: "PUT", path: "/cards/luma", params: { idList: "L_contacted", pos: "top" } }]);
  });

  it("moves a waiting lead to Replied as soon as they answer, but not for an away message", async () => {
    await say(SARA, "out", "Hi Sara", NOW - 2 * DAY);
    await say(SARA, "in", "Thank you for contacting Horizonte Produções. We will get back to you shortly.", NOW - 2 * DAY + 600);
    expect(cardList("sara")).toBe("L_contacted");
    await say(SARA, "in", "Hi Mohammed, happy to talk. Are you in Dubai?", NOW);
    expect(cardList("sara")).toBe("L_replied");
  });

  it("matches a Brazilian lead whose WhatsApp id lacks the mobile 9", async () => {
    trello.cards.find((c) => c.id === "rita")!.idList = "L_follow";
    await sync.getBoard(0);
    await say(RITA_OLD_ID, "out", "Olá Marina!", NOW - DAY);
    await say(RITA_OLD_ID, "in", "Bom dia! Interessante.", NOW);
    expect(cardList("rita")).toBe("L_replied");
  });

  it("never moves cards in Replied, Meeting, Won or Dead", async () => {
    await say(LENTE, "in", "Davi aqui", NOW);
    await say(RITA, "in", "Obrigada!", NOW);
    await say(RITA, "out", "Segue o exemplo", NOW);
    expect(trello.writes).toEqual([]);
  });

  it("creates one card in Leads for an unknown number, labelled WP and by market", async () => {
    await say(SARA.replace("971560003333", "971501112233"), "in", "Hello, do you do corporate films?", NOW - 60, { name: "Omar" });
    await say("971501112233", "in", "We're based in Abu Dhabi", NOW);
    const created = trello.writes.filter((w) => w.method === "POST");
    expect(created).toHaveLength(1);
    expect(created[0].params).toMatchObject({ idList: "L_leads", name: "New inbound — Omar | Gulf / Arab | WhatsApp", idLabels: "LB_wp,LB_gulf", pos: "top" });
    expect(created[0].params.desc).toContain("WhatsApp link: https://wa.me/971501112233");
  });

  it("doesn't create cards for automatic replies, numbers you marked, or archived leads", async () => {
    await sync.link(FRIEND, null, "my cousin");
    await say(FRIEND, "in", "E aí, vamos almoçar?", NOW);
    await say("5511944440000", "out", "Oi!", NOW - 100);
    await say("5511944440000", "in", "Olá! Obrigado por entrar em contato.", NOW - 90);
    await say(ARCHIVED, "in", "Voltei!", NOW);
    expect(trello.writes).toEqual([]);
  });

  it("leaves numbers that are on two cards alone", async () => {
    await say(DUP, "in", "Oi", NOW);
    expect(trello.writes).toEqual([]);
  });

  it("re-reads the board before creating a card, in case you just added the lead", async () => {
    await sync.getBoard(0);
    trello.cards.push(card("L_ready", "Just added", "WHATSAPP: +55 21 98765-4321", { id: "fresh" }));
    clock += 2 * 60_000;
    await say(STRANGER, "in", "Oi, recebi sua mensagem", clock / 1000);
    expect(trello.writes.filter((w) => w.method === "POST")).toEqual([]);
    expect(cardList("fresh")).toBe("L_replied");
  });

  it("ignores history backfill and reactions", async () => {
    await say(LUMA, "out", "Oi", NOW, { source: "history" });
    await say(SARA, "in", "[reaction 👍]", NOW, { type: "reaction" });
    expect(trello.writes).toEqual([]);
  });

  it("sweeps quiet Contacted leads to Follow Up with today's due date", async () => {
    await say(SARA, "out", "Hi Sara", NOW - 4 * DAY, { source: "history" });
    await say(BISTRO, "out", "Oi Tati", NOW - DAY, { source: "history" });
    expect(await sync.sweepOverdue()).toBe(1);
    expect(cardList("sara")).toBe("L_follow");
    expect(cardList("bistro")).toBe("L_contacted");
    expect(trello.writes).toEqual([{ method: "PUT", path: "/cards/sara", params: { idList: "L_follow", pos: "top", due: "2026-10-01T12:00:00.000Z" } }]);
    expect(await sync.sweepOverdue()).toBe(0); // already moved
  });

  it("links a number to a card by URL", async () => {
    const r = await sync.link("+55 11 95555-0000", "https://trello.com/c/luma/452-luma");
    expect(r).toBe("+55 11 95555-0000 → LUMA — Bia Teste | Brazil | WhatsApp");
    await say("5511955550000", "out", "Oi Bia, aqui é o Mohammed", NOW);
    expect(cardList("luma")).toBe("L_contacted");
  });

  it("records failures instead of crashing", async () => {
    await sync.getBoard(0);
    trello.cards.splice(trello.cards.findIndex((c) => c.id === "luma"), 1); // card deleted on Trello since
    await say(LUMA, "out", "Oi", NOW);
    const row = store.db.prepare("SELECT ok, error FROM crm_actions").get() as { ok: number; error: string };
    expect(row.ok).toBe(0);
    expect(row.error).toMatch(/404/);
  });
});

describe("board checks", () => {
  it("explains a renamed list", async () => {
    const t = fakeTrello(board(), [{ id: "x", name: "Leads", pos: 1 }]);
    const s = new CrmSync({
      config: testConfig({ TRELLO_BOARD_ID: "B1" }), store, bus,
      trello: new TrelloClient("key", "token", { fetch: t.fetchFn }), log: { info() {}, warn() {}, error() {} },
    });
    await expect(s.getBoard()).rejects.toThrow(/no list named "Ready to Contact"/);
  });

  it("explains a bad Trello key", async () => {
    const s = new CrmSync({
      config: testConfig({ TRELLO_BOARD_ID: "B1" }), store, bus,
      trello: new TrelloClient("wrong", "token", { fetch: trello.fetchFn }), log: { info() {}, warn() {}, error() {} },
    });
    await expect(s.getBoard()).rejects.toThrow(/Check TRELLO_API_KEY/);
  });
});

describe("daily report", () => {
  it("summarizes the day", async () => {
    sync.setMode("live");
    trello.cards.find((c) => c.id === "oficina")!.due = "2026-09-30T12:00:00.000Z";
    await sync.getBoard(0);
    await say(LUMA, "out", "Oi Bia!", NOW - 3 * 3600);
    await say(SARA, "out", "Hi Sara", NOW - 5 * 3600);
    await say(SARA, "in", "Hi! Can you send your reel?", NOW - 3600);
    await say(STRANGER, "in", "Olá, quanto custa?", NOW - 1800, { name: "Carla" });
    await say("5511944440000", "out", "Oi!", NOW - 100);
    await say("5511944440000", "in", "Olá! Obrigado por entrar em contato.", NOW - 90);

    const r = await dailyReport({ config: testConfig(), store, sync, now: () => NOW_MS });
    expect(r).toContain("Received 3 messages from 3 people; sent 3 to 3.");
    expect(r).toMatch(/Waiting on your reply \(2\)[\s\S]*Horizonte Produções — Sara Demo[\s\S]*Can you send your reel/);
    expect(r).toContain("LUMA — Bia Teste | Brazil | WhatsApp: Ready to Contact → Contacted");
    expect(r).toContain("Horizonte Produções — Sara Demo | Gulf / Arab | WhatsApp: Contacted → Replied");
    expect(r).toContain("➕ New inbound — Carla | Brazil | WhatsApp → Leads");
    expect(r).toMatch(/Follow-ups due today or earlier \(1\)\n- Oficina & Cia/);
    expect(r).toContain("Automatic reply (not counted as a reply)");
    expect(r).toContain("+55 11 97000-0001 is on 2 cards");
    expect(r).toContain("who has no card");
  });

  it("drops a follow-up once you send it, and brings it back if they stay quiet", async () => {
    sync.setMode("live");
    await say(SARA, "out", "Hi Sara", NOW - 4 * DAY);
    await sync.sweepOverdue(); // → Follow Up, due today 09:00
    const report = () => dailyReport({ config: testConfig(), store, sync, now: () => clock });
    expect(await report()).toMatch(/- Horizonte Produções.*\(due 2026-10-01 09:00\)/);

    clock = NOW_MS + 3600_000;
    await say(SARA, "out", "Hi Sara, just following up on my message.", clock / 1000);
    const after = await report();
    expect(after).not.toMatch(/- Horizonte Produções.*\(due/);
    expect(after).toMatch(/Follow-ups due today or earlier \(1\)\n- Oficina/); // the other card is still due

    clock = NOW_MS + 4 * DAY * 1000;
    expect(await report()).toMatch(/Horizonte Produções.*follow up again, no reply 3 days after your last follow-up/);
  });

  it("still reports WhatsApp activity without Trello", async () => {
    store.recordMessage({ id: "x", waId: STRANGER, direction: "in", source: "webhook", type: "text", body: "Oi", timestamp: NOW - 60, raw: {} });
    const r = await dailyReport({ config: testConfig(), store, now: () => NOW_MS });
    expect(r).toContain("Waiting on your reply (1)");
    expect(r).toContain("Trello isn't connected");
  });
});

describe("CRM tools over MCP", () => {
  it("previews, applies and looks up cards the way Claude will", async () => {
    const t = fakeTrello(board());
    const s = await setup({}, (d) => new CrmSync({
      ...d, trello: new TrelloClient("key", "token", { fetch: t.fetchFn }), now: () => NOW_MS, log: { info() {}, warn() {}, error() {} },
    }));
    s.store.recordMessage({ id: "h1", waId: LUMA, direction: "out", source: "history", type: "text", body: "Oi Bia", timestamp: NOW - DAY, raw: {} });

    const status = await s.call("crm_sync_status");
    expect(status.text).toContain("Mode: PREVIEW");
    expect(status.text).toMatch(/8 open cards, 8 with a WhatsApp number/);

    const preview = await s.call("crm_preview_sync");
    expect(preview.text).toContain("#1 LUMA — Bia Teste | Brazil | WhatsApp: Ready to Contact → Contacted.");
    expect(preview.text).toContain("+55 11 97000-0001: Dup A");
    const id = preview.text.match(/Preview (\w+)/)![1];

    const applied = await s.call("crm_apply_sync", { preview_id: id });
    expect(applied.text).toMatch(/Applied 1, skipped 0, failed 0\. Sync mode: LIVE/);
    expect(t.cards.find((c) => c.id === "luma")!.idList).toBe("L_contacted");

    const found = await s.call("crm_find_card", { contact: "+55 11 93000-2222" });
    expect(found.text).toBe("+55 11 93000-2222 → LUMA — Bia Teste | Brazil | WhatsApp [Contacted] https://trello.com/c/luma");
    expect((await s.call("crm_find_card", { contact: "+55 11 97000-0001" })).text).toContain("several open cards");

    expect((await s.call("crm_set_mode", { mode: "preview" })).text).toContain("PAUSED");
    expect((await s.call("crm_apply_sync", { preview_id: "nope" })).isError).toBe(true);

    const prompt = await s.mcp.getPrompt({ name: "morning_whatsapp_review" });
    expect((prompt.messages[0].content as { text: string }).text).toContain("crm_daily_report");
  });

  it("says clearly when Trello isn't connected", async () => {
    const s = await setup();
    const r = await s.call("crm_preview_sync");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Trello isn't connected");
    expect((await s.call("crm_daily_report")).text).toContain("Trello isn't connected");
  });
});
