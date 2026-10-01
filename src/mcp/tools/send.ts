import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { resolveContact, safe, text, ToolError } from "../util.js";

const sends = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const to = z.string().min(1).describe("Recipient: phone number with country code, or part of a known contact's name");
const replyTo = z.string().optional().describe("Message id ‹wamid…› to quote/reply to");

const MAX_INLINE_BYTES = 10 * 1024 * 1024;

export function registerSendTools(server: McpServer, ctx: ToolContext): void {
  const sent = (waId: string, id: string, what: string) =>
    text(`Sent ${what} to +${waId}. Message id: ${id}`, { messageId: id, waId });

  server.registerTool(
    "whatsapp_send_text",
    {
      title: "Send a WhatsApp text",
      description:
        "Sends a free-text message. Only works within 24 hours of the contact's last message to you; otherwise use whatsapp_send_template. The message also appears in your phone's WhatsApp.",
      inputSchema: {
        to,
        body: z.string().min(1).max(4096),
        reply_to: replyTo,
        preview_url: z.boolean().default(true).describe("Show a preview for the first link in the text"),
      },
      annotations: sends,
    },
    safe(async ({ to: dest, body, reply_to, preview_url }) => {
      const waId = resolveContact(ctx.store, dest);
      const r = await ctx.messenger.send(waId, { type: "text", text: { body, preview_url } }, { replyTo: reply_to });
      return sent(waId, r.messageId, "text");
    }),
  );

  server.registerTool(
    "whatsapp_send_media",
    {
      title: "Send a WhatsApp image, video, audio or document",
      description:
        "Sends media from a public https URL (preferred; e.g. a portfolio PDF or reel link) or from base64 data. Window rules are the same as text. Documents show their filename; images, videos and documents can carry a caption.",
      inputSchema: {
        to,
        kind: z.enum(["image", "video", "audio", "document", "sticker"]),
        url: z.url().optional().describe("Public https URL WhatsApp can download"),
        base64: z.string().optional().describe("File contents as base64 (max 10 MB), instead of url"),
        mime_type: z.string().optional().describe("Required with base64, e.g. application/pdf"),
        filename: z.string().optional().describe("Shown to the recipient for documents, e.g. Inhouse-Portfolio.pdf"),
        caption: z.string().max(1024).optional(),
        reply_to: replyTo,
      },
      annotations: sends,
    },
    safe(async ({ to: dest, kind, url, base64, mime_type, filename, caption, reply_to }) => {
      if (!url === !base64) throw new ToolError("Give exactly one of url or base64.");
      if (caption && (kind === "audio" || kind === "sticker")) throw new ToolError(`A ${kind} can't have a caption.`);
      const waId = resolveContact(ctx.store, dest);
      const media: Record<string, unknown> = {};
      if (url) {
        if (!url.startsWith("https://")) throw new ToolError("The url must start with https://");
        media.link = url;
      } else {
        if (!mime_type) throw new ToolError("mime_type is required with base64.");
        const bytes = Buffer.from(base64!, "base64");
        if (bytes.length === 0) throw new ToolError("base64 decoded to an empty file.");
        if (bytes.length > MAX_INLINE_BYTES) throw new ToolError("File is over 10 MB. Host it and pass url instead.");
        media.id = await ctx.client.uploadMedia(bytes, mime_type, filename ?? `file.${mime_type.split("/")[1] ?? "bin"}`);
      }
      if (caption) media.caption = caption;
      if (kind === "document" && filename) media.filename = filename;
      const r = await ctx.messenger.send(waId, { type: kind, [kind]: media }, { replyTo: reply_to });
      return sent(waId, r.messageId, kind);
    }),
  );

  server.registerTool(
    "whatsapp_send_template",
    {
      title: "Send an approved WhatsApp template",
      description:
        "Sends a Meta-approved template. This is the only way to message someone whose 24-hour window is closed, including new leads. Meta bills each template by category and country. Use whatsapp_list_templates to see names, languages and how many {{n}} variables each has.",
      inputSchema: {
        to,
        name: z.string().min(1),
        language: z.string().min(2).describe("Template language code exactly as approved, e.g. pt_BR, en, en_US, ar"),
        body_params: z.array(z.string()).default([]).describe("Values for {{1}}, {{2}}… in the body, in order"),
        header: z
          .object({
            type: z.enum(["text", "image", "video", "document"]),
            value: z.string().describe("Text for {{1}} in a text header, or a public https URL for media headers"),
            filename: z.string().optional(),
          })
          .optional()
          .describe("Only if the template's header has a variable or media"),
        button_params: z
          .array(z.object({ index: z.number().int().min(0), url_suffix: z.string() }))
          .default([])
          .describe("For URL buttons with a variable: the value appended to the button's URL"),
      },
      annotations: sends,
    },
    safe(async ({ to: dest, name, language, body_params, header, button_params }) => {
      const waId = resolveContact(ctx.store, dest);
      const components: Record<string, unknown>[] = [];
      if (header) {
        const param =
          header.type === "text"
            ? { type: "text", text: header.value }
            : { type: header.type, [header.type]: { link: header.value, ...(header.filename && { filename: header.filename }) } };
        components.push({ type: "header", parameters: [param] });
      }
      if (body_params.length) components.push({ type: "body", parameters: body_params.map((t) => ({ type: "text", text: t })) });
      for (const b of button_params) {
        components.push({ type: "button", sub_type: "url", index: String(b.index), parameters: [{ type: "text", text: b.url_suffix }] });
      }
      const r = await ctx.messenger.send(waId, {
        type: "template",
        template: { name, language: { code: language }, ...(components.length && { components }) },
      });
      return sent(waId, r.messageId, `template "${name}"`);
    }),
  );

  server.registerTool(
    "whatsapp_send_buttons",
    {
      title: "Send a message with reply buttons",
      description: "Sends text with up to 3 quick-reply buttons (e.g. 'Book a call', 'Send examples', 'Not now'). Window rules apply. Their tap arrives as a normal reply.",
      inputSchema: {
        to,
        body: z.string().min(1).max(1024),
        buttons: z.array(z.string().min(1).max(20)).min(1).max(3),
        header: z.string().max(60).optional(),
        footer: z.string().max(60).optional(),
      },
      annotations: sends,
    },
    safe(async ({ to: dest, body, buttons, header, footer }) => {
      const waId = resolveContact(ctx.store, dest);
      const r = await ctx.messenger.send(waId, {
        type: "interactive",
        interactive: {
          type: "button",
          ...(header && { header: { type: "text", text: header } }),
          body: { text: body },
          ...(footer && { footer: { text: footer } }),
          action: { buttons: buttons.map((title, i) => ({ type: "reply", reply: { id: `btn_${i + 1}`, title } })) },
        },
      });
      return sent(waId, r.messageId, "buttons");
    }),
  );

  server.registerTool(
    "whatsapp_send_location",
    {
      title: "Send a location",
      description: "Sends a map pin, e.g. the studio address for a meeting. Window rules apply.",
      inputSchema: {
        to,
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().optional(),
        address: z.string().optional(),
      },
      annotations: sends,
    },
    safe(async ({ to: dest, latitude, longitude, name, address }) => {
      const waId = resolveContact(ctx.store, dest);
      const r = await ctx.messenger.send(waId, { type: "location", location: { latitude, longitude, name, address } });
      return sent(waId, r.messageId, "location");
    }),
  );

  server.registerTool(
    "whatsapp_react",
    {
      title: "React to a message",
      description: "Adds an emoji reaction to a message (pass an empty emoji to remove it). Works outside the 24-hour window only if Meta allows; usually used right after they write.",
      inputSchema: {
        message_id: z.string().describe("Message id ‹wamid…›"),
        emoji: z.string().max(8).describe('One emoji, e.g. "👍", or "" to remove'),
      },
      annotations: sends,
    },
    safe(async ({ message_id, emoji }) => {
      const m = ctx.store.getMessage(message_id);
      if (!m) throw new ToolError(`Message ${message_id} not found. Copy the id from whatsapp_get_messages.`);
      const r = await ctx.messenger.send(m.wa_id, { type: "reaction", reaction: { message_id, emoji } });
      return sent(m.wa_id, r.messageId, emoji ? `reaction ${emoji}` : "reaction removal");
    }),
  );

  server.registerTool(
    "whatsapp_mark_read",
    {
      title: "Mark a message as read",
      description: "Shows blue ticks to the sender for this message and everything before it. Optionally shows 'typing…' for up to 25 seconds while you prepare a reply.",
      inputSchema: { message_id: z.string(), show_typing: z.boolean().default(false) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ message_id, show_typing }) => {
      const m = ctx.store.getMessage(message_id);
      if (m && m.direction !== "in") throw new ToolError("That's a message you sent. Pick one of theirs.");
      await ctx.client.markRead(message_id, show_typing);
      return text(`Marked ${message_id} as read${show_typing ? " and showed typing" : ""}.`);
    }),
  );

  server.registerTool(
    "whatsapp_download_media",
    {
      title: "Open a received photo, video, voice note or document",
      description: "Fetches the media attached to a message so you can see it. Images and audio come back inline; other files as an embedded resource. WhatsApp keeps media for about 30 days.",
      inputSchema: { message_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ message_id }): Promise<CallToolResult> => {
      const m = ctx.store.getMessage(message_id);
      if (!m) throw new ToolError(`Message ${message_id} not found.`);
      if (!m.media_id) throw new ToolError(`Message ${message_id} has no media (type: ${m.type}).`);
      const { bytes, mimeType } = await ctx.client.downloadMedia(m.media_id);
      if (bytes.length > MAX_INLINE_BYTES) {
        return text(`The ${m.type} is ${(bytes.length / 1048576).toFixed(1)} MB, too large to show here.`);
      }
      const data = bytes.toString("base64");
      const caption = { type: "text" as const, text: `${m.body ?? m.type} (${mimeType}, ${Math.ceil(bytes.length / 1024)} KB)` };
      if (mimeType.startsWith("image/")) return { content: [caption, { type: "image", data, mimeType }] };
      if (mimeType.startsWith("audio/")) return { content: [caption, { type: "audio", data, mimeType }] };
      return {
        content: [caption, { type: "resource", resource: { uri: `whatsapp://media/${m.media_id}`, mimeType, blob: data } }],
      };
    }),
  );
}
