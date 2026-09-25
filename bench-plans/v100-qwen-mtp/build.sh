#!/usr/bin/env bash
# llama.cpp CUDA build for a pre-Ampere card. Needs cmake, ninja, nvcc (12.x) in PATH.
set -euo pipefail; . "$(dirname "$0")/env.sh"
mkdir -p "$WORK"; cd "$WORK"
[ -d llama.cpp ] || git clone --depth 1 --branch "$LLAMA_TAG" https://github.com/ggml-org/llama.cpp
# rootless CUDA toolkits (no ldconfig entry) need the runtime lib on the link and run path
CUDA_LIB=$(dirname "$(dirname "$(command -v nvcc)")")/lib64
[ -f build/build.ninja ] || cmake -S llama.cpp -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCH" -DGGML_NATIVE=ON \
  -DCMAKE_EXE_LINKER_FLAGS="-Wl,-rpath-link,$CUDA_LIB -Wl,-rpath,$CUDA_LIB" -DCMAKE_SHARED_LINKER_FLAGS="-Wl,-rpath,$CUDA_LIB" \
  -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=ON
ninja -C build -j"$(nproc)" llama-server
"$SERVER" --version 2>&1 | head -2
"$SERVER" --list-devices 2>&1 | grep -i cuda
