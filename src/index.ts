import { join } from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { CrmSync } from "./crm/sync.js";
import { FollowupEngine } from "./followups/engine.js";
import { EventBus } from "./events/bus.js";
import { openDb } from "./store/db.js";
import { Store } from "./store/store.js";
import { TrelloClient } from "./trello/client.js";
import { providerFor, WhatsAppClient } from "./whatsapp/client.js";
import { Messenger } from "./whatsapp/messenger.js";

const config = loadConfig();
const store = new Store(openDb(join(config.DATA_DIR, "whatsapp.db")));
const bus = new EventBus();
const client = new WhatsAppClient(providerFor(config));
const messenger = new Messenger(client, store, bus);
const followups = new FollowupEngine({ config, store, bus, messenger });
followups.start();
// Raw webhook payloads are only kept long enough to replay a parsing fix.
setInterval(() => store.pruneWebhookEvents(30), 24 * 3600 * 1000).unref();

let crm: CrmSync | undefined;
if (config.TRELLO_API_KEY && config.TRELLO_TOKEN) {
  crm = new CrmSync({ config, store, bus, trello: new TrelloClient(config.TRELLO_API_KEY, config.TRELLO_TOKEN) });
  crm.start();
  // Read the board once at startup so a wrong key or renamed list shows up in the logs right away.
  crm.getBoard(0).then(
    (b) => console.log(`crm: board loaded, ${b.cards.size} cards; sync mode ${crm!.mode}`),
    (err) => console.error(`crm: couldn't read the Trello board: ${(err as Error).message}`),
  );
} else {
  console.log("crm: Trello not configured; CRM sync is off");
}

const server = createApp({ config, store, bus, client, messenger, followups, crm }).listen(config.PORT, () => {
  console.log(`whatsapp-mcp listening on :${config.PORT} (provider: ${config.WA_PROVIDER})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    crm?.stop();
    followups.stop();
    // Don't let open keep-alive connections hold up a redeploy.
    setTimeout(() => process.exit(0), 10_000).unref();
    server.close(() => {
      store.db.close();
      process.exit(0);
    });
  });
}
