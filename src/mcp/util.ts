import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { phoneVariants } from "../crm/phones.js";
import { findContacts } from "../store/queries.js";
import type { ContactRow, MessageRow, Store } from "../store/store.js";
import { WhatsAppApiError } from "../whatsapp/errors.js";
import { SendBlockedError } from "../whatsapp/messenger.js";

export class ToolError extends Error {}

export function text(body: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: body }], ...(structured && { structuredContent: structured }) };
}

export function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Wraps a tool handler so expected failures come back as readable tool errors, not crashes. */
export function safe<A>(fn: (args: A) => Promise<CallToolResult> | CallToolResult) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof ToolError || err instanceof SendBlockedError || err instanceof WhatsAppApiError) {
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }
      throw err;
    }
  };
}

export function formatTime(sec: number | null | undefined, timeZone: string): string {
  if (!sec) return "never";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(sec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export function contactName(c: Pick<ContactRow, "saved_name" | "profile_name"> | undefined): string | null {
  return c?.saved_name ?? c?.profile_name ?? null;
}

export function label(waId: string, name: string | null | undefined): string {
  return name ? `${name} (+${waId})` : `+${waId}`;
}

/**
 * Accepts a phone number in any format ("+55 11 99000-1111", "5511990001111") or part of a
 * name, and returns the WhatsApp id. Names must match exactly one known contact.
 */
export function resolveContact(store: Store, input: string): string {
  const trimmed = input.trim();
  if (/^\+?[\d\s().-]+$/.test(trimmed)) {
    const d = trimmed.replace(/\D/g, "");
    if (d.length < 8 || d.length > 15) throw new ToolError(`"${input}" isn't a full phone number. Include the country code, e.g. +55 11 99000-1111.`);
    // Use the id WhatsApp already knows this line by (older Brazilian ids lack the mobile 9),
    // so the chat isn't split and the 24h window is read correctly.
    const known = phoneVariants(d)
      .map((id) => store.getContact(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .sort((a, b) => (b.last_inbound_at ?? 0) - (a.last_inbound_at ?? 0) || (b.last_outbound_at ?? 0) - (a.last_outbound_at ?? 0));
    return known[0]?.wa_id ?? d;
  }
  const matches = findContacts(store.db, trimmed, 6);
  if (matches.length === 1) return matches[0].wa_id;
  if (matches.length === 0) {
    throw new ToolError(`No contact matches "${input}". Use their phone number with country code, or whatsapp_find_contacts.`);
  }
  const list = matches.map((c) => `- ${label(c.wa_id, contactName(c))}`).join("\n");
  throw new ToolError(`"${input}" matches several contacts. Use the phone number of the one you mean:\n${list}`);
}

export function formatMessage(m: MessageRow, timeZone: string, name?: string | null): string {
  const who = m.direction === "out" ? "You" : (name ?? `+${m.wa_id}`);
  const status = m.direction === "out" && m.status ? ` [${m.status}${m.error ? `: ${m.error}` : ""}]` : "";
  const via = m.source === "api" ? " (sent via Claude)" : "";
  return `${formatTime(m.timestamp, timeZone)} ${who}: ${m.body ?? `[${m.type}]`}${status}${via}  ‹${m.id}›`;
}
