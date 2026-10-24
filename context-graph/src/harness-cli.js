#!/usr/bin/env node
/**
 * Context-graph harness CLI for harness-bench.
 *
 * Usage: node harness-cli.js --model <provider/model> [--quality-window <n>] [--fill-frac <f>] "task instruction here"
 *
 * Outputs NDJSON with agent_end event containing token usage.
 * ponytail: minimal integration between context-graph loop and harness-bench.
 * Toy version uses mock LLM; real version would call cli-proxy.
 */

import { runHarnessLoop } from './harness.js';

async function main() {
  const args = process.argv.slice(2);

  let model = null;
  let instruction = null;
  let qualityWindow = null;
  let fillFrac = null;

  // Parse args: --model <provider/model> [--quality-window <n>] [--fill-frac <f>] "instruction"
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && i + 1 < args.length) {
      model = args[i + 1];
      i++;
    } else if (args[i] === '--quality-window' && i + 1 < args.length) {
      qualityWindow = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--fill-frac' && i + 1 < args.length) {
      fillFrac = Number(args[i + 1]);
      i++;
    } else if (!instruction) {
      instruction = args[i];
    }
  }

  if (!model || !instruction) {
    console.error('Usage: harness-cli.js --model <provider/model> [--quality-window <n>] [--fill-frac <f>] "task instruction"');
    process.exit(1);
  }

  try {
    await runHarnessLoop(model, instruction, qualityWindow ?? undefined, fillFrac ?? undefined);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
