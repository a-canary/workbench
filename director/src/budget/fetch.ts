import { readFileSync } from "node:fs";
import { parseUsage, meterOf } from "./meter.ts";

const DEFAULT_TIMEOUT_MS = 3000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CRED_FILE = `${process.env.HOME}/.claude/.credentials.json`;

async function defaultToken(): Promise<string | null> {
  try {
    const creds = JSON.parse(readFileSync(CRED_FILE, "utf8"));
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function fetchMeter(deps?: {
  token?: () => Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ util: number; limited: boolean } | null> {
  try {
    const token = await (deps?.token ?? defaultToken)();
    if (!token) return null;
    const doFetch = deps?.fetch ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try { // timer spans the body read too: a stalled body must not hang the queue pick
      const res = await doFetch(USAGE_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return meterOf(parseUsage(await res.json()));
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
