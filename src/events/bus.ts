import { EventEmitter } from "node:events";
import type { NewMessage } from "../store/store.js";

// What the rest of the system reacts to. Trello sync and follow-ups subscribe here,
// so the webhook never needs to know about them.
export interface Events {
  /** A message stored for the first time. History backfill is flagged so live rules can skip it. */
  message: [message: NewMessage, meta: { profileName?: string; backfill: boolean }];
  status: [update: { id: string; status: string; waId: string; error?: string }];
  contact: [contact: { waId: string; savedName: string | null; removed: boolean }];
}

/**
 * An event emitter where one failing listener can't hurt anything else: the other
 * listeners still run, and the caller (storing a webhook, or a send that already
 * reached WhatsApp) never sees the error. Failures are reported to `onError`.
 */
export class EventBus extends EventEmitter<Events> {
  constructor(private readonly onError: (err: unknown, event: string) => void = (err, event) => console.error(`events: a "${event}" listener failed`, err)) {
    super();
  }

  override emit(...call: Parameters<EventEmitter<Events>["emit"]>): boolean {
    const [event, ...args] = call as [keyof Events, ...unknown[]];
    const listeners = this.listeners(event) as ((...a: unknown[]) => void)[];
    for (const listener of listeners) {
      try {
        listener(...args);
      } catch (err) {
        this.onError(err, String(event));
      }
    }
    return listeners.length > 0;
  }
}
