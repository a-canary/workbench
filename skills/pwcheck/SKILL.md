---
name: pwcheck
description: "Headless-Chromium page probe at ~/lib/e2e/pwcheck.mjs — goto a URL, optionally click through (tabs) and log in, print final URL + body sample. Use for E2E verification of client-side behavior curl can't see: SPA redirects, auth flows, post-login landing pages. Machine-local; verify `test -x ~/lib/e2e/pwcheck.mjs` first, bootstrap per §Bootstrap if absent."
---

# pwcheck

One-shot headless page probe. Prints `final URL:` + `body sample:`; exit 0 on
success, 1 on failure (script error or navigation timeout). No test framework,
no fixtures — a probe, not a suite. For repeatable assertions, write a real
test in the target repo instead.

## Usage

```sh
node ~/lib/e2e/pwcheck.mjs <url> [--wait ms] [--click "selector"] \
  [--login EMAIL PASS] [--screenshot /tmp/shot.png]
```

- `--wait ms` — settle time after actions (default 3000). SPAs with client-side
  redirects need ≥4000.
- `--click sel` — click before login (e.g. a Sign-in tab when the page defaults
  to Create Account). Waits for React re-render before filling.
- `--login EMAIL PASS` — fills visible email/password inputs, clicks submit.
- `--screenshot path` — full-page PNG of the final state (read it with the
  image tool; body text alone hides layout problems).

## Examples

```sh
# Does a guest hit the sign-in page?
node ~/lib/e2e/pwcheck.mjs https://app.ndivisible.com/ --wait 4000

# Full login journey (ndivisible QA creds live in pass)
QEMAIL=$(pass ndivisible/qa-journey-login | grep email: | cut -d' ' -f2)
QPASS=$(pass ndivisible/qa-journey-login | sed -n 1p)
node ~/lib/e2e/pwcheck.mjs https://app.ndivisible.com/setup --wait 6000 \
  --click 'button:has-text("Sign In")' --login "$QEMAIL" "$QPASS"
```

## Gotchas

- **`[Cloudflare Turnstile] Error: 600010` in the console is EXPECTED on this
  host** — headless Chromium can't resolve `*.challenges.cloudflare.com` (shell
  `getent` resolves fine; it's a browser-DNS quirk). It does NOT mean the flow
  is broken: ndivisible sign-in returns 200 without a challenge (Turnstile is
  register-only). Judge by final URL + API status, not console noise. Use a
  real browser for genuine Turnstile verification.
- **Re-render race**: after `--click` switches a tab, React remounts the form.
  The tool waits 1200ms and fills `:visible` inputs to avoid writing into a
  stale hidden twin. If a fill silently no-ops, screenshot and look for an
  empty form before blaming the app.
- **networkidle is unreliable** (persistent connections) — the tool uses
  `domcontentloaded` + fixed settle; don't "fix" it to networkidle.
- Credentials via env/args only; never hardcode into scripts or commits.

## Bootstrap (new host)

```sh
mkdir -p ~/lib/e2e && cd ~/lib/e2e
printf '{"name":"ndv-e2e","private":true,"type":"module","dependencies":{"playwright":"1.61.1"}}' > package.json
npm i --no-fund --no-audit          # browsers: npx playwright install chromium (or reuse ~/.cache/ms-playwright)
# copy pwcheck.mjs from this skill's host, or see the Usage section — it is ~60 lines
chmod +x pwcheck.mjs
```

Pin the playwright version to whatever `~/.cache/ms-playwright` build the host
already has (mismatched versions trigger a full browser re-download).
