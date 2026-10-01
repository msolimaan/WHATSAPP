import type { Config } from "../config.js";
import type { CrmSync } from "../crm/sync.js";
import type { EventBus } from "../events/bus.js";
import type { Store } from "../store/store.js";
import type { WhatsAppClient } from "../whatsapp/client.js";
import type { Messenger } from "../whatsapp/messenger.js";

export interface ToolContext {
  config: Config;
  store: Store;
  bus: EventBus;
  client: WhatsAppClient;
  messenger: Messenger;
  /** Present when Trello is configured. */
  crm?: CrmSync;
}
