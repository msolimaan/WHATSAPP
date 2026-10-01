// The pipeline rules, as pure functions. No Trello or database access here, so every
// rule is easy to test and the live sync and the preview always agree.

export const STAGES = ["leads", "ready", "contacted", "follow_up", "replied", "meeting", "won", "dead"] as const;
export type Stage = (typeof STAGES)[number];

export const DEFAULT_LIST_NAMES: Record<Stage, string> = {
  leads: "Leads",
  ready: "Ready to Contact",
  contacted: "Contacted",
  follow_up: "Follow Up",
  replied: "Replied",
  meeting: "Meeting",
  won: "Won",
  dead: "Dead",
};

/** Stages a card may still move out of. Replied, Meeting, Won and Dead are yours to manage. */
const NOT_YET_CONTACTED: Stage[] = ["leads", "ready"];
const AWAITING_REPLY: Stage[] = ["leads", "ready", "contacted", "follow_up"];

export interface ChatMessage {
  id: string;
  direction: "in" | "out";
  type: string;
  body: string | null;
  timestamp: number;
}

export interface Decision {
  to: Stage;
  reason: string;
  /** Set a due date (the follow-up day) when moving. */
  setDue?: boolean;
}

// Business-app greeting and away messages, in the languages your leads write in.
// Compared without accents and in lower case.
const AUTO_REPLY_PHRASES = [
  // Portuguese
  "nao estamos disponiveis", "no momento nao estamos", "fora do horario", "horario de atendimento",
  "entraremos em contato", "retornaremos", "responderemos em breve", "em breve retornaremos",
  "obrigado por entrar em contato", "obrigada por entrar em contato", "agradecemos o seu contato",
  "agradecemos seu contato", "agradecemos o contato", "mensagem automatica", "seja bem-vindo", "seja bem vindo",
  // English
  "thank you for contacting", "thanks for contacting", "thank you for reaching out", "thanks for reaching out",
  // Plural "we" phrasing only: a person writing "I'll get back to you" is a real reply.
  "currently unavailable", "out of office", "we will get back to you", "we'll get back to you", "automatic reply",
  "auto-reply", "auto reply", "outside business hours", "outside of business hours", "our business hours",
  // Spanish
  "gracias por contactar", "gracias por comunicarte", "te responderemos", "fuera del horario",
  // Arabic
  "شكرا لتواصلك", "شكراً لتواصلك", "شكرا لتواصلكم", "شكراً لتواصلكم", "سنرد عليك", "سنقوم بالرد", "خارج أوقات العمل", "خارج ساعات العمل",
];

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * True when an inbound message looks like the lead's automatic greeting or away message
 * rather than a person answering. Such messages never count as a reply.
 * `chat` is the conversation in chronological order and must include `msg`.
 */
export function isAutoReply(msg: ChatMessage, chat: ChatMessage[]): boolean {
  if (msg.direction !== "in") return false;
  if (msg.body) {
    const text = fold(msg.body);
    if (AUTO_REPLY_PHRASES.some((p) => text.includes(fold(p)))) return true;
  }
  // The first thing they ever send, within 30 seconds of your message, is almost always automatic.
  const idx = chat.findIndex((m) => m.id === msg.id);
  const before = chat.slice(0, idx);
  const firstInbound = !before.some((m) => m.direction === "in");
  const lastOut = [...before].reverse().find((m) => m.direction === "out");
  return firstInbound && lastOut !== undefined && msg.timestamp - lastOut.timestamp <= 30;
}

/** Messages that show a conversation happening: no reactions, no automatic replies. */
export function meaningful(chat: ChatMessage[]): ChatMessage[] {
  return chat.filter((m) => m.type !== "reaction" && !isAutoReply(m, chat));
}

/** What to do when a new message arrives on a matched card, or null to leave it. */
export function onMessage(stage: Stage, msg: ChatMessage, chat: ChatMessage[]): Decision | null {
  if (msg.type === "reaction") return null;
  if (msg.direction === "out") {
    return NOT_YET_CONTACTED.includes(stage) ? { to: "contacted", reason: "you messaged them on WhatsApp" } : null;
  }
  if (isAutoReply(msg, chat)) return null;
  return AWAITING_REPLY.includes(stage) ? { to: "replied", reason: `they replied: “${snippet(msg.body)}”` } : null;
}

/** A Contacted lead whose last message is yours and is at least `days` old moves to Follow Up. */
export function overdue(stage: Stage, chat: ChatMessage[], nowSec: number, days: number): Decision | null {
  if (stage !== "contacted") return null;
  const last = meaningful(chat).at(-1);
  if (!last || last.direction !== "out") return null;
  const age = (nowSec - last.timestamp) / 86400;
  if (age < days) return null;
  return { to: "follow_up", reason: `no reply ${Math.floor(age)} days after your last message`, setDue: true };
}

/**
 * Where a card should be given the whole conversation (used by the preview, which
 * catches up on history). Forward moves only; returns null when the card is fine.
 */
export function reconcile(stage: Stage, chat: ChatMessage[], nowSec: number, days: number): Decision | null {
  const real = meaningful(chat);
  const last = real.at(-1);
  if (!last) return null;
  if (last.direction === "in") {
    return AWAITING_REPLY.includes(stage) ? { to: "replied", reason: `they wrote last: “${snippet(last.body)}”` } : null;
  }
  // You wrote last.
  if (NOT_YET_CONTACTED.includes(stage) || stage === "contacted") {
    const late = overdue("contacted", chat, nowSec, days);
    if (late) return late;
    if (stage !== "contacted") return { to: "contacted", reason: "you have messaged them on WhatsApp" };
  }
  return null;
}

export function snippet(body: string | null, max = 80): string {
  const s = (body ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
