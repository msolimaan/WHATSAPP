import express, { type Request, type Response, type Router } from "express";
import type { Config } from "../config.js";
import type { EventBus } from "../events/bus.js";
import type { Store } from "../store/store.js";
import { processWebhook } from "./process.js";
import type { WebhookPayload } from "./parse.js";
import { safeEqual, verifySignature } from "./signature.js";

type WebhookConfig = Pick<
  Config,
  "WA_APP_SECRET" | "WEBHOOK_VERIFY_TOKEN" | "WEBHOOK_PATH_SECRET" | "WA_BUSINESS_NUMBER"
>;

/**
 * Mount at /webhook. Accepts /webhook and /webhook/<secret>.
 * - GET answers Meta's subscription check (hub.verify_token).
 * - POST must pass every check that is configured: Meta's signature and/or the URL secret.
 */
export function webhookRouter(config: WebhookConfig, store: Store, bus: EventBus, log = console): Router {
  const router = express.Router();

  const pathOk = (req: Request) =>
    !config.WEBHOOK_PATH_SECRET || safeEqual(String(req.params.secret ?? ""), config.WEBHOOK_PATH_SECRET);

  const verify = (req: Request, res: Response) => {
    if (!pathOk(req)) return res.sendStatus(404);
    const mode = req.query["hub.mode"];
    const token = String(req.query["hub.verify_token"] ?? "");
    if (mode === "subscribe" && config.WEBHOOK_VERIFY_TOKEN && safeEqual(token, config.WEBHOOK_VERIFY_TOKEN)) {
      return res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
    }
    return res.sendStatus(403);
  };

  const receive = (req: Request, res: Response) => {
    // 404 rather than 401 so the endpoint doesn't confirm it exists to scanners.
    if (!pathOk(req)) return res.sendStatus(404);
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw)) return res.sendStatus(400);
    if (config.WA_APP_SECRET && !verifySignature(raw, req.header("x-hub-signature-256"), config.WA_APP_SECRET)) {
      log.warn("webhook: rejected delivery with a bad or missing signature");
      return res.sendStatus(401);
    }
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.sendStatus(400);
    }
    try {
      const r = processWebhook(store, bus, payload, config.WA_BUSINESS_NUMBER);
      for (const n of r.notices) log.info(`webhook: ${n}`);
    } catch (err) {
      // The raw delivery is saved with the error so it can be replayed after a fix.
      // Still answer 200: a payload we can't parse would otherwise be retried for days.
      log.error("webhook: processing failed", err);
    }
    return res.sendStatus(200);
  };

  const raw = express.raw({ type: "*/*", limit: "5mb" });
  router.get("/", verify);
  router.get("/:secret", verify);
  router.post("/", raw, receive);
  router.post("/:secret", raw, receive);
  return router;
}
