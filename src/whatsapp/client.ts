import type { Config } from "../config.js";
import { toApiError, WhatsAppApiError } from "./errors.js";

/**
 * One place that knows how to reach the WhatsApp Cloud API, either directly at Meta
 * or through a BSP that proxies it (360dialog). Request and response bodies are
 * Meta's format in both cases; only the URLs and auth header differ.
 */
export interface Provider {
  messagesUrl: string;
  mediaUrl: string;
  /** URL that returns a media object's metadata, including its download url. */
  mediaInfoUrl(mediaId: string): string;
  /** Rewrites the download url from media metadata so it goes through the provider when needed. */
  downloadUrl(url: string): string;
  headers: Record<string, string>;
}

export function providerFor(config: Config): Provider {
  if (config.WA_PROVIDER === "meta") {
    const base = (config.WA_BASE_URL ?? "https://graph.facebook.com").replace(/\/$/, "");
    const root = `${base}/${config.WA_GRAPH_VERSION}`;
    return {
      messagesUrl: `${root}/${config.WA_PHONE_NUMBER_ID}/messages`,
      mediaUrl: `${root}/${config.WA_PHONE_NUMBER_ID}/media`,
      mediaInfoUrl: (id) => `${root}/${encodeURIComponent(id)}`,
      downloadUrl: (url) => url,
      headers: { Authorization: `Bearer ${config.WA_API_KEY}` },
    };
  }
  const base = (config.WA_BASE_URL ?? "https://waba-v2.360dialog.io").replace(/\/$/, "");
  return {
    messagesUrl: `${base}/messages`,
    mediaUrl: `${base}/media`,
    mediaInfoUrl: (id) => `${base}/${encodeURIComponent(id)}`,
    // 360dialog returns Meta's lookaside url; it must be fetched through 360dialog's host.
    downloadUrl: (url) => {
      const u = new URL(url);
      const b = new URL(base);
      u.protocol = b.protocol;
      u.host = b.host;
      return u.toString();
    },
    headers: { "D360-API-KEY": config.WA_API_KEY },
  };
}

export interface SendResult {
  messageId: string;
  waId?: string;
}

type FetchLike = typeof fetch;

export interface ClientOptions {
  fetch?: FetchLike;
  maxRetries?: number;
  /** Base backoff in ms; doubled each retry. */
  backoffMs?: number;
}

export class WhatsAppClient {
  private readonly fetch: FetchLike;
  private readonly maxRetries: number;
  private readonly backoffMs: number;

  constructor(
    private readonly provider: Provider,
    opts: ClientOptions = {},
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffMs = opts.backoffMs ?? 500;
  }

  /** Sends any Cloud API message object, e.g. { type: "text", text: { body } }. */
  async sendMessage(to: string, message: Record<string, unknown>): Promise<SendResult> {
    const body = { messaging_product: "whatsapp", recipient_type: "individual", to, ...message };
    const res = await this.request(this.provider.messagesUrl, { method: "POST", json: body });
    const data = (await res.json()) as { messages?: { id: string }[]; contacts?: { wa_id: string }[] };
    const messageId = data.messages?.[0]?.id;
    if (!messageId) throw new WhatsAppApiError(res.status, undefined, "send succeeded but no message id was returned");
    return { messageId, waId: data.contacts?.[0]?.wa_id };
  }

  /** Marks an incoming message as read (blue ticks), optionally showing "typing…". */
  async markRead(messageId: string, showTyping = false): Promise<void> {
    const body: Record<string, unknown> = { messaging_product: "whatsapp", status: "read", message_id: messageId };
    if (showTyping) body.typing_indicator = { type: "text" };
    await this.request(this.provider.messagesUrl, { method: "POST", json: body });
  }

  async getMediaInfo(mediaId: string): Promise<{ url: string; mimeType: string; size?: number }> {
    const res = await this.request(this.provider.mediaInfoUrl(mediaId), { method: "GET" });
    const data = (await res.json()) as { url: string; mime_type: string; file_size?: number };
    return { url: data.url, mimeType: data.mime_type, size: data.file_size };
  }

  async downloadMedia(mediaId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const info = await this.getMediaInfo(mediaId);
    const res = await this.request(this.provider.downloadUrl(info.url), { method: "GET" });
    return { bytes: Buffer.from(await res.arrayBuffer()), mimeType: info.mimeType };
  }

  async uploadMedia(bytes: Buffer, mimeType: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
    const res = await this.request(this.provider.mediaUrl, { method: "POST", form });
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  private async request(
    url: string,
    opts: { method: string; json?: unknown; form?: FormData },
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { ...this.provider.headers };
      let body: BodyInit | undefined;
      if (opts.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.json);
      } else if (opts.form) {
        body = opts.form;
      }
      let res: Response;
      try {
        res = await this.fetch(url, { method: opts.method, headers, body });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await sleep(this.backoffMs * 2 ** attempt);
          continue;
        }
        throw new WhatsAppApiError(0, undefined, `network error: ${(err as Error).message}`);
      }
      if (res.ok) return res;
      const error = await toApiError(res);
      if (error.retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : this.backoffMs * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
