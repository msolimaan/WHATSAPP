// {{placeholders}} in follow-up messages, filled per lead.

export interface LeadVars {
  name?: string;
  first_name?: string;
  company?: string;
  [key: string]: string | undefined;
}

/** Replaces {{name}}, {{first_name}}, {{company}} (and any other key given). Unknown placeholders are left as is. */
export function fill(text: string, vars: LeadVars): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, key: string) => vars[key.toLowerCase()] ?? m);
}

/** Placeholders a text still needs after filling, so a message never goes out with "{{company}}" in it. */
export function missingVars(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase()))];
}

/**
 * Reads lead details from a card in your board's format:
 *   name "LUMA — Bia Teste | Brazil | WhatsApp", lines "CONTACT: Bia Teste", "COMPANY: LUMA".
 */
export function varsFromCard(card: { name: string; desc: string }, fallbackName?: string | null): LeadVars {
  const line = (label: string) => card.desc.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im"))?.[1]?.trim();
  const [head] = card.name.split("|");
  const [nameCompany, nameContact] = head.split(/\s+[—–-]\s+/).map((s) => s?.trim());
  // "CONTACT: Davi Exemplo — Director / Production Manager, Lente Filmes" → "Davi Exemplo"
  const contact = (line("CONTACT") ?? nameContact ?? fallbackName ?? undefined)?.split(/\s+[—–-]\s+|,/)[0].trim();
  const company = line("COMPANY") ?? (nameContact ? nameCompany : undefined);
  const vars: LeadVars = {};
  if (contact) {
    vars.name = contact;
    vars.first_name = contact.replace(/^(dr|dra|chef)\.?\s+/i, "").split(/\s+/)[0];
  }
  if (company) vars.company = company;
  return vars;
}
