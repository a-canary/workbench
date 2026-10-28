# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-05-11

### Added
- **Full EA lifecycle** (`src/ea.ts`) — seed → validate → evaluate → select → breed → terminate with event hooks
- **Eval caching** (`src/cache.ts`) — SHA256 by genome content, not individual ID; identical genomes always hit cache
- **Parallel evaluation** (`src/semaphore.ts`) — configurable concurrency limit for eval and breed phases
- **Exponential backoff** (`src/backoff.ts`) — with jitter and retry cap for transient failures
- **Standard log schema** (`src/logger.ts`) — append-only JSONL lineage logger with typed events
- **Artifact types** — free-text, structured-text, code, config-tuple, pipeline, concept
- **EA state tracking** (`EARunState`, `EARunResult`) — monitor polling, getBest, isDone
- **Vitest test suite** — 49 tests covering cache, semaphore, backoff, utils, and EA lifecycle
- **3 working examples** — preamble evolution, config-tuple evolution, pipeline with LLM judge
- **Hermes integration docs** (`docs/HERMES.md`) — skill design contract and integration guide

### Changed
- `package.json` exports now point to `dist/` (compiled) instead of `src/` for npm publish readiness
- `files` field updated to include `dist/` for proper npm package inclusion

### Fixed
- Missing `generationsCompleted` field in `EARunState` interface (`src/types.ts`)
- `EA.getState()` now correctly populates `generationsCompleted`