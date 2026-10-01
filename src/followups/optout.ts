// Recognizing "stop messaging me" in the languages your leads write in.
// WhatsApp policy requires honoring opt-outs; after one, no more templates go to that person.

const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

// A message that is exactly one of these words.
const WORDS = ["stop", "parar", "pare", "sair", "cancelar", "descadastrar", "unsubscribe", "remover", "baja", "توقف", "ايقاف", "إيقاف", "الغاء", "إلغاء"];

// Phrases that count anywhere in a short message.
const PHRASES = [
  "nao tenho interesse", "nao temos interesse", "sem interesse", "nao quero receber", "pare de me mandar",
  "pare de enviar", "me tire da lista", "remove me", "remove us", "not interested", "stop messaging",
  "stop sending", "unsubscribe me", "no estoy interesado", "no me interesa",
  "غير مهتم", "لا أرغب", "لا ارغب", "توقف عن",
].map(fold);

/** True when an incoming message asks you to stop. Only short messages count, to avoid false alarms. */
export function isOptOut(body: string | null): boolean {
  if (!body) return false;
  const text = fold(body);
  if (!text || text.length > 80) return false;
  if (WORDS.map(fold).includes(text)) return true;
  return PHRASES.some((p) => text.includes(p));
}
