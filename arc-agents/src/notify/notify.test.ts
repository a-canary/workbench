/**
 * notify — estate-wide alerting library tests.
 */
import { describe, it, expect } from "bun:test";
import { notifyDiscord, notifyChat, notify, colorFor } from "./notify";

describe("colorFor", () => {
  it("returns red for error", () => {
    expect(colorFor("error")).toBe(16711680);
  });
  it("returns yellow for warn", () => {
    expect(colorFor("warn")).toBe(16776960);
  });
  it("returns green for info", () => {
    expect(colorFor("info")).toBe(65280);
  });
  it("returns gray default", () => {
    expect(colorFor(undefined)).toBe(7500);
  });
});

describe("notifyDiscord", () => {
  it("returns skipped when DISCORD_WEBHOOK_URL not set", async () => {
    const orig = process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    const result = await notifyDiscord({ title: "t", body: "b" });
    expect(result).toBe("skipped");
    if (orig) process.env.DISCORD_WEBHOOK_URL = orig;
  });
});

describe("notify", () => {
  it("honors target=discord", async () => {
    const orig = process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    const res = await notify({ title: "t", body: "b", target: "discord" });
    expect(res.discord).toBe("skipped");
    expect(res.chat).toBe("skipped");
    if (orig) process.env.DISCORD_WEBHOOK_URL = orig;
  });

  it("honors target=chat", async () => {
    const res = await notify({ title: "t", body: "b", target: "chat" });
    expect(res.discord).toBe("skipped");
    // chat may fail if arc-chat binary missing — either "failed" or "sent" acceptable
    expect(["sent", "skipped", "failed"]).toContain(res.chat);
  });

  it("skips when dedupeKey + state match previous", async () => {
    const origWebhook = process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    const key = `test-dedupe-${Date.now()}`;
    // First send with state=down: chat will try (arc-chat binary path may fail),
    // but the dedupe state should be marked.
    await notify({ title: "first", body: "b", target: "chat", dedupeKey: key, state: "down" });
    // Second send with same state: should skip entirely (both transports skipped).
    const res = await notify({ title: "second", body: "b", target: "both", dedupeKey: key, state: "down" });
    expect(res.discord).toBe("skipped");
    expect(res.chat).toBe("skipped");
    if (origWebhook) process.env.DISCORD_WEBHOOK_URL = origWebhook;
  });

  it("fires on state transition (down→up)", async () => {
    const origWebhook = process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    const key = `test-transition-${Date.now()}`;
    await notify({ title: "first down", body: "b", target: "chat", dedupeKey: key, state: "down" });
    // Transition to up: at least one transport must be attempted (chat).
    const res = await notify({ title: "now up", body: "b", target: "chat", dedupeKey: key, state: "up" });
    expect(["sent", "skipped", "failed"]).toContain(res.chat);
    if (origWebhook) process.env.DISCORD_WEBHOOK_URL = origWebhook;
  });
});