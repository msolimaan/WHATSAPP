import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrmSync } from "../src/crm/sync.js";
import { parseLocalTime } from "../src/crm/time.js";
import { EventBus } from "../src/events/bus.js";
import { build } from "../src/followups/content.js";
import { FollowupEngine, type Step } from "../src/followups/engine.js";
import { isOptOut } from "../src/followups/optout.js";
import { isQuiet, nextAllowed } from "../src/followups/quiet.js";
import { fill, missingVars, varsFromCard } from "../src/followups/vars.js";
import { openDb } from "../src/store/db.js";
import { type NewMessage, Store } from "../src/store/store.js";
import { TrelloClient } from "../src/trello/client.js";
import { providerFor, WhatsAppClient } from "../src/whatsapp/client.js";
import { Messenger } from "../src/whatsapp/messenger.js";
import { card, fakeTrello } from "./fakeTrello.js";
import { fakeWhatsApp, setup, testConfig } from "./helpers.js";

// Thursday 1 Oct 2026, 12:00 in São Paulo.
const NOW_MS = Date.parse("2026-10-01T15:00:00Z");
const NOW = NOW_MS / 1000;
const DAY = 86400;
const HOUR = 3600;
const SP = "America/Sao_Paulo";
const silent = { info() {}, warn() {}, error() {} };

describe("opt-out detection", () => {
  it("recognizes requests to stop in Portuguese, English, Spanish and Arabic", () => {
    for (const m of ["STOP", "Parar", "sair.", "Não tenho interesse, obrigado", "please remove me", "Not interested", "no me interesa", "غير مهتم"]) {
      expect(isOptOut(m), m).toBe(true);
    }
  });
  it("doesn't fire on ordinary messages", () => {
    for (const m of ["Can you stop by the studio tomorrow?", "Pode parar aqui no estúdio amanhã?", "Interessante!", "", null]) {
      expect(isOptOut(m), String(m)).toBe(false);
    }
  });
});

describe("placeholders", () => {
  it("fills known values and reports what's missing", () => {
    expect(fill("Oi {{first_name}}, tudo bem? Sobre a {{company}}…", { first_name: "Bia", company: "LUMA" })).toBe("Oi Bia, tudo bem? Sobre a LUMA…");
    expect(missingVars(fill("Oi {{first_name}} da {{company}}", { first_name: "Bia" }))).toEqual(["company"]);
  });

  it("reads name and company from cards in the board's formats", () => {
    expect(varsFromCard({ name: "LUMA — Bia Teste | Brazil | WhatsApp", desc: "CONTACT: Bia Teste\nCOMPANY: LUMA" })).toEqual({ name: "Bia Teste", first_name: "Bia", company: "LUMA" });
    expect(varsFromCard({ name: "Lente Filmes | Email/WhatsApp | Brazil", desc: "CONTACT: Davi Exemplo — Director / Production Manager, Lente Filmes" })).toEqual({ name: "Davi Exemplo", first_name: "Davi" });
    expect(varsFromCard({ name: "Bistrô Um — Tati Exemplo | WhatsApp | Brazil small business", desc: "Contact: Tati Exemplo — chef" })).toEqual({ name: "Tati Exemplo", first_name: "Tati", company: "Bistrô Um" });
    expect(varsFromCard({ name: "Pão de Alho — Chef Acir | WhatsApp", desc: "" })).toMatchObject({ first_name: "Acir" });
    expect(varsFromCard({ name: "Some lead", desc: "" }, "Paula Lima")).toEqual({ name: "Paula Lima", first_name: "Paula" });
  });
});

describe("quiet hours", () => {
  const w = { quietHours: "20:00-08:30", skipWeekends: false, timeZone: SP };
  it("knows when sending is allowed", () => {
    expect(isQuiet(Date.parse("2026-10-01T15:00:00Z"), w)).toBe(false); // 12:00
    expect(isQuiet(Date.parse("2026-10-01T23:30:00Z"), w)).toBe(true); // 20:30
    expect(isQuiet(Date.parse("2026-10-02T11:00:00Z"), w)).toBe(true); // 08:00
    expect(isQuiet(Date.parse("2026-10-03T15:00:00Z"), { ...w, skipWeekends: true })).toBe(true); // Saturday
  });
  it("moves a quiet time to the next morning, or Monday", () => {
    expect(new Date(nextAllowed(Date.parse("2026-10-01T23:30:00Z"), w)).toISOString()).toBe("2026-10-02T11:30:00.000Z"); // 08:30
    expect(new Date(nextAllowed(Date.parse("2026-10-03T15:00:00Z"), { ...w, skipWeekends: true })).toISOString()).toBe("2026-10-05T11:30:00.000Z");
  });
  it("reads times typed in your time zone", () => {
    expect(new Date(parseLocalTime("2026-10-02 09:30", SP)).toISOString()).toBe("2026-10-02T12:30:00.000Z");
    expect(new Date(parseLocalTime("2026-10-02T09:30:00Z", SP)).toISOString()).toBe("2026-10-02T09:30:00.000Z");
    expect(parseLocalTime("next tuesday", SP)).toBeNaN();
  });
});

