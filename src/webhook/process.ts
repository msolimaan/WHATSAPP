import type { EventBus } from "../events/bus.js";
import type { Store } from "../store/store.js";
import { parseWebhook, type WebhookPayload } from "./parse.js";

export interface ProcessResult {
  messages: number;
  duplicates: number;
  statuses: number;
  contacts: number;
  notices: string[];
}

/** Saves one webhook delivery and announces anything new. Safe to call twice with the same payload. */
export function processWebhook(
  store: Store,
  bus: EventBus,
  payload: WebhookPayload,
  businessNumber?: string,
): ProcessResult {
  const field = payload.entry?.[0]?.changes?.[0]?.field ?? null;
  const eventId = store.logWebhook(field, payload);
  const result: ProcessResult = { messages: 0, duplicates: 0, statuses: 0, contacts: 0, notices: [] };
  try {
    for (const item of parseWebhook(payload, businessNumber)) {
      switch (item.kind) {
        case "message": {
          const inserted = store.recordMessage(item.message);
          if (item.profileName) store.upsertContact({ waId: item.message.waId, profileName: item.profileName });
          if (!inserted) {
            result.duplicates++;
            break;
          }
          result.messages++;
          bus.emit("message", item.message, {
            profileName: item.profileName,
            backfill: item.message.source === "history",
          });
          break;
        }
        case "status":
          if (store.updateStatus(item.id, item.status, item.error)) {
            result.statuses++;
            bus.emit("status", { id: item.id, status: item.status, waId: item.waId, error: item.error });
          }
          break;
        case "contact":
          store.setSavedName(item.waId, item.removed ? null : item.savedName);
          result.contacts++;
          bus.emit("contact", item);
          break;
        case "history_progress":
          store.setKv("history_progress", JSON.stringify({ ...item, at: new Date().toISOString() }));
          break;
        case "notice":
          result.notices.push(item.text);
          break;
      }
    }
  } catch (err) {
    store.setWebhookError(eventId, (err as Error).stack ?? String(err));
    throw err;
  }
  return result;
}
