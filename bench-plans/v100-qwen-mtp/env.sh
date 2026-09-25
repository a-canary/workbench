# shared by every step; override via environment
WORK=${WORK:-/tmp/workbench-bench/v100}          # clone + build dir
MODEL=${MODEL:?MODEL=<path to Qwen3.8-27B Q6_K gguf>}
LLAMA_TAG=${LLAMA_TAG:-b10840}              # first release with --spec-type draft-mtp
CUDA_ARCH=${CUDA_ARCH:-70}                  # V100 = sm_70
PORT=${PORT:-8099}
CTX=${CTX:-32768}
N_PREDICT=${N_PREDICT:-256}
CEILING=${CEILING:-40}                      # tok/s: Q6_K 27B (~22 GB) weight-bandwidth bound on 900 GB/s HBM2
DEVICE_ARG=${LLAMA_DEVICE:+--device $LLAMA_DEVICE}
SERVER=$WORK/build/bin/llama-server
