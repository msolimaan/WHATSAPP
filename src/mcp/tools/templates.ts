import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Template, TemplateComponent } from "../../whatsapp/client.js";
import type { ToolContext } from "../context.js";
import { safe, text, ToolError } from "../util.js";

const varCount = (s: string | undefined) => new Set((s ?? "").match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;

function summarize(t: Template): string {
  const body = t.components.find((c) => c.type.toUpperCase() === "BODY");
  const header = t.components.find((c) => c.type.toUpperCase() === "HEADER");
  const buttons = t.components.find((c) => c.type.toUpperCase() === "BUTTONS")?.buttons ?? [];
  const lines = [
    `### ${t.name} · ${t.language} · ${t.category} · ${t.status}${t.rejected_reason && t.rejected_reason !== "NONE" ? ` (rejected: ${t.rejected_reason})` : ""}`,
  ];
  if (header) {
    lines.push(`Header (${header.format ?? "TEXT"}): ${header.text ?? ""}${varCount(header.text) ? ` — ${varCount(header.text)} variable` : ""}`.trim());
  }
  lines.push(`Body (${varCount(body?.text)} variables): ${body?.text ?? ""}`);
  if (buttons.length) lines.push(`Buttons: ${buttons.map((b) => `${b.text}${b.url ? ` → ${b.url}` : ""}`).join(" | ")}`);
  return lines.join("\n");
}

export function registerTemplateTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "whatsapp_list_templates",
    {
      title: "List WhatsApp message templates",
      description: "Lists your templates with language, category, approval status, text and number of variables. Only APPROVED templates can be sent.",
      inputSchema: {
        status: z.enum(["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED", "any"]).default("any"),
        name: z.string().optional().describe("Only templates whose name contains this"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ status, name }) => {
      const all = await ctx.client.listTemplates();
      const rows = all.filter(
        (t) => (status === "any" || t.status === status) && (!name || t.name.includes(name.toLowerCase())),
      );
      if (rows.length === 0) return text("No templates match.");
      return text(rows.map(summarize).join("\n\n"));
    }),
  );

  server.registerTool(
    "whatsapp_create_template",
    {
      title: "Create a WhatsApp template",
      description:
        "Submits a new template to Meta for review (usually minutes, sometimes up to 24h). Use MARKETING for outreach and follow-ups to leads, UTILITY only for transactional updates about something the person already agreed to. Variables are {{1}}, {{2}}… and each needs an example value.",
      inputSchema: {
        name: z.string().regex(/^[a-z0-9_]{1,512}$/, "lowercase letters, digits and underscores only").describe("e.g. lead_followup_pt"),
        category: z.enum(["MARKETING", "UTILITY"]),
        language: z.string().min(2).describe("e.g. pt_BR, en, en_US, ar"),
        body: z.string().min(1).max(1024).describe("Text with {{1}}, {{2}}… placeholders"),
        body_examples: z.array(z.string()).default([]).describe("One example value per body variable, in order"),
        header_text: z.string().max(60).optional(),
        footer: z.string().max(60).optional(),
        quick_replies: z.array(z.string().max(25)).max(10).default([]),
        url_button: z.object({ text: z.string().max(25), url: z.url() }).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async (a) => {
      const n = varCount(a.body);
      if (n !== a.body_examples.length) {
        throw new ToolError(`The body has ${n} variable(s) but ${a.body_examples.length} example value(s). Give one example per variable.`);
      }
      if (/^\s*\{\{|\}\}\s*$/.test(a.body)) {
        throw new ToolError("Meta rejects templates that start or end with a variable. Add text before the first and after the last.");
      }
      const components: TemplateComponent[] = [];
      if (a.header_text) components.push({ type: "HEADER", format: "TEXT", text: a.header_text });
      components.push({ type: "BODY", text: a.body, ...(n && { example: { body_text: [a.body_examples] } }) });
      if (a.footer) components.push({ type: "FOOTER", text: a.footer });
      const buttons = [
        ...a.quick_replies.map((t) => ({ type: "QUICK_REPLY", text: t })),
        ...(a.url_button ? [{ type: "URL", text: a.url_button.text, url: a.url_button.url }] : []),
      ];
      if (buttons.length) components.push({ type: "BUTTONS", buttons });
      const r = await ctx.client.createTemplate({ name: a.name, category: a.category, language: a.language, components });
      return text(`Submitted "${a.name}" (${a.language}) for review. Status: ${r.status}. Check later with whatsapp_list_templates.`);
    }),
  );

  server.registerTool(
    "whatsapp_delete_template",
    {
      title: "Delete a WhatsApp template",
      description: "Deletes a template in every language. The name can't be reused for 30 days.",
      inputSchema: { name: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ name }) => {
      await ctx.client.deleteTemplate(name);
      return text(`Deleted template "${name}".`);
    }),
  );
}
