import { EventEmitter } from "node:events";
import type { NewMessage } from "../store/store.js";

// What the rest of the system reacts to. Trello sync and follow-ups subscribe here
// (stages 3 and 4), so the webhook never needs to know about them.
export interface Events {
  /** A message stored for the first time. History backfill is flagged so live rules can skip it. */
  message: [message: NewMessage, meta: { profileName?: string; backfill: boolean }];
  status: [update: { id: string; status: string; waId: string; error?: string }];
  contact: [contact: { waId: string; savedName: string | null; removed: boolean }];
}

export class EventBus extends EventEmitter<Events> {}