describe("choosing text or template", () => {
  const c = { text: "Oi {{first_name}}! Conseguiu ver?", template: { name: "followup_pt", language: "pt_BR", body_params: ["{{first_name}}"] } };
  it("uses free text inside the window and the template outside it", () => {
    expect(build(c, true, { first_name: "Bia" })).toMatchObject({ ok: true, paid: false, message: { type: "text", text: { body: "Oi Bia! Conseguiu ver?" } } });
    expect(build(c, false, { first_name: "Bia" })).toMatchObject({
      ok: true,
      paid: true,
      message: { type: "template", template: { name: "followup_pt", language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: "Bia" }] }] } },
    });
  });
  it("refuses to send unfilled placeholders or text outside the window", () => {
    expect(build(c, false, {})).toMatchObject({ ok: false, reason: expect.stringContaining("{{first_name}}") });
    expect(build({ text: "Oi!" }, false)).toMatchObject({ ok: false, reason: expect.stringContaining("window is closed") });
  });
});

// ---- the engine ---------------------------------------------------------------------

const BIA = "5511930002222";
const SARA = "971560003333";
const LIA = "5511940004444";

let store: Store;
let bus: EventBus;
let wa: ReturnType<typeof fakeWhatsApp>;
let fu: FollowupEngine;

function engine(over: Parameters<typeof testConfig>[0] = {}) {
  const config = testConfig(over);
  store = new Store(openDb(":memory:"));
  bus = new EventBus();
  wa = fakeWhatsApp();
  const messenger = new Messenger(new WhatsAppClient(providerFor(config), { fetch: wa.fetchFn, backoffMs: 1 }), store, bus);
  fu = new FollowupEngine({ config, store, bus, messenger, log: silent });
  fu.start();
}

let mid = 0;
function say(waId: string, direction: "in" | "out", body: string, ts = Date.now() / 1000, opts: { source?: NewMessage["source"]; emit?: boolean } = {}) {
  const msg: NewMessage = {
    id: `wamid.${++mid}`, waId, direction, source: opts.source ?? (direction === "in" ? "webhook" : "echo"),
    type: "text", body, timestamp: Math.floor(ts), raw: {},
  };
  store.recordMessage(msg);
  if (opts.emit !== false) bus.emit("message", msg, { backfill: msg.source === "history" });
}
const at = (iso: string) => vi.setSystemTime(Date.parse(iso));
const sentBodies = () => wa.calls.filter((c) => c.url.endsWith("/messages")).map((c) => c.body as Record<string, unknown>);
const enrollment = () => fu.enrollments()[0];

const TWO_STEPS: Step[] = [
  { after_days: 3, template: { name: "followup_1", language: "pt_BR", body_params: ["{{first_name}}"] } },
  { after_days: 4, text: "Oi {{first_name}}, última mensagem!", template: { name: "followup_2", language: "pt_BR", body_params: ["{{first_name}}"] } },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  engine();
});
afterEach(() => {
  fu.stop();
  vi.useRealTimers();
});

