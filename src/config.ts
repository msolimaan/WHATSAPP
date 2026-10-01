import { z } from "zod";

// Every setting comes from the environment so secrets never live in the repo.
// See .env.example for descriptions.
const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_BASE_URL: z.url().optional(),
    DATA_DIR: z.string().default("./data"),
    // Your time zone, used for dates Claude shows you and (later) quiet hours.
    TIMEZONE: z.string().default("America/Sao_Paulo"),
    // Temporary MCP access until OAuth lands: clients send "Authorization: Bearer <token>".
    MCP_BEARER_TOKEN: z.string().min(32, "use at least 32 random characters").optional(),

    // "meta" talks to graph.facebook.com directly; "360dialog" to its Cloud API proxy.
    // Both use Meta's message and webhook formats.
    WA_PROVIDER: z.enum(["meta", "360dialog"]).default("360dialog"),
    WA_API_KEY: z.string().min(1, "WA_API_KEY is required (Meta system-user token or 360dialog API key)"),
    WA_PHONE_NUMBER_ID: z.string().optional(),
    WA_BUSINESS_ACCOUNT_ID: z.string().optional(),
    WA_GRAPH_VERSION: z.string().default("v23.0"),
    WA_BASE_URL: z.url().optional(),
    // Your business number, digits only, e.g. 5511999999999. Used to tell your
    // own messages from your leads' when a payload doesn't say.
    WA_BUSINESS_NUMBER: z.string().regex(/^\d{8,15}$/, "digits only, with country code").optional(),

    // Trello CRM sync. Leave TRELLO_API_KEY empty to run without it.
    TRELLO_API_KEY: z.string().optional(),
    TRELLO_TOKEN: z.string().optional(),
    // Board id or short link (the part after /b/ in the board URL).
    TRELLO_BOARD_ID: z.string().default("6a5915aa978c66f85fe84d30"),
    // A lead in Contacted with no reply after this many days moves to Follow Up.
    CRM_FOLLOW_UP_DAYS: z.coerce.number().positive().default(3),
    // In the first preview, unknown numbers that wrote within this many days get a card.
    CRM_NEW_LEAD_LOOKBACK_DAYS: z.coerce.number().int().positive().default(30),
    CRM_CHANNEL_LABEL: z.string().default("WP"),

    // Automatic follow-ups (sequences). Quiet hours are local time; nothing automatic is sent inside them.
    FOLLOWUP_QUIET_HOURS: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, 'use "HH:MM-HH:MM", e.g. 20:00-08:30')
      .default("20:00-08:30"),
    FOLLOWUP_SKIP_WEEKENDS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // Most paid template messages the automation may send per day (protects your Meta bill).
    FOLLOWUP_DAILY_TEMPLATE_CAP: z.coerce.number().int().min(0).default(30),

    // Webhook authentication. Meta signs with the app secret (X-Hub-Signature-256).
    // Providers that don't sign must post to /webhook/<WEBHOOK_PATH_SECRET>.
    WA_APP_SECRET: z.string().optional(),
    WEBHOOK_VERIFY_TOKEN: z.string().optional(),
    WEBHOOK_PATH_SECRET: z.string().min(24, "use at least 24 random characters").optional(),
  })
  .superRefine((c, ctx) => {
    if (c.WA_PROVIDER === "meta" && !c.WA_PHONE_NUMBER_ID) {
      ctx.addIssue({ code: "custom", path: ["WA_PHONE_NUMBER_ID"], message: "required when WA_PROVIDER=meta" });
    }
    if (Boolean(c.TRELLO_API_KEY) !== Boolean(c.TRELLO_TOKEN)) {
      ctx.addIssue({ code: "custom", path: ["TRELLO_TOKEN"], message: "set both TRELLO_API_KEY and TRELLO_TOKEN, or neither" });
    }
    if (!c.WA_APP_SECRET && !c.WEBHOOK_PATH_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["WEBHOOK_PATH_SECRET"],
        message: "set WA_APP_SECRET (signed webhooks) or WEBHOOK_PATH_SECRET (secret webhook URL)",
      });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
