---
name: vast-cli
description: "Drive the vast.ai CLI (`vastai`) correctly — search offers, create/start an instance, poll readiness, ssh, pull results, stop. Encodes the proxy-unset, PATH-shim, and ssh-rotation gotchas that silently no-op the CLI. Use when launching, inspecting, or tearing down a vast GPU box, or when `vastai` returns nothing / ENOENT / a stale state."
---

# vast-cli — operating the `vastai` CLI

Battle-tested invocation patterns. Prefer an unattended lifecycle daemon (start→run→rsync→stop with hard timeouts) for non-interactive jobs; reach for raw `vastai` only when scripting a one-off.

## Environment (do this first — or the CLI silently fails)

1. **Unset the proxy.** A local cli-proxy intercepts `vastai`'s REST calls and
   they hang/410. Always:
   ```sh
   export NO_PROXY='*'; unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
   ```
2. **Resolve the binary explicitly.** Under systemd/cron `~/.local/bin` is NOT
   on PATH, so a bare `vastai` is `ENOENT` and every call no-ops. Use the pipx
   shim path: `VASTAI_BIN=~/.local/bin/vastai`.
3. API key lives at `~/.config/vastai/vast_api_key`; `--api-key` overrides.

## The lifecycle (verbs in order)

```sh
# 1. SEARCH — machine-readable, ranked. inet_down is a real query field.
vastai search offers 'gpu_name=RTX_3090 inet_down>=1000 rentable=true' \
  -o 'inet_down-' --raw            # -o sorts; trailing - = descending

# 2. CREATE — note --ssh (not jupyter) and --direct (faster connection).
vastai create instance <OFFER_ID> --image <img> --ssh --direct \
  --disk 60 --onstart-cmd '<setup>'     # ID comes from search offers

# 3. POLL readiness — state lives at cur_state || actual_status in --raw json.
vastai show instance <ID> --raw   # parse: cur_state, ssh_host, ssh_port
#   wait for state=running AND ssh answers (next section). Don't trust state alone.

# 4. SSH — host/port ROTATE on every start; re-read from --raw, never hardcode.

# 5. STOP — releases billing; disk persists.
vastai stop instance <ID>
vastai destroy instance <ID>      # frees disk too (irreversible)
```

`vastai show instances` (plural) lists everything you own — use it to find
orphaned running boxes burning money.

## SSH (the rotation trap)

`ssh_host` and `ssh_port` change on **every** `vastai start`. Re-read them from
`show instance --raw` at runtime. Connect non-interactively:

```sh
ssh -i ~/.ssh/id_ed25519 -p "$PORT" \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 -o BatchMode=yes root@"$HOST" true   # readiness probe
```

A box is *ready* only when `state=running` AND that `true` probe exits 0 — the
image pull can lag the running state by minutes.

## Readiness poll, the safe shape

```sh
for i in $(seq 1 60); do
  raw=$("$VASTAI_BIN" show instance "$ID" --raw)
  st=$(echo "$raw" | jq -r '.cur_state // .actual_status')
  [ "$st" = "running" ] && ssh ... root@... true 2>/dev/null && break
  sleep 15
done
```

Always bound the loop. A low-bandwidth box can wedge on the pull indefinitely —
gate offers on bandwidth at search time (see [[vast-instance]]).

## Gotchas (each one has bitten a real run)

- **`gpu_util` is stale when stopped** — it's a lifetime artifact. Only trust it
  while `state=running`.
- **rsync results back over the same rotating host/port** — rebuild the ssh `-e`
  string per run, don't cache it.
- **No proxy / no PATH shim = silent no-op**, not an error you'll notice. If a
  `vastai` call "did nothing", check those two first.

## See also

- [[vast-instance]] — what stack to put ON the box once it's up (bandwidth gate,
  runtime images, verified pins, HF-token + stage-verify guards).
- Your warmpool daemon — automates start→run→rsync→stop with hard timeouts so
  an agent can never hold GPU billing.
- `vast-lease` — cooperative *ownership* lease; acquire before any shared-box
  job (separate concern from power state).
