"""Harbor agent: pi, routed through the local cli-proxy.

Harbor's stock Pi agent cannot reach our proxy, for three separate reasons that
all surface identically -- as pi failing tasks -- which is the r48 defect
(transport fault scored as a quality measurement) at harness scale:

  1. `provider, _ = model_name.split("/", 1)` strips the routing prefix, so
     `minimax/MiniMax-M3` reaches pi as the BARE id `MiniMax-M3`. The proxy
     rejects that outright: {"error":{"message":"Unknown CLI tool: minimax"}}.
  2. the provider element matches none of the stock provider branches, so the
     env allowlist stays empty and no credentials are passed.
  3. pi in-container is a fresh `npm install -g`, so it reads a default
     models.json pointing at the stock endpoints -- not the host's config.

Fixed here by provisioning pi's config inside the container at install time and
passing the prefixed id explicitly.

Usage:
  harbor run -d terminal-bench-2-1 \
    -a harness.pi_proxy_agent:PiProxy \
    -m <provider>/<model> -n 1

NOTE: PROXY_HOST must be an address the sandbox can route to. As of 2026-08-03
the proxy honours CLI_PROXY_BIND (0.0.0.0 in the systemd unit) and gates agent
mode to loopback callers separately (isLocalCaller in cli-proxy server.ts), so
the docker gateway and LAN address both work and the container gets inference
only. Verified 200 from 172.17.0.1 and <operator-box>.

Unset => this agent still refuses to run rather than silently scoring transport
failures as agent incompetence (the r48 defect).
"""

import json
import os
import shlex
from typing import override

from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment

# ponytail: env var, not a config file. One value, one caller.
PROXY_HOST = os.environ.get("PROXY_HOST")
PROXY_PORT = os.environ.get("PROXY_PORT", "7890")


class PiProxy(Pi):
    @staticmethod
    @override
    def name() -> str:
        return "pi-proxy"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not PROXY_HOST:
            raise RuntimeError(
                "PROXY_HOST unset. The proxy binds 127.0.0.1 and is unreachable "
                "from the sandbox; set PROXY_HOST to a routable address first. "
                "Refusing to run rather than score transport faults as agent failures."
            )
        await super().install(environment)

        base_url = f"http://{PROXY_HOST}:{PROXY_PORT}/v1"
        # Mirrors the host ~/.pi/agent/models.json shape: the model id keeps its
        # routing prefix, which is what the proxy dispatches on.
        provider, _, _ = self.model_name.partition("/")
        cfg = {
            "providers": {
                provider: {
                    "baseUrl": base_url,
                    # Both fields are load-bearing and were both missing/wrong until
                    # 2026-08-03: pi reported `Unknown provider` because `api` was
                    # absent and `models` was a dict. The host's working
                    # ~/.pi/agent/models.json uses `api` + a LIST; match it exactly.
                    "api": "openai-completions",
                    "apiKey": "cli-proxy",
                    "models": [
                        {
                            "id": self.model_name,
                            "name": self.model_name,
                            "reasoning": False,
                            "contextWindow": 32768,
                        }
                    ],
                }
            }
        }
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p $HOME/.pi/agent && "
                f"printf %s {shlex.quote(json.dumps(cfg))} > $HOME/.pi/agent/models.json"
            ),
        )

    @override
    async def run(self, instruction, environment, context) -> None:  # type: ignore[override]
        # The stock run() splits the prefix off the model id. Temporarily present
        # a doubled prefix so its split leaves the id the proxy actually needs.
        # ponytail: a 3-line swap beats reimplementing the 40-line run() body.
        real = self.model_name
        self.model_name = f"{real.partition('/')[0]}/{real}"
        try:
            await super().run(instruction, environment, context)
        finally:
            self.model_name = real
