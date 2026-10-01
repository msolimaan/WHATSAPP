import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("requires a way to authenticate webhooks", () => {
    expect(() => loadConfig({ WA_API_KEY: "k" })).toThrow(/WEBHOOK_PATH_SECRET/);
  });
  it("requires the phone number id for Meta direct", () => {
    expect(() => loadConfig({ WA_API_KEY: "k", WA_PROVIDER: "meta", WA_APP_SECRET: "s" })).toThrow(/WA_PHONE_NUMBER_ID/);
  });
  it("accepts a minimal 360dialog setup", () => {
    const c = loadConfig({ WA_API_KEY: "k", WEBHOOK_PATH_SECRET: "a".repeat(24) });
    expect(c).toMatchObject({ WA_PROVIDER: "360dialog", PORT: 3000 });
  });
  it("rejects a misspelled time zone at startup", () => {
    expect(() => loadConfig({ WA_API_KEY: "k", WEBHOOK_PATH_SECRET: "a".repeat(24), TIMEZONE: "Sao Paulo" })).toThrow(/time zone/);
    expect(loadConfig({ WA_API_KEY: "k", WEBHOOK_PATH_SECRET: "a".repeat(24), TIMEZONE: "Asia/Dubai" }).TIMEZONE).toBe("Asia/Dubai");
  });
  it("treats empty values as not set, like a copied .env.example", () => {
    const c = loadConfig({
      WA_API_KEY: "k", WEBHOOK_PATH_SECRET: "a".repeat(24),
      WA_BUSINESS_NUMBER: "", PUBLIC_BASE_URL: "", OWNER_PASSWORD: "", MCP_BEARER_TOKEN: " ", TRELLO_API_KEY: "", TRELLO_TOKEN: "", WA_APP_SECRET: "",
    });
    expect(c.WA_BUSINESS_NUMBER).toBeUndefined();
    expect(c.OWNER_PASSWORD).toBeUndefined();
    expect(c.PORT).toBe(3000);
  });
});
