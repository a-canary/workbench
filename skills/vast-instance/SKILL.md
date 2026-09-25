---
name: vast-instance
description: "Instance best practices for vast.ai GPU jobs — bandwidth-gate the offer, prefer runtime images, pin the verified LFM2.5 training stack, guard the HF token, and stage-verify code before it runs. Use when provisioning a box, choosing an offer/image, installing a training stack on a vast box, or debugging float8/ImportError/dead-HF-token failures that wasted lease hours."
---

# vast-instance — provisioning & on-box best practices

Five defaults that turn the four recurring lease-burning failures into
push-button setup. Each was hand-fixed live on a real run; codified here so the
next GPU run doesn't re-pay the tax. Operate the CLI per [[vast-cli]].

## 0. Lease before you launch

On a **shared** box, acquire the cooperative lock first via your `vast-lease`
helper's `acquire` command. It's ownership, not power — orthogonal to
start/stop. Don't run a GPU job on a box you don't hold. Put venvs on
**`/mnt`**, never root fs (root is full).

## 1. Bandwidth-gate the offer (≥1 Gbit)

Low-bandwidth boxes wedge on the image pull and burn the lease before the job
starts. **Floor: `inet_down>=1000`.** Rank descending, take the top rentable:

```sh
vastai search offers 'gpu_name=RTX_3090 inet_down>=1000 rentable=true' \
  -o 'inet_down-' --raw
```

Fail fast if no ≥1 Gbit offer exists — don't lease a slow box "to get started".
(Same rule lives in your global `AGENTS.md`; this skill is the mechanical
version.)

## 2. Prefer a `*-runtime` image over `*-devel`

`*-devel` images are huge and wedged a box ~9 min on the pull (real incident,
box 40250037). The equivalent `*-runtime` tag pulled in ~3 min. Default to
runtime tags; only use devel when you actually need `nvcc`/build headers.

## 3. Pin the verified LFM2.5 stack (the float8 fix)

The `torch.float8_e8m0fnu` AttributeError comes from a torch-2.4 image meeting
transformers 5.x (LFM2.5 forces tx 5.x → needs torch ≥2.5). **Never
`pip install -U "transformers>=4.44"` unbounded** — it pulls 5.x onto torch 2.4.

Verified-working combo for **LFM2.5-1.2B on a 3090** (confirmed `CUDA True`
live), install in this order on-box:

```sh
pip install torch==2.5.1+cu121 --index-url https://download.pytorch.org/whl/cu121
pip install "transformers==5.7.0" "trl==1.4.0" "peft==0.19.1" \
            accelerate datasets sentence-transformers
```

Pins: **torch 2.5.1+cu121 · transformers 5.7.0 · trl 1.4.0 · peft 0.19.1.**
These four are the contract; the rest float.

## 4. Guard the HF token (live-inline, never on disk)

A dead/revoked token cached at `~/.cache/huggingface/token` on the box shadows
the live one and fails every pull. Before any HF download, on the box:

```sh
rm -f ~/.cache/huggingface/token
```

Pass the **live** token inline in the run env ONLY
(`HF_TOKEN=... python train.py`). **Never** write it to box disk or any file.

## 5. Stage-verify (no stale code runs)

Staging stale code to the box caused an `ImportError` that killed runs after
setup looked fine. After rsync/scp, assert the box copy matches the host before
launch:

```sh
host=$(md5sum harness.py | awk '{print $1}')
box=$(ssh ... root@HOST "md5sum /workspace/harness.py | awk '{print \$1}'")
[ "$host" = "$box" ] || { echo "STALE COPY on box"; exit 1; }
```

If the hashes differ, the box has an old copy — re-stage, never run.

## Quick checklist

1. Lease acquired · venv on `/mnt`.
2. Offer `inet_down>=1000`, ranked `inet_down-`, `*-runtime` image.
3. Stack pinned (torch 2.5.1 / tx 5.7.0 / trl 1.4.0 / peft 0.19.1).
4. Box `~/.cache/huggingface/token` removed · live token inline-only.
5. Staged code md5-verified against host before launch.

## See also

- [[vast-cli]] — search/create/poll/ssh/stop mechanics + proxy/PATH/ssh traps.
- Your warmpool daemon — automates start→run→rsync→stop with hard timeouts.
