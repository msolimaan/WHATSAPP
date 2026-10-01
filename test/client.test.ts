import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { providerFor, WhatsAppClient } from "../src/whatsapp/client.js";
import { WhatsAppApiError } from "../src/whatsapp/errors.js";

const cfg = (over: Partial<Config>) =>
  ({ WA_PROVIDER: "360dialog", WA_API_KEY: "KEY", WA_GRAPH_VERSION: "v23.0", ...over }) as Config;

function fakeFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("providers", () => {
  it("routes 360dialog requests with its API key header", () => {
    const p = providerFor(cfg({}));
    expect(p.messagesUrl).toBe("https://waba-v2.360dialog.io/messages");
    expect(p.headers).toEqual({ "D360-API-KEY": "KEY" });
    expect(p.downloadUrl("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1")).toBe(
      "https://waba-v2.360dialog.io/whatsapp_business/attachments/?mid=1",
    );
  });

  it("routes Meta requests to the phone number with a bearer token", () => {
    const p = providerFor(cfg({ WA_PROVIDER: "meta", WA_PHONE_NUMBER_ID: "123" }));
    expect(p.messagesUrl).toBe("https://graph.facebook.com/v23.0/123/messages");
    expect(p.headers).toEqual({ Authorization: "Bearer KEY" });
  });
});

describe("WhatsAppClient", () => {
  it("sends a message in Meta's format and returns its id", async () => {
    const { fn, calls } = fakeFetch([json(200, { contacts: [{ wa_id: "5511990001111" }], messages: [{ id: "wamid.X" }] })]);
    const client = new WhatsAppClient(providerFor(cfg({})), { fetch: fn });
    const r = await client.sendMessage("5511990001111", { type: "text", text: { body: "Oi" } });
    expect(r).toEqual({ messageId: "wamid.X", waId: "5511990001111" });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "5511990001111", type: "text", text: { body: "Oi" },
    });
  });

  it("retries rate limits and server errors, then succeeds", async () => {
    const { fn, calls } = fakeFetch([
      json(429, { error: { code: 130429, message: "rate" } }),
      json(503, { error: { message: "down" } }),
      json(200, { messages: [{ id: "wamid.Y" }] }),
    ]);
    const client = new WhatsAppClient(providerFor(cfg({})), { fetch: fn, backoffMs: 1 });
    expect((await client.sendMessage("1", { type: "text", text: { body: "x" } })).messageId).toBe("wamid.Y");
    expect(calls).toHaveLength(3);
  });

  it("does not retry a closed 24-hour window, and explains what to do", async () => {
    const { fn, calls } = fakeFetch([
      json(400, { error: { code: 131047, message: "Re-engagement message", error_data: { details: "more than 24 hours" } } }),
    ]);
    const client = new WhatsAppClient(providerFor(cfg({})), { fetch: fn, backoffMs: 1 });
    const err = await client.sendMessage("1", { type: "text", text: { body: "x" } }).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppApiError);
    expect(err.code).toBe(131047);
    expect(err.message).toMatch(/approved template/);
    expect(calls).toHaveLength(1);
  });

  it("downloads media through the provider", async () => {
    const { fn, calls } = fakeFetch([
      json(200, { url: "https://lookaside.fbsbx.com/path?x=1", mime_type: "image/jpeg" }),
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    ]);
    const client = new WhatsAppClient(providerFor(cfg({})), { fetch: fn });
    const r = await client.downloadMedia("MEDIA1");
    expect(r.mimeType).toBe("image/jpeg");
    expect([...r.bytes]).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.url)).toEqual(["https://waba-v2.360dialog.io/MEDIA1", "https://waba-v2.360dialog.io/path?x=1"]);
  });
});
