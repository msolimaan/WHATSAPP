import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.js";
import { EventBus } from "../src/events/bus.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { openDb } from "../src/store/db.js";
import { Store } from "../src/store/store.js";
import { providerFor, WhatsAppClient } from "../src/whatsapp/client.js";
import { Messenger } from "../src/whatsapp/messenger.js";
import type { CrmSync } from "../src/crm/sync.js";
import { FollowupEngine } from "../src/followups/engine.js";

export const testConfig = (over: Partial<Config> = {}) =>
  ({
    PORT: 0, DATA_DIR: "", TIMEZONE: "America/Sao_Paulo", WA_PROVIDER: "360dialog", WA_API_KEY: "KEY",
    WA_GRAPH_VERSION: "v23.0", WEBHOOK_VERIFY_TOKEN: "verify-me", TRELLO_BOARD_ID: "B1",
    CRM_FOLLOW_UP_DAYS: 3, CRM_NEW_LEAD_LOOKBACK_DAYS: 30, CRM_CHANNEL_LABEL: "WP",
    FOLLOWUP_QUIET_HOURS: "20:00-08:30", FOLLOWUP_SKIP_WEEKENDS: false, FOLLOWUP_DAILY_TEMPLATE_CAP: 30, ...over,
  }) as Config;

export interface FakeCall { method: string; url: string; body: unknown }

/** A stand-in for the WhatsApp API. Queue responses per URL fragment; records every call. */
export function fakeWhatsApp() {
  const calls: FakeCall[] = [];
  const routes: [string, () => Response][] = [];
  let counter = 0;
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method: init.method ?? "GET", url, body });
    const route = routes.find(([frag]) => url.includes(frag));
    if (route) return route[1]();
    if (url.endsWith("/messages")) {
      return Response.json({ contacts: [{ wa_id: (body as { to: string }).to }], messages: [{ id: `wamid.SENT${++counter}` }] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn, on: (frag: string, res: () => Response) => routes.unshift([frag, res]) };
}

export async function setup(over: Partial<Config> = {}, withCrm?: (deps: { config: Config; store: Store; bus: EventBus }) => CrmSync) {
  const config = testConfig(over);
  const store = new Store(openDb(":memory:"));
  const bus = new EventBus();
  const wa = fakeWhatsApp();
  const client = new WhatsAppClient(providerFor(config), { fetch: wa.fetchFn, backoffMs: 1 });
  const messenger = new Messenger(client, store, bus);
  const crm = withCrm?.({ config, store, bus });
  const followups = new FollowupEngine({ config, store, bus, messenger, log: { info() {}, warn() {}, error() {} } });
  const ctx = { config, store, bus, client, messenger, followups, crm };
  const server = buildMcpServer(ctx);
  const mcp = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const content = r.content as { type: string; text?: string }[];
    return { ...r, text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
  };
  return { ...ctx, wa, mcp, call };
}
