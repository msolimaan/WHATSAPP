import express, { type Express } from "express";
import { setupAuth } from "./auth/router.js";
import type { Config } from "./config.js";
import type { CrmSync } from "./crm/sync.js";
import type { FollowupEngine } from "./followups/engine.js";
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
  followups: FollowupEngine;
  crm?: CrmSync;
}

export function createApp(deps: AppDeps): Express {
  const { config, store, bus } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    next();
  });

  // Public, so it says nothing about your messages: just that the server and database are up.
  app.get("/health", (_req, res) => {
    store.db.prepare("SELECT 1").get();
    res.json({ ok: true });
  });

  const auth = setupAuth(config, store.db);
  if (auth.router) app.use(auth.router);
  app.use("/webhook", webhookRouter(config, store, bus));
  app.use("/mcp", mcpRouter(deps, auth.guard));
  return app;
}
