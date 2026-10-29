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
    let res: Response;
    try {
      res = await doFetch(USAGE_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const json = await res.json();
    const limits = parseUsage(json);
    return meterOf(limits);
  } catch {
    return null;
  }
}
