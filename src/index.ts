import { join } from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EventBus } from "./events/bus.js";
import { openDb } from "./store/db.js";
import { Store } from "./store/store.js";

const config = loadConfig();
const store = new Store(openDb(join(config.DATA_DIR, "whatsapp.db")));
const bus = new EventBus();

const server = createApp({ config, store, bus }).listen(config.PORT, () => {
  console.log(`whatsapp-mcp listening on :${config.PORT} (provider: ${config.WA_PROVIDER})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.db.close();
      process.exit(0);
    });
  });
}
