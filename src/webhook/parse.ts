import { phoneKey } from "../crm/phones.js";
import type { NewMessage } from "../store/store.js";

// Shapes of the Cloud API webhook payloads we use. Everything else is kept in `raw`.
// Fields: messages, smb_message_echoes (sent from the Business app under Coexistence),
// history (Coexistence backfill) and smb_app_state_sync (address-book contacts).

export interface WaMessage {
  id: string;
  from: string;
  to?: string;
  timestamp: string;
  type: string;
  context?: { id?: string; from?: string };
  text?: { body: string };
  image?: Media;
  video?: Media;
  audio?: Media;
  sticker?: Media;
  document?: Media & { filename?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
  reaction?: { message_id: string; emoji?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
    nfm_reply?: { name?: string; body?: string; response_json?: string };
  };
  referral?: { source_url?: string; headline?: string; body?: string; source_type?: string };
  system?: { body?: string };
  errors?: { code: number; title?: string; message?: string }[];
}

interface Media {
  id: string;
  mime_type?: string;
  caption?: string;
}

interface WaStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: { code: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

interface ChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
  statuses?: WaStatus[];
  message_echoes?: WaMessage[];
  history?: {
    metadata?: { phase?: number; chunk_order?: number; progress?: number };
    threads?: { id: string; messages?: (WaMessage & { history_context?: { status?: string } })[] }[];
    errors?: { code: number; title?: string; message?: string }[];
  }[];
  state_sync?: {
    type: string;
    action?: string;
    contact?: { full_name?: string; first_name?: string; phone_number?: string };
    metadata?: { timestamp?: string };
  }[];
}

export interface WebhookPayload {
  object?: string;
  entry?: { id?: string; changes?: { field: string; value: ChangeValue }[] }[];
}

export type ParsedItem =
  | { kind: "message"; message: NewMessage; profileName?: string }
  | { kind: "status"; id: string; status: string; waId: string; error?: string }
  | { kind: "contact"; waId: string; savedName: string | null; removed: boolean }
  | { kind: "history_progress"; phase?: number; chunk?: number; progress?: number }
  | { kind: "notice"; field: string; text: string };

export const digits = (s: string | undefined | null): string => (s ?? "").replace(/\D/g, "");

/** Flattens a webhook delivery into items the store understands. Unknown fields become notices. */
export function parseWebhook(payload: WebhookPayload, businessNumber?: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const ours = digits(v.metadata?.display_phone_number) || businessNumber || "";
      switch (change.field) {
        case "messages":
          parseMessagesField(v, items);
          break;
        case "smb_message_echoes":
          for (const m of v.message_echoes ?? []) {
            items.push({ kind: "message", message: toMessage(m, "out", "echo", digits(m.to)) });
          }
          break;
        case "history":
          parseHistory(v, ours, items);
          break;
        case "smb_app_state_sync":
          for (const s of v.state_sync ?? []) {
            if (s.type !== "contact" || !s.contact?.phone_number) continue;
            items.push({
              kind: "contact",
              waId: digits(s.contact.phone_number),
              savedName: s.contact.full_name || s.contact.first_name || null,
              removed: s.action === "remove",
            });
          }
          break;
        default:
          items.push({ kind: "notice", field: change.field, text: `unhandled webhook field "${change.field}"` });
      }
    }
  }
  return items;
}

function parseMessagesField(v: ChangeValue, items: ParsedItem[]): void {
  const names = new Map((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
  for (const m of v.messages ?? []) {
    const waId = digits(m.from);
    items.push({ kind: "message", message: toMessage(m, "in", "webhook", waId), profileName: names.get(m.from) });
  }
  for (const s of v.statuses ?? []) {
    const e = s.errors?.[0];
    items.push({
      kind: "status",
      id: s.id,
      status: s.status,
      waId: digits(s.recipient_id),
      error: e ? `${e.code}: ${e.error_data?.details || e.message || e.title || ""}`.trim() : undefined,
    });
  }
}

function parseHistory(v: ChangeValue, ours: string, items: ParsedItem[]): void {
  for (const h of v.history ?? []) {
    if (h.errors?.length) {
      const e = h.errors[0];
      items.push({ kind: "notice", field: "history", text: `history sync error ${e.code}: ${e.message ?? e.title ?? ""}` });
    }
    if (h.metadata) {
      items.push({ kind: "history_progress", phase: h.metadata.phase, chunk: h.metadata.chunk_order, progress: h.metadata.progress });
    }
    for (const thread of h.threads ?? []) {
      const waId = digits(thread.id);
      for (const m of thread.messages ?? []) {
        const outbound = ours !== "" && phoneKey(m.from) === phoneKey(ours);
        const msg = toMessage(m, outbound ? "out" : "in", "history", waId);
        if (outbound && m.history_context?.status) msg.status = m.history_context.status.toLowerCase();
        items.push({ kind: "message", message: msg });
      }
    }
  }
}

function toMessage(m: WaMessage, direction: "in" | "out", source: NewMessage["source"], waId: string): NewMessage {
  const media = m.image ?? m.video ?? m.audio ?? m.sticker ?? m.document;
  return {
    id: m.id,
    waId,
    direction,
    source,
    type: m.type,
    body: describe(m),
    mediaId: media?.id ?? null,
    mediaMime: media?.mime_type ?? null,
    replyTo: m.reaction?.message_id ?? m.context?.id ?? null,
    status: direction === "out" ? "sent" : null,
    timestamp: Number(m.timestamp) || Math.floor(Date.now() / 1000),
    raw: m,
  };
}

/** A readable one-line body for every message type, so search and reports work on all of them. */
export function describe(m: WaMessage): string | null {
  switch (m.type) {
    case "text":
      return m.text?.body ?? null;
    case "image":
    case "video":
    case "audio":
    case "sticker":
    case "document": {
      const media = (m as unknown as Record<string, (Media & { filename?: string }) | undefined>)[m.type];
      const label = m.type === "document" && media?.filename ? `[document: ${media.filename}]` : `[${m.type}]`;
      return media?.caption ? `${label} ${media.caption}` : label;
    }
    case "location": {
      const l = m.location;
      if (!l) return "[location]";
      const place = [l.name, l.address].filter(Boolean).join(", ");
      return `[location${place ? `: ${place}` : ""}] ${l.latitude},${l.longitude}`;
    }
    case "contacts":
      return `[contact: ${(m.contacts ?? []).map((c) => c.name?.formatted_name ?? c.phones?.[0]?.phone ?? "?").join(", ")}]`;
    case "reaction":
      return m.reaction?.emoji ? `[reaction ${m.reaction.emoji}]` : "[reaction removed]";
    case "button":
      return m.button?.text ?? "[button]";
    case "interactive": {
      const i = m.interactive;
      return i?.button_reply?.title ?? i?.list_reply?.title ?? i?.nfm_reply?.body ?? `[interactive ${i?.type ?? ""}]`.trim();
    }
    case "system":
      return `[system] ${m.system?.body ?? ""}`.trim();
    case "unsupported":
      return `[unsupported message${m.errors?.[0]?.title ? `: ${m.errors[0].title}` : ""}]`;
    default:
      return `[${m.type}]`;
  }
}
