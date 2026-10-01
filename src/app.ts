import express, { type Express } from "express";
import type { Config } from "./config.js";
import type { EventBus } from "./events/bus.js";
import { mcpRouter } from "./mcp/server.js";
import type { Store } from "./store/store.js";
import type { WhatsAppClient } from "./whatsapp/client.js";
import type { Messenger } from "./whatsapp/messenger.js";
import { webhookRouter } from "./webhook/router.js";

export interface AppDeps {
  config: Config;
  store: Store;
  bus: EventBus;
  client: WhatsAppClient;
  messenger: Messenger;
}

export function createApp(deps: AppDeps): Express {
  const { config, store, bus } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.get("/health", (_req, res) => {
    const row = store.db.prepare("SELECT COUNT(*) AS n, MAX(timestamp) AS last FROM messages").get() as {
      n: number;
      last: number | null;
    };
    res.json({
      ok: true,
      messages: row.n,
      lastMessageAt: row.last ? new Date(row.last * 1000).toISOString() : null,
    });
  });

  app.use("/webhook", webhookRouter(config, store, bus));
  app.use("/mcp", mcpRouter(deps));
  return app;
}
