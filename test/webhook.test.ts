import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { EventBus } from "../src/events/bus.js";
import { openDb } from "../src/store/db.js";
import { Store } from "../src/store/store.js";
import { processWebhook } from "../src/webhook/process.js";
import { sign } from "../src/webhook/signature.js";
import * as f from "./fixtures.js";

let store: Store;
let bus: EventBus;
beforeEach(() => {
  store = new Store(openDb(":memory:"));
  bus = new EventBus();
});

describe("processWebhook", () => {
  it("stores an inbound text with the sender's profile name and quoted message", () => {
    const seen: string[] = [];
    bus.on("message", (m) => seen.push(m.id));
    const r = processWebhook(store, bus, f.inboundText);
    expect(r.messages).toBe(1);
    expect(seen).toEqual(["wamid.IN1"]);
    const msg = store.getMessage("wamid.IN1")!;
    expect(msg).toMatchObject({ wa_id: "5511990001111", direction: "in", source: "webhook", body: "Interessante. Pode enviar sim.", reply_to: "wamid.OUT1" });
    const c = store.getContact("5511990001111")!;
    expect(c.profile_name).toBe("Marina Teste");
    expect(c.last_inbound_at).toBe(1759140000);
  });

  it("ignores redelivered webhooks", () => {
    processWebhook(store, bus, f.inboundText);
    let emitted = 0;
    bus.on("message", () => emitted++);
    const r = processWebhook(store, bus, f.inboundText);
    expect(r).toMatchObject({ messages: 0, duplicates: 1 });
    expect(emitted).toBe(0);
  });

  it("stores media with a readable body", () => {
    processWebhook(store, bus, f.inboundImage);
    expect(store.getMessage("wamid.IMG1")).toMatchObject({ type: "image", body: "[image] our showreel", media_id: "MEDIA1", media_mime: "image/jpeg" });
  });

  it("records messages typed on the phone (Coexistence echoes) as outbound", () => {
    processWebhook(store, bus, f.echo);
    expect(store.getMessage("wamid.OUT1")).toMatchObject({ wa_id: "5511990001111", direction: "out", source: "echo", status: "sent" });
    expect(store.getContact("5511990001111")!.last_outbound_at).toBe(1759050000);
  });

  it("moves delivery status forward only, and keeps failures", () => {
    processWebhook(store, bus, f.echo);
    processWebhook(store, bus, f.statuses("read"));
    processWebhook(store, bus, f.statuses("delivered"));
    expect(store.getMessage("wamid.OUT1")!.status).toBe("read");
    processWebhook(store, bus, f.statuses("failed"));
    expect(store.getMessage("wamid.OUT1")).toMatchObject({ status: "failed", error: "131026: Message undeliverable" });
  });

  it("ignores statuses for unknown messages", () => {
    expect(processWebhook(store, bus, f.statuses("read", "wamid.UNKNOWN")).statuses).toBe(0);
  });

  it("backfills history in both directions and flags it as backfill", () => {
    const flags: boolean[] = [];
    bus.on("message", (_m, meta) => flags.push(meta.backfill));
    processWebhook(store, bus, f.history);
    expect(store.getMessage("wamid.H1")).toMatchObject({ direction: "out", source: "history", status: "read" });
    expect(store.getMessage("wamid.H2")).toMatchObject({ direction: "in", source: "history" });
    expect(flags).toEqual([true, true]);
    expect(JSON.parse(store.getKv("history_progress")!).progress).toBe(100);
  });

  it("saves address-book names from contact sync", () => {
    processWebhook(store, bus, f.contactSync);
    expect(store.getContact("5511990001111")!.saved_name).toBe("Estúdio Barro Azul");
  });

  it("lists a chat newest first and finds messages by full-text search", () => {
    processWebhook(store, bus, f.echo);
    processWebhook(store, bus, f.inboundText);
    expect(store.getMessages("5511990001111").map((m) => m.id)).toEqual(["wamid.IN1", "wamid.OUT1"]);
    const hits = store.db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("interessante");
    expect(hits).toHaveLength(1);
  });
});

describe("webhook HTTP endpoint", () => {
  const base = {
    PORT: 0, DATA_DIR: "", WA_PROVIDER: "360dialog", WA_API_KEY: "k", WA_GRAPH_VERSION: "v23.0",
    WEBHOOK_VERIFY_TOKEN: "verify-me",
  } as Config;

  it("answers Meta's subscription check only with the right token", async () => {
    const app = createApp({ config: { ...base, WA_APP_SECRET: "s" }, store, bus });
    await request(app).get("/webhook").query({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "42" }).expect(200, "42");
    await request(app).get("/webhook").query({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "42" }).expect(403);
  });

  it("accepts only correctly signed deliveries when an app secret is set", async () => {
    const app = createApp({ config: { ...base, WA_APP_SECRET: "app-secret" }, store, bus });
    const body = JSON.stringify(f.inboundText);
    await request(app).post("/webhook").set("Content-Type", "application/json").send(body).expect(401);
    await request(app).post("/webhook").set("Content-Type", "application/json").set("X-Hub-Signature-256", sign(body, "wrong")).send(body).expect(401);
    await request(app).post("/webhook").set("Content-Type", "application/json").set("X-Hub-Signature-256", sign(body, "app-secret")).send(body).expect(200);
    expect(store.getMessage("wamid.IN1")).toBeDefined();
  });

  it("requires the URL secret when one is set", async () => {
    const secret = "x".repeat(32);
    const app = createApp({ config: { ...base, WEBHOOK_PATH_SECRET: secret }, store, bus });
    await request(app).post("/webhook").send(f.inboundText).expect(404);
    await request(app).post("/webhook/wrong").send(f.inboundText).expect(404);
    await request(app).post(`/webhook/${secret}`).send(f.inboundText).expect(200);
    expect(store.getMessage("wamid.IN1")).toBeDefined();
  });

  it("still answers 200 for a payload it can't process, and keeps it for replay", async () => {
    const secret = "y".repeat(32);
    const app = createApp({ config: { ...base, WEBHOOK_PATH_SECRET: secret }, store, bus });
    bus.on("message", () => { throw new Error("listener bug"); });
    await request(app).post(`/webhook/${secret}`).send(f.inboundText).expect(200);
    const row = store.db.prepare("SELECT error FROM webhook_events").get() as { error: string };
    expect(row.error).toContain("listener bug");
  });

  it("reports health", async () => {
    processWebhook(store, bus, f.inboundText);
    const app = createApp({ config: { ...base, WA_APP_SECRET: "s" }, store, bus });
    const res = await request(app).get("/health").expect(200);
    expect(res.body).toMatchObject({ ok: true, messages: 1 });
  });
});
