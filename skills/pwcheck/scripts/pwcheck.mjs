#!/usr/bin/env node
// pwcheck — minimal headless-Chromium page probe for E2E checks.
// Resolves Playwright from the repo or a local install; browsers cached per-user.
//
// Usage:
//   node pwcheck.mjs <url> [--wait ms] [--click "selector"] [--login EMAIL PASS]
//                        [--screenshot /tmp/shot.png]
//
// Flow: goto (domcontentloaded) -> optional --click (e.g. a Sign-in tab)
//       -> optional login (fill email/password, click submit) -> wait
//       -> print final URL + body sample. Exit 0 on success, 1 on failure.
import { chromium } from "playwright";

const args = process.argv.slice(2);
const url = args[0];
if (!url || !/^https?:\/\//.test(url)) {
	console.error("usage: pwcheck <url> [--wait ms] [--click sel] [--login EMAIL PASS] [--screenshot path]");
	process.exit(1);
}
function opt(flag) {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}
const waitMs = Number(opt("--wait") ?? 3000);
const clickSel = opt("--click");
const loginIdx = args.indexOf("--login");
const email = loginIdx >= 0 ? args[loginIdx + 1] : undefined;
const pass = loginIdx >= 0 ? args[loginIdx + 2] : undefined;
const shot = opt("--screenshot");

try {
	const browser = await chromium.launch();
	const page = await browser.newPage();
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
	if (clickSel) {
		const el = await page.$(clickSel);
		if (el) { await el.click(); await page.waitForTimeout(1200); } // let React re-render settle
		else console.error("warn: --click selector not found");
	}
	if (email && pass) {
		// :visible guards against a stale hidden twin form after a tab switch.
		await page.fill('input[type="email"]:visible', email);
		await page.fill('input[type="password"]:visible', pass);
		const btn = await page.$('button[type="submit"]');
		if (!btn) throw new Error("no submit button found");
		console.log("submit button:", (await btn.textContent())?.trim());
		await btn.click();
	}
	await page.waitForTimeout(waitMs);
	console.log("final URL:", page.url());
	const body = ((await page.textContent("body")) || "").replace(/\s+/g, " ");
	console.log("body sample:", body.slice(0, 200));
	if (shot) await page.screenshot({ path: shot });
	await browser.close();
} catch (e) {
	console.error("FAIL:", e.message);
	process.exit(1);
}