describe("drafts and scheduled messages", () => {
  it("sends an approved draft, choosing text while the window is open", async () => {
    say(BIA, "in", "Oi! Pode mandar o portfólio?", NOW - HOUR);
    const d = fu.createDraft(BIA, { text: "Claro! Segue: https://example.com/portfolio.pdf" }, "reply");
    expect(sentBodies()).toEqual([]);
    const [r] = await fu.approve([d.id]);
    expect(r).toMatchObject({ ok: true, detail: expect.stringMatching(/^sent/) });
    expect(sentBodies()[0]).toMatchObject({ to: BIA, type: "text" });
    expect(fu.outbox(d.id)).toMatchObject({ status: "sent", message_id: "wamid.SENT1" });
  });

  it("won't send free text once the window has closed", async () => {
    say(BIA, "in", "Oi!", NOW - 2 * DAY);
    const d = fu.createDraft(BIA, { text: "Oi Bia" });
    const [r] = await fu.approve([d.id]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no template to fall back on");
    expect(sentBodies()).toEqual([]);
  });

  it("sends a scheduled message on time, and cancels it if they write first", async () => {
    const a = fu.schedule(BIA, { template: { name: "followup_1", language: "pt_BR", body_params: ["Bia"] } }, NOW + DAY);
    const b = fu.schedule(SARA, { template: { name: "followup_en", language: "en", body_params: ["Sara"] } }, NOW + DAY);
    await fu.tick();
    expect(sentBodies()).toEqual([]);
    at("2026-10-01T23:00:00Z");
    say(SARA, "in", "Hi! Sorry for the delay, yes let's talk.");
    expect(fu.outbox(b.id)).toMatchObject({ status: "cancelled", error: "they replied" });
    at("2026-10-02T15:01:00Z");
    await fu.tick();
    expect(sentBodies().map((m) => m.to)).toEqual([BIA]);
    expect(fu.outbox(a.id)!.status).toBe("sent");
  });

  it("rejects drafts and cancels scheduled messages", () => {
    const d = fu.createDraft(BIA, { text: "x" });
    const s = fu.schedule(BIA, { text: "y" }, NOW + DAY);
    expect(fu.discard([d.id, s.id, 999]).map((r) => r.detail)).toEqual(["draft rejected", "scheduled message cancelled", "not found"]);
  });
});

describe("sequences", () => {
  beforeEach(() => {
    fu.saveSequence("Cold follow-up", TWO_STEPS);
    say(BIA, "out", "Oi Bia! Sou o Mohammed da Inhouse.", NOW - HOUR); // first outreach from the phone, before enrolling
  });

  it("sends each step on schedule with the lead's name, then finishes", async () => {
    expect(fu.enroll("Cold follow-up", [{ waId: BIA, vars: { first_name: "Bia" } }]).enrolled).toHaveLength(1);
    expect(new Date(enrollment().next_at! * 1000).toISOString()).toBe("2026-10-04T15:00:00.000Z");

    at("2026-10-03T15:00:00Z");
    await fu.tick();
    expect(sentBodies()).toEqual([]);

    at("2026-10-04T15:00:00Z");
    await fu.tick();
    expect(sentBodies()).toEqual([
      expect.objectContaining({ to: BIA, type: "template", template: expect.objectContaining({ name: "followup_1", components: [{ type: "body", parameters: [{ type: "text", text: "Bia" }] }] }) }),
    ]);
    expect(enrollment()).toMatchObject({ step: 1, status: "active" });
    expect(new Date(enrollment().next_at! * 1000).toISOString()).toBe("2026-10-08T15:00:00.000Z");

    at("2026-10-08T15:00:00Z");
    await fu.tick();
    expect(sentBodies()[1]).toMatchObject({ type: "template", template: expect.objectContaining({ name: "followup_2" }) });
    expect(enrollment()).toMatchObject({ status: "completed" });
  });

  it("stops the moment they really reply, but not for an away message", async () => {
    fu.enroll("Cold follow-up", [{ waId: BIA, vars: { first_name: "Bia" } }]);
    say(BIA, "in", "Olá! Obrigado por entrar em contato. Retornaremos em breve.", NOW - HOUR + 20);
    expect(enrollment().status).toBe("active");
    at("2026-10-02T15:00:00Z");
    say(BIA, "in", "Oi Mohammed, vi sua mensagem. Vamos conversar?");
    expect(enrollment()).toMatchObject({ status: "stopped", stop_reason: "they replied" });
    at("2026-10-04T15:00:00Z");
    await fu.tick();
    expect(sentBodies()).toEqual([]);
  });

  it("steps back when you message the lead yourself from your phone", () => {
    fu.enroll("Cold follow-up", [{ waId: BIA, vars: { first_name: "Bia" } }]);
    at("2026-10-02T15:00:00Z");
    say(BIA, "out", "Oi Bia, passei aí no showroom hoje!");
    expect(enrollment()).toMatchObject({ status: "stopped", stop_reason: "you messaged them yourself" });
  });

  it("honors opt-outs everywhere", async () => {
    fu.enroll("Cold follow-up", [{ waId: BIA, vars: { first_name: "Bia" } }]);
    const s = fu.schedule(BIA, { template: { name: "x", language: "pt_BR" } }, NOW + DAY, false);
    say(BIA, "in", "Parar");
    expect(enrollment()).toMatchObject({ status: "stopped", stop_reason: "opted out" });
    expect(fu.outbox(s.id)!.status).toBe("cancelled");
    expect(store.getContact(BIA)!.opted_out).toBe(1);
    expect(fu.checkEnroll("Cold follow-up", [{ waId: BIA }]).skipped[0].reason).toBe("opted out");
  });

  it("catches a reply that arrived while the server was down", async () => {
    fu.enroll("Cold follow-up", [{ waId: BIA, vars: { first_name: "Bia" } }]);
    at("2026-10-04T15:00:00Z");
    say(BIA, "in", "Oi, desculpa a demora!", NOW + 2 * DAY, { emit: false }); // stored by a backfill, never announced
    await fu.tick();
    expect(sentBodies()).toEqual([]);
    expect(enrollment()).toMatchObject({ status: "stopped", stop_reason: "they replied" });
  });

  it("waits out quiet hours", async () => {
    fu.saveSequence("Late", [{ after_days: 0.4, template: { name: "t", language: "pt_BR" } }]);
    fu.enroll("Late", [{ waId: SARA }]); // due 21:36 local → moved to 08:30
    expect(new Date(enrollment().next_at! * 1000).toISOString()).toBe("2026-10-02T11:30:00.000Z");
  });

  it("stops at the daily cap on paid templates and resumes tomorrow", async () => {
    fu.stop();
    engine({ FOLLOWUP_DAILY_TEMPLATE_CAP: 1 });
    fu.saveSequence("Now", [{ after_days: 0, template: { name: "t", language: "pt_BR" } }]);
    fu.enroll("Now", [{ waId: BIA }, { waId: SARA }]);
    await fu.tick();
    expect(sentBodies()).toHaveLength(1);
    const waiting = fu.enrollments({ status: "active" });
    expect(waiting).toHaveLength(1);
    expect(new Date(waiting[0].next_at! * 1000).toISOString()).toBe("2026-10-02T12:00:00.000Z"); // 09:00 tomorrow
    at("2026-10-02T12:00:00Z");
    await fu.tick();
    expect(sentBodies()).toHaveLength(2);
  });

  it("skips a text-only step it can't send and warns when the sequence is saved", async () => {
    const { warnings } = fu.saveSequence("Text only", [{ after_days: 1, text: "Oi!" }, { after_days: 1, template: { name: "t", language: "pt_BR" } }]);
    expect(warnings[0]).toContain("Step 1 has only free text");
    fu.enroll("Text only", [{ waId: SARA }]);
    at("2026-10-02T15:00:00Z");
    await fu.tick();
    expect(sentBodies()).toEqual([]);
    expect(enrollment()).toMatchObject({ step: 1, status: "active" });
    const ev = store.db.prepare("SELECT kind, detail FROM followup_events").all() as { kind: string; detail: string }[];
    expect(ev).toEqual([{ kind: "skipped", detail: expect.stringContaining("no template to fall back on") }]);
  });

  it("won't enroll someone waiting on your reply, or twice", () => {
    say(LIA, "in", "Oi, quanto custa um vídeo?");
    fu.enroll("Cold follow-up", [{ waId: BIA }]);
    const r = fu.checkEnroll("Cold follow-up", [{ waId: LIA }, { waId: BIA }, { waId: SARA }, { waId: SARA }]);
    expect(r.ok.map((t) => t.waId)).toEqual([SARA]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["they wrote last and are waiting on your reply", "already in this sequence", "listed twice"]);
  });

  it("uses the WhatsApp id the lead actually has (Brazilian ids without the 9)", () => {
    const OLD_ID = "551190001111";
    say(OLD_ID, "out", "Oi!", NOW - DAY);
    fu.enroll("Cold follow-up", [{ waId: "5511990001111" }]);
    expect(enrollment().wa_id).toBe(OLD_ID);
  });

  it("refuses duplicate names unless replacing", () => {
    expect(() => fu.saveSequence("cold follow-up", TWO_STEPS)).toThrow(/exists/);
    expect(fu.saveSequence("Cold follow-up", TWO_STEPS.slice(0, 1), true).warnings).toEqual([]);
  });
});

// ---- the tools, as Claude uses them -----------------------------------------------------

describe("follow-up tools over MCP", () => {
  beforeEach(() => vi.useRealTimers());

  it("drafts, lists and approves", async () => {
    const t = await setup();
    t.store.recordMessage({ id: "in1", waId: BIA, direction: "in", source: "webhook", type: "text", body: "Oi!", timestamp: Math.floor(Date.now() / 1000) - 60, raw: {} });
    const d = await t.call("whatsapp_draft_message", { to: BIA, text: "Oi Bia, segue o portfólio.", note: "reply" });
    expect(d.text).toMatch(/^Draft #1 for \+5511930002222: “Oi Bia, segue o portfólio.”\nIf sent now: Oi Bia, segue o portfólio./);
    expect((await t.call("whatsapp_list_drafts")).text).toContain("#1 DRAFT → +5511930002222");
    expect((await t.call("whatsapp_approve_drafts", { ids: [1] })).text).toMatch(/✓ #1: sent/);
    expect(t.wa.calls).toHaveLength(1);
  });

  it("schedules in local time and rejects unreadable times", async () => {
    const t = await setup();
    const tomorrow = new Date(Date.now() + DAY * 1000).toISOString().slice(0, 10);
    const r = await t.call("whatsapp_schedule_message", { to: SARA, template: { name: "followup_en", language: "en", body_params: ["Sara"] }, send_at: `${tomorrow} 09:30` });
    expect(r.text).toContain(`Scheduled #1 for ${tomorrow} 09:30 (America/Sao_Paulo)`);
    expect((await t.call("whatsapp_schedule_message", { to: SARA, text: "x", send_at: "soon" })).isError).toBe(true);
  });

  it("previews enrolling a whole Trello list, then enrolls on confirm", async () => {
    const tr = fakeTrello([
      card("L_follow", "LUMA — Bia Teste | Brazil | WhatsApp", "CONTACT: Bia Teste\nCOMPANY: LUMA\nWHATSAPP: +55 11 93000-2222", { id: "luma" }),
      card("L_follow", "Horizonte Produções — Sara Demo | Gulf / Arab | WhatsApp", "WHATSAPP: +971 56 000 3333", { id: "sara" }),
      card("L_follow", "No number", "EMAIL: x@example.com", { id: "nonum" }),
      card("L_contacted", "Elsewhere", "WHATSAPP: +55 11 94000 4444", { id: "lia" }),
    ]);
    const t = await setup({}, (d) => new CrmSync({ ...d, trello: new TrelloClient("key", "token", { fetch: tr.fetchFn }), log: silent }));
    await t.call("followup_create_sequence", { name: "Cold follow-up", steps: TWO_STEPS });

    const preview = await t.call("followup_enroll", { sequence: "Cold follow-up", trello_list: "Follow Up" });
    expect(preview.text).toContain('Would enroll 2 lead(s) in "Cold follow-up":');
    expect(preview.text).toContain("- LUMA — Bia Teste | Brazil | WhatsApp (name: Bia Teste, company: LUMA)");
    expect(preview.text).toContain("- No number: no WhatsApp number on the card");
    expect(preview.text).toContain("First step for LUMA — Bia Teste | Brazil | WhatsApp: [template followup_1/pt_BR] Bia");
    expect(t.followups.enrollments()).toEqual([]);

    const done = await t.call("followup_enroll", { sequence: "Cold follow-up", trello_list: "follow up", confirm: true });
    expect(done.text).toMatch(/^Enrolled 2 lead\(s\)/);
    expect((await t.call("followup_status")).text).toMatch(/LUMA|\+5511930002222.*"Cold follow-up" · next: step 1\/2/);
    expect((await t.call("followup_list_sequences")).text).toContain('"Cold follow-up": 2 active, 0 finished, 0 stopped');
    expect((await t.call("followup_stop", { contact: BIA })).text).toBe("Stopped 1 sequence(s) for +5511930002222.");
  });
});

describe("scheduler robustness", () => {
  it("keeps running after a minute with nothing to do", async () => {
    await fu.tick(); // nothing due: finishes immediately
    fu.schedule(BIA, { template: { name: "t", language: "pt_BR" } }, NOW + 60);
    at("2026-10-01T15:02:00Z");
    await fu.tick();
    expect(sentBodies()).toHaveLength(1);
  });
});

describe("daily report", () => {
  it("shows drafts, upcoming steps, opt-outs and failures", async () => {
    const { dailyReport } = await import("../src/crm/report.js");
    fu.saveSequence("Cold follow-up", TWO_STEPS);
    say(BIA, "out", "Oi Bia!", NOW - DAY);
    fu.enroll("Cold follow-up", [{ waId: BIA, vars: { first_name: "Bia" } }]);
    fu.createDraft(SARA, { text: "Hi Sara" });
    fu.schedule(LIA, { template: { name: "t", language: "pt_BR" } }, NOW + HOUR);
    say(SARA, "in", "Not interested, thanks");
    const r = await dailyReport({ config: testConfig(), store, now: () => Date.now() });
    expect(r).toContain("- Drafts waiting for your approval: 1");
    expect(r).toContain("- Scheduled 2026-10-01 13:00 → +55 11 94000-4444 (no card): template t/pt_BR");
    expect(r).toContain("## Waiting on your reply (0)"); // opted out, so not waiting
    expect(r).toContain("🚫 Opted out: +971560003333");
  });
});
