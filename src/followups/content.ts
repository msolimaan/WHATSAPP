import type { OutgoingMessage } from "../whatsapp/messenger.js";
import { fill, type LeadVars, missingVars } from "./vars.js";

/**
 * What a follow-up says. Free text can only go out within 24 hours of the lead's last message;
 * a template works any time. Give both and the right one is picked when it's sent.
 */
export interface Content {
  text?: string;
  template?: { name: string; language: string; body_params?: string[] };
}

export type Built = { ok: true; message: OutgoingMessage; preview: string; paid: boolean } | { ok: false; reason: string };

/** Turns content into the message to send right now, given whether the 24h window is open. */
export function build(content: Content, windowOpen: boolean, vars: LeadVars = {}): Built {
  if (windowOpen && content.text) {
    const body = fill(content.text, vars);
    const missing = missingVars(body);
    if (missing.length) return { ok: false, reason: `the text still needs ${missing.map((m) => `{{${m}}}`).join(", ")}` };
    return { ok: true, message: { type: "text", text: { body, preview_url: true } }, preview: body, paid: false };
  }
  if (content.template) {
    const params = (content.template.body_params ?? []).map((p) => fill(p, vars));
    const missing = params.flatMap(missingVars);
    if (missing.length) return { ok: false, reason: `the template values still need ${missing.map((m) => `{{${m}}}`).join(", ")}` };
    return {
      ok: true,
      message: {
        type: "template",
        template: {
          name: content.template.name,
          language: { code: content.template.language },
          ...(params.length && { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] }),
        },
      },
      preview: `[template ${content.template.name}/${content.template.language}]${params.length ? ` ${params.join(" | ")}` : ""}`,
      paid: true,
    };
  }
  return {
    ok: false,
    reason: content.text
      ? "their 24-hour window is closed and there's no template to fall back on"
      : "nothing to send (no text or template)",
  };
}

/** A one-line description for lists, before it's known which variant will be used. */
export function describeContent(c: Content): string {
  const parts: string[] = [];
  if (c.text) parts.push(`“${c.text.length > 120 ? `${c.text.slice(0, 119)}…` : c.text}”`);
  if (c.template) {
    const p = c.template.body_params?.length ? ` (${c.template.body_params.join(" | ")})` : "";
    parts.push(`${c.text ? "else " : ""}template ${c.template.name}/${c.template.language}${p}`);
  }
  return parts.join(" · ");
}
