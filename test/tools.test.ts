import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { processWebhook } from "../src/webhook/process.js";
import * as f from "./fixtures.js";
import { setup } from "./helpers.js";

// Freeze "now" relative to the fixtures: the inbound message (1759140000) is 1 hour old.
const NOW = 1759140000 + 3600;
const withNow = async <T>(fn: () => Promise<T>) => {
  const real = Date.now;
  Date.now = () => NOW * 1000;
  try { return await fn(); } finally { Date.now = real; }
};

async function seeded() {
  const t = await setup();
  for (const p of [f.echo, f.inboundText, f.inboundImage, f.contactSync]) processWebhook(t.store, t.bus, p);
  return t;
}

describe("MCP tools", () => {
  it("lists every tool with annotations", async () => {
    const t = await setup();
    const { tools } = await t.mcp.listTools();
    expect(tools.map((x) => x.name).filter((n) => n.startsWith("whatsapp_")).sort()).toEqual([
      "whatsapp_approve_drafts", "whatsapp_cancel_pending", "whatsapp_create_template", "whatsapp_delete_template",
      "whatsapp_download_media", "whatsapp_draft_message", "whatsapp_find_contacts", "whatsapp_get_contact",
      "whatsapp_get_messages", "whatsapp_list_conversations", "whatsapp_list_drafts", "whatsapp_list_templates",
      "whatsapp_mark_read", "whatsapp_react", "whatsapp_schedule_message", "whatsapp_search_messages",
      "whatsapp_send_buttons", "whatsapp_send_location", "whatsapp_send_media", "whatsapp_send_template",
      "whatsapp_send_text",
    ]);
    expect(tools.find((x) => x.name === "whatsapp_get_messages")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((x) => x.name === "whatsapp_delete_template")!.annotations?.destructiveHint).toBe(true);
  });

  it("lists conversations and filters who is waiting on whom", async () => {
    const t = await seeded();
    const all = await t.call("whatsapp_list_conversations");
    expect(all.text).toContain("Sara (+971560003333)");
    expect(all.text).toContain("Estúdio Barro Azul (+5511990001111)");
    const mine = await t.call("whatsapp_list_conversations", { filter: "awaiting_their_reply" });
    expect(mine.text).toContain("No conversations match.");
    const theirs = await t.call("whatsapp_list_conversations", { filter: "awaiting_my_reply", query: "marina" });
    expect(theirs.text).toContain("Interessante");
    expect(theirs.text).not.toContain("Sara");
  });

  it("reads a chat in order, with window state, by name or any number format", async () => {
    const t = await seeded();
    const r = await withNow(() => t.call("whatsapp_get_messages", { contact: "+55 11 99000-1111" }));
    const lines = r.text.split("\n");
    expect(lines[1]).toMatch(/window OPEN/);
    const msgs = lines.filter((l) => l.includes("‹wamid"));
    expect(msgs[0]).toContain("You: Olá Marina");
    expect(msgs[1]).toContain("Estúdio Barro Azul: Interessante");
    const byName = await t.call("whatsapp_get_messages", { contact: "Azul" });
    expect(byName.text).toContain("Olá Marina");
  });

  it("explains ambiguous and unknown contacts", async () => {
    const t = await seeded();
    t.store.upsertContact({ waId: "5511900000001", profileName: "Marina Lopes" });
    expect((await t.call("whatsapp_get_messages", { contact: "Marina" })).text).toMatch(/matches several contacts/);
    expect((await t.call("whatsapp_get_messages", { contact: "Nobody" })).isError).toBe(true);
    expect((await t.call("whatsapp_get_messages", { contact: "123" })).text).toMatch(/full phone number/);
  });

  it("searches across chats", async () => {
    const t = await seeded();
    const r = await t.call("whatsapp_search_messages", { query: "showre" });
    expect(r.text).toContain("our showreel");
    expect(r.text).toContain("wamid.IMG1");
  });

  it("sends text inside the window, records it and announces it", async () => {
    const t = await seeded();
    const seen: string[] = [];
    t.bus.on("message", (m, meta) => seen.push(`${m.direction}:${m.source}:${meta.backfill}`));
    const r = await withNow(() => t.call("whatsapp_send_text", { to: "Marina Teste", body: "Aqui está um exemplo!", reply_to: "wamid.IN1" }));
    expect(r.isError).toBe(false);
    expect(t.wa.calls[0]).toMatchObject({
      method: "POST",
      url: "https://waba-v2.360dialog.io/messages",
      body: { to: "5511990001111", type: "text", text: { body: "Aqui está um exemplo!" }, context: { message_id: "wamid.IN1" } },
    });
    expect(t.store.getMessage("wamid.SENT1")).toMatchObject({ direction: "out", source: "api", body: "Aqui está um exemplo!" });
    expect(seen).toEqual(["out:api:false"]);
  });

  it("refuses free text when the window is closed, without calling WhatsApp", async () => {
    const t = await seeded();
    const r = await withNow(async () => {
      Date.now = () => (NOW + 2 * 86400) * 1000;
      return t.call("whatsapp_send_text", { to: "5511990001111", body: "hello?" });
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/approved template/);
    expect(t.wa.calls).toHaveLength(0);
  });

  it("sends a template with variables, header and URL button to a brand-new number", async () => {
    const t = await setup();
    const r = await t.call("whatsapp_send_template", {
      to: "+971 56 000 3333", name: "lead_followup", language: "en",
      body_params: ["Sara", "Horizonte Produções"],
      header: { type: "document", value: "https://example.com/inhouse.pdf", filename: "Inhouse.pdf" },
      button_params: [{ index: 0, url_suffix: "sara" }],
    });
    expect(r.isError).toBe(false);
    expect(t.wa.calls[0].body).toMatchObject({
      to: "971560003333",
      type: "template",
      template: {
        name: "lead_followup", language: { code: "en" },
        components: [
          { type: "header", parameters: [{ type: "document", document: { link: "https://example.com/inhouse.pdf", filename: "Inhouse.pdf" } }] },
          { type: "body", parameters: [{ type: "text", text: "Sara" }, { type: "text", text: "Horizonte Produções" }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "sara" }] },
        ],
      },
    });
    expect(t.store.getMessage("wamid.SENT1")!.body).toBe("[template: lead_followup] Sara | Horizonte Produções | sara");
  });

  it("blocks templates to contacts who opted out", async () => {
    const t = await seeded();
    t.store.db.prepare("UPDATE contacts SET opted_out = 1 WHERE wa_id = ?").run("5511990001111");
    const r = await t.call("whatsapp_send_template", { to: "5511990001111", name: "x", language: "pt_BR" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/opted out/);
  });

  it("sends media by link and by upload", async () => {
    const t = await seeded();
    t.wa.on("/media", () => Response.json({ id: "UPLOADED1" }));
    await withNow(async () => {
      await t.call("whatsapp_send_media", { to: "5511990001111", kind: "document", url: "https://example.com/p.pdf", filename: "Inhouse.pdf", caption: "Portfólio" });
      await t.call("whatsapp_send_media", { to: "5511990001111", kind: "image", base64: Buffer.from("png").toString("base64"), mime_type: "image/png" });
    });
    expect(t.wa.calls[0].body).toMatchObject({ type: "document", document: { link: "https://example.com/p.pdf", filename: "Inhouse.pdf", caption: "Portfólio" } });
    expect(t.wa.calls[1].url).toBe("https://waba-v2.360dialog.io/media");
    expect(t.wa.calls[2].body).toMatchObject({ type: "image", image: { id: "UPLOADED1" } });
  });

  it("reacts to a message and marks it read", async () => {
    const t = await seeded();
    await t.call("whatsapp_react", { message_id: "wamid.IN1", emoji: "👍" });
    expect(t.wa.calls[0].body).toMatchObject({ to: "5511990001111", type: "reaction", reaction: { message_id: "wamid.IN1", emoji: "👍" } });
    await t.call("whatsapp_mark_read", { message_id: "wamid.IN1", show_typing: true });
    expect(t.wa.calls[1].body).toEqual({ messaging_product: "whatsapp", status: "read", message_id: "wamid.IN1", typing_indicator: { type: "text" } });
  });

  it("returns received images inline", async () => {
    const t = await seeded();
    t.wa.on("/MEDIA1", () => Response.json({ url: "https://lookaside.fbsbx.com/img?x=1", mime_type: "image/jpeg" }));
    t.wa.on("/img?x=1", () => new Response(new Uint8Array([255, 216, 255])));
    const r = await t.call("whatsapp_download_media", { message_id: "wamid.IMG1" });
    const img = ((r as { content: unknown }).content as { type: string; data?: string; mimeType?: string }[]).find((c) => c.type === "image")!;
    expect(img).toMatchObject({ mimeType: "image/jpeg", data: Buffer.from([255, 216, 255]).toString("base64") });
  });

  it("lists and creates templates", async () => {
    const t = await setup();
    t.wa.on("/v1/configs/templates", () =>
      Response.json({ waba_templates: [
        { name: "lead_followup", language: "en", status: "APPROVED", category: "MARKETING",
          components: [{ type: "BODY", text: "Hi {{1}}, following up on {{2}}." }] },
        { name: "old_one", language: "pt_BR", status: "REJECTED", category: "MARKETING", rejected_reason: "INVALID_FORMAT",
          components: [{ type: "BODY", text: "x" }] },
      ] }),
    );
    const list = await t.call("whatsapp_list_templates", { status: "APPROVED" });
    expect(list.text).toContain("lead_followup · en · MARKETING · APPROVED");
    expect(list.text).toContain("Body (2 variables)");
    expect(list.text).not.toContain("old_one");

    const bad = await t.call("whatsapp_create_template", { name: "followup_pt", category: "MARKETING", language: "pt_BR", body: "Oi {{1}}, tudo bem?" });
    expect(bad.text).toMatch(/1 variable\(s\) but 0 example/);

    t.wa.on("/v1/configs/templates", () => Response.json({ id: "T1", status: "PENDING" }));
    const ok = await t.call("whatsapp_create_template", {
      name: "followup_pt", category: "MARKETING", language: "pt_BR", body: "Oi {{1}}, tudo bem?", body_examples: ["Marina"],
      quick_replies: ["Sim", "Agora não"],
    });
    expect(ok.text).toContain("Status: PENDING");
    expect(t.wa.calls.at(-1)!.body).toMatchObject({
      name: "followup_pt", category: "MARKETING", language: "pt_BR",
      components: [
        { type: "BODY", text: "Oi {{1}}, tudo bem?", example: { body_text: [["Marina"]] } },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Sim" }, { type: "QUICK_REPLY", text: "Agora não" }] },
      ],
    });
  });
});

describe("/mcp endpoint", () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const token = "t".repeat(40);

  it("requires the bearer token, then speaks MCP", async () => {
    const t = await setup({ MCP_BEARER_TOKEN: token });
    const app = createApp(t);
    await request(app).post("/mcp").send(init).expect(401);
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send(init)
      .expect(200);
    expect(res.body.result.serverInfo.name).toBe("whatsapp-mcp");
  });

  it("is off until a token is configured", async () => {
    const t = await setup();
    await request(createApp(t)).post("/mcp").send(init).expect(503);
  });
});
