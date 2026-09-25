# shared by every step; override via environment
WORK=${WORK:-/tmp/workbench-bench/pi-vcc-fork}
FORK=${FORK:-$WORK/pi-vcc}                                  # a-canary fork of pi-vcc (upstream master)
PICR=${PICR:-$WORK/picr}                                    # pi-compaction-rank: corpus only, no install
FORK_URL=${FORK_URL:-https://github.com/a-canary/pi-vcc.git}
UPSTREAM_URL=${UPSTREAM_URL:-https://github.com/buihongduc132/pi-vcc.git}
PICR_URL=${PICR_URL:-https://github.com/a-canary/pi-compaction-rank.git}
TAIL_TOKEN_BUDGET=${TAIL_TOKEN_BUDGET:-8000}                # kept-tail ceiling (~32k chars); pi's own trigger is ~98k of 131k
export WORK FORK PICR FORK_URL UPSTREAM_URL PICR_URL TAIL_TOKEN_BUDGET
