// wb-an0.4: live meter fetch — injected token + fetch, 3s timeout, null on ANY failure (never throws).
import { expect, test } from "bun:test";
import { fetchMeter } from "./fetch.ts";

const body = { limits: [{ kind: "k", group: "session", percent: 41, is_active: true }, { kind: "k", group: "weekly", percent: 93, is_active: true }] };
const ok = (j: unknown, status = 200) => async () => new Response(JSON.stringify(j), { status });

test("ok response -> meter over active session/weekly; token sent as bearer with the oauth beta header", async () => {
  let seen: Request | undefined;
  const m = await fetchMeter({
    token: async () => "tok",
    fetch: async (input, init) => { seen = new Request(input as string, init); return ok(body)(); },
  });
  expect(m).toEqual({ util: 0.93, limited: false });
  expect(seen!.url).toBe("https://api.anthropic.com/api/oauth/usage");
  expect(seen!.headers.get("authorization")).toBe("Bearer tok");
  expect(seen!.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
});

test("null, never a throw: missing token, fetch throws, non-200, non-JSON, no qualifying limits", async () => {
  expect(await fetchMeter({ token: async () => null, fetch: ok(body) })).toBeNull();
  expect(await fetchMeter({ token: async () => { throw new Error("no creds"); }, fetch: ok(body) })).toBeNull();
  expect(await fetchMeter({ token: async () => "t", fetch: async () => { throw new Error("ECONNREFUSED"); } })).toBeNull();
  expect(await fetchMeter({ token: async () => "t", fetch: ok(body, 401) })).toBeNull();
  expect(await fetchMeter({ token: async () => "t", fetch: async () => new Response("<html>") })).toBeNull();
  expect(await fetchMeter({ token: async () => "t", fetch: ok({ limits: [] }) })).toBeNull();
});

test("a hung endpoint is abandoned at timeoutMs (default 3000)", async () => {
  const t0 = Date.now();
  const hang = (_: unknown, init?: RequestInit) =>
    new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  expect(await fetchMeter({ token: async () => "t", fetch: hang as typeof fetch, timeoutMs: 50 })).toBeNull();
  expect(Date.now() - t0).toBeLessThan(1000);
});
