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
});
