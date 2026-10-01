// Finding WhatsApp numbers in Trello cards and comparing them with WhatsApp ids.

/**
 * A comparison key for a phone number. WhatsApp ids and the numbers people publish
 * don't always agree, so both sides are reduced to the same key:
 * - Brazil: mobiles gained a leading 9 in 2012–2016, but many older WhatsApp accounts
 *   still have ids without it. "+55 11 99000-1111" and "551190001111" are the same line.
 * - Mexico: ids used to carry a "1" after the country code (521…); numbers no longer do.
 */
export function phoneKey(input: string): string {
  let d = input.replace(/\D/g, "");
  if (d.startsWith("55") && d.length === 13 && d[4] === "9") d = d.slice(0, 4) + d.slice(5);
  if (d.startsWith("521") && d.length === 13) d = "52" + d.slice(3);
  return d;
}

/**
 * The forms a WhatsApp id for this number can take: Brazilian mobiles with and without the
 * extra 9, Mexican numbers with and without the old "1". The input comes first.
 */
export function phoneVariants(input: string): string[] {
  const d = input.replace(/\D/g, "");
  const out = [d];
  if (d.startsWith("55") && d.length === 13 && d[4] === "9") out.push(d.slice(0, 4) + d.slice(5));
  if (d.startsWith("55") && d.length === 12 && /[6-9]/.test(d[4])) out.push(`${d.slice(0, 4)}9${d.slice(4)}`);
  if (d.startsWith("521") && d.length === 13) out.push(`52${d.slice(3)}`);
  if (d.startsWith("52") && d.length === 12) out.push(`521${d.slice(2)}`);
  return out;
}

// "+55 11 94000 4444", "+971 56 000 3333", "+55 (11) 99000-5555"
const INTERNATIONAL = /\+\s?\d[\d\s().-]{6,20}\d/g;
// wa.me/5511990005555 (also inside ready-to-send links with ?text=…)
const WA_ME = /wa\.me\/(\d{8,15})/gi;
// Only lines that are about how to reach the person.
const CONTACT_LINE = /whats\s?app|\bwpp\b|\bzap\b|\bphone\b|\btel(efone)?\b|\bcelular\b|\bmobile\b|\bcontato\b/i;

/**
 * Every WhatsApp-capable number written on a card, as digits with country code.
 * Numbers without a "+" country code are ignored on purpose: "11 99000-1111" could be
 * anywhere, and a wrong match would move the wrong lead.
 */
export function extractPhones(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(WA_ME)) found.add(m[1]);
  for (const line of text.split(/\r?\n/)) {
    if (!CONTACT_LINE.test(line)) continue;
    // Don't read numbers inside URLs (the wa.me pass already covered those).
    const clean = line.replace(/https?:\/\/\S+/g, " ");
    for (const m of clean.matchAll(INTERNATIONAL)) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 15) found.add(digits);
    }
  }
  return [...found];
}

/** Formats digits for people: "+55 11 99000-1111" for Brazil, "+<digits>" elsewhere. */
export function displayPhone(digits: string): string {
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    return `+55 ${ddd} ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
  }
  return `+${digits}`;
}

const ARAB = ["20", "212", "213", "216", "961", "962", "964", "965", "966", "968", "971", "973", "974"];

/** The market label your board uses for a number's country. */
export function marketFor(digits: string): "Brazil" | "Gulf / Arab" | "International (EN)" {
  if (digits.startsWith("55")) return "Brazil";
  if (ARAB.some((cc) => digits.startsWith(cc))) return "Gulf / Arab";
  return "International (EN)";
}
