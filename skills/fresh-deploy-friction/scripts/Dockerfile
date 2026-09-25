# Fresh-user box: the install shape that exposes "works on my machine" bugs.
# Non-root user, per-user npm prefix, no sudo, no pre-seeded PATH.
FROM node:22-bookworm

# Runtimes a typical dev box already has. Add language runtimes the tool under
# test needs (python3, etc.) here — NOT the tool itself; that installs as `dev`.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux sqlite3 jq curl unzip ca-certificates less procps git \
    && rm -rf /var/lib/apt/lists/*

# bun (common arc-* requirement; harmless if unused)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
    && bun --version

# Fresh non-root user — installs happen here, exposing per-user PATH gaps.
RUN useradd -m -s /bin/bash dev
USER dev
WORKDIR /home/dev

# Per-user npm global prefix (the standard no-sudo setup). The recommended
# install path on macOS/Linux — and the one that breaks naive PATH heuristics.
RUN npm config set prefix /home/dev/.npm-global
ENV PATH="/home/dev/.npm-global/bin:/home/dev/.bun/bin:${PATH}"

RUN git config --global user.name "dev" && git config --global user.email "dev@example.com" \
    && git config --global init.defaultBranch main

CMD ["sleep", "infinity"]
