import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type Router } from "express";
import { safeEqual } from "../webhook/signature.js";
import type { ToolContext } from "./context.js";
import { registerCrmTools } from "./tools/crm.js";
import { registerInboxTools } from "./tools/inbox.js";
import { registerSendTools } from "./tools/send.js";
import { registerTemplateTools } from "./tools/templates.js";

const INSTRUCTIONS = `This server is the owner's WhatsApp Business number (Inhouse Creatives).
- Messages typed on the owner's phone and messages sent here appear in the same chats.
- Free text only works within 24h of the contact's last message; otherwise use an approved template.
- Before sending anything, show the owner the exact text and recipient and get a clear yes, unless they already told you exactly what to send.
- Message ids look like ‹wamid…›; pass them without the brackets.
- Leads live on the Trello board "Inhouse Creatives LEADS". The server moves cards automatically
  (Ready to Contact → Contacted → Follow Up / Replied) and creates cards for unknown numbers that write in.
  It never edits card descriptions: when asked to update a card's STATUS or history, use the Trello tools.`;

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "whatsapp-mcp", version: "0.3.0" }, { instructions: INSTRUCTIONS });
  registerInboxTools(server, ctx);
  registerSendTools(server, ctx);
  registerTemplateTools(server, ctx);
  registerCrmTools(server, ctx);
  return server;
}

/**
 * Stateless Streamable HTTP: a fresh server and transport per request, JSON responses.
 * Access is a static bearer token for now; OAuth for claude.ai connectors replaces it in stage 5.
 */
export function mcpRouter(ctx: ToolContext): Router {
  const router = express.Router();
  const token = ctx.config.MCP_BEARER_TOKEN;

  router.use((req, res, next) => {
    if (!token) {
      return res.status(503).json({ error: "MCP access isn't configured. Set MCP_BEARER_TOKEN." });
    }
    const header = req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ") || !safeEqual(header.slice(7), token)) {
      return res.status(401).set("WWW-Authenticate", 'Bearer realm="whatsapp-mcp"').json({ error: "unauthorized" });
    }
    next();
  });

  router.post("/", express.json({ limit: "15mb" }), async (req: Request, res: Response) => {
    const server = buildMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("mcp: request failed", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  router.get("/", notAllowed);
  router.delete("/", notAllowed);
  return router;
}
