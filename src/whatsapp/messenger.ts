import type { EventBus } from "../events/bus.js";
import { windowStatus } from "../store/queries.js";
import type { NewMessage, Store } from "../store/store.js";
import { describe, type WaMessage } from "../webhook/parse.js";
import type { SendResult, WhatsAppClient } from "./client.js";
import { hintFor } from "./errors.js";

export class SendBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendBlockedError";
  }
}

export interface OutgoingMessage {
  /** Cloud API message type: text, image, video, audio, document, sticker, location, interactive, template, reaction. */
  type: string;
  [key: string]: unknown;
}

/**
 * The only way the system sends WhatsApp messages (tools now, follow-ups later), so the
 * same checks apply everywhere and every message we send lands in the store.
 */
export class Messenger {
  constructor(
    private readonly client: WhatsAppClient,
    private readonly store: Store,
    private readonly bus: EventBus,
  ) {}

  async send(waId: string, message: OutgoingMessage, opts: { replyTo?: string } = {}): Promise<SendResult> {
    const contact = this.store.getContact(waId);
    const isTemplate = message.type === "template";
    const isReaction = message.type === "reaction";

    if (contact?.opted_out && isTemplate) {
      throw new SendBlockedError(
        `${waId} has opted out of your messages. Don't send them templates; reply only if they write to you first.`,
      );
    }
    if (!isTemplate && !isReaction) {
      const w = windowStatus(contact);
      if (!w.open) {
        const when = w.lastInboundAt
          ? `Their last message was ${new Date(w.lastInboundAt * 1000).toISOString()}.`
          : "They have never messaged this number.";
        throw new SendBlockedError(`${hintFor(131047)} ${when}`);
      }
    }

    const payload: Record<string, unknown> = { ...message };
    if (opts.replyTo) payload.context = { message_id: opts.replyTo };
    const result = await this.client.sendMessage(waId, payload);

    const stored: NewMessage = {
      id: result.messageId,
      waId: result.waId ?? waId,
      direction: "out",
      source: "api",
      type: message.type,
      body: bodyFor(message),
      mediaId: mediaIdOf(message),
      replyTo: (message.reaction as { message_id?: string } | undefined)?.message_id ?? opts.replyTo ?? null,
      status: "sent",
      timestamp: Math.floor(Date.now() / 1000),
      raw: payload,
    };
    if (this.store.recordMessage(stored)) this.bus.emit("message", stored, { backfill: false });
    return result;
  }
}

function bodyFor(m: OutgoingMessage): string | null {
  if (m.type === "template") {
    const t = m.template as { name: string; components?: { type: string; parameters?: { text?: string }[] }[] };
    const params = (t.components ?? [])
      .flatMap((c) => c.parameters ?? [])
      .map((p) => p.text)
      .filter(Boolean);
    return `[template: ${t.name}]${params.length ? ` ${params.join(" | ")}` : ""}`;
  }
  if (m.type === "interactive") {
    const i = m.interactive as { body?: { text?: string } };
    return i.body?.text ?? "[interactive]";
  }
  return describe({ id: "", from: "", timestamp: "0", ...m } as WaMessage);
}

function mediaIdOf(m: OutgoingMessage): string | null {
  const media = m[m.type] as { id?: string } | undefined;
  return media && typeof media === "object" && "id" in media ? (media.id ?? null) : null;
}
