// Turns Cloud API error codes into messages that tell Claude (or you) what to do next.
// Codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes

const HINTS: Record<number, string> = {
  131047:
    "More than 24 hours have passed since this person last messaged you, so free text can't be sent. Send an approved template instead (whatsapp_send_template).",
  131026:
    "The message couldn't be delivered. The number may not be on WhatsApp, may be on an old app version, or may have blocked you.",
  131049:
    "Meta held back this marketing message to protect engagement for this user. Try again later or reach them another way.",
  131050: "This person has stopped marketing messages from your business. Don't send them more marketing templates.",
  131056: "Too many messages to this person in a short time. Wait a little before sending again.",
  131051: "This message type isn't supported.",
  131052: "The media couldn't be downloaded from the sender.",
  131053: "The media couldn't be uploaded. Check the file type and size.",
  132000: "The number of template variables doesn't match the template. Check the template's placeholders.",
  132001: "The template doesn't exist in that language, or isn't approved yet. List templates to check the name and language.",
  132005: "The filled-in template text is too long.",
  132007: "The template content breaks a WhatsApp policy.",
  132012: "Template variable values are in the wrong format.",
  132015: "The template is paused because of low quality. Edit it or use another template.",
  132016: "The template is disabled because of low quality. Create a new template.",
  130429: "Throughput limit reached. Slow down and retry shortly.",
  131048: "Spam rate limit hit: too many people blocked or reported recent messages. Pause sending and check quality in WhatsApp Manager.",
  368: "The number is temporarily restricted for policy violations. Check WhatsApp Manager.",
  190: "The access token is invalid or expired. Generate a new one and update WA_API_KEY.",
  100: "A parameter in the request is invalid.",
};

export class WhatsAppApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    readonly detail: string,
    readonly fbtraceId?: string,
  ) {
    const hint = code !== undefined ? HINTS[code] : undefined;
    super(hint ? `${hint} (WhatsApp error ${code}: ${detail})` : `WhatsApp API error ${code ?? status}: ${detail}`);
    this.name = "WhatsAppApiError";
  }

  /** 429s, 5xx and throughput errors are worth retrying; everything else needs a change first. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.code === 130429 || this.code === 131056;
  }
}

export function hintFor(code: number): string | undefined {
  return HINTS[code];
}

export async function toApiError(res: Response): Promise<WhatsAppApiError> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; code?: number; error_data?: { details?: string }; fbtrace_id?: string };
    };
    const e = body.error;
    if (e) {
      const detail = e.error_data?.details || e.message || text;
      return new WhatsAppApiError(res.status, e.code, detail, e.fbtrace_id);
    }
  } catch {
    // Not JSON; fall through.
  }
  return new WhatsAppApiError(res.status, undefined, text.slice(0, 500) || res.statusText);
}
