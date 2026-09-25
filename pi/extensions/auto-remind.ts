/**
 * auto-remind.ts — fires skill reminders every N turns.
 *
 * Tracks turn counts per agent (derived from AGENT_DIR). On each `turn_end`,
 * increments the counter. When threshold is hit, injects a reminder message
 * that looks like a skill invocation, then resets the counter.
 *
 * Config: ~/.pi/agent/extensions/auto-remind.json
 *   {
 *     "defaultSkill": "journal",
 *     "defaultInterval": 5,
 *     "perAgent": {
 *       "director": { "interval": 10 },
 *       "admin":    { "interval": 8 }
 *     }
 *   }
 *
 * Overrides via env:
 *   AUTO_REMIND_SKILL=journal
 *   AUTO_REMIND_INTERVAL=5
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CONFIG_PATH = join(dirname(require("node:process").argv[1]), "auto-remind.json");
const TURNS_DIR = join(process.env["HOME"] ?? "", ".journal-turns");

interface AgentConfig {
  interval: number;
  skill: string;
}

interface Config {
  defaultSkill: string;
  defaultInterval: number;
  perAgent: Record<string, Partial<AgentConfig>>;
}

function loadConfig(): Config {
  const defaults: Config = {
    defaultSkill: "journal",
    defaultInterval: 5,
    perAgent: {},
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      return { ...defaults, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
    } catch {
      /* ignore bad config, use defaults */
    }
  }
  return defaults;
}

function getAgentName(agentDir: string): string {
  const parts = agentDir.split("/");
  const agentsIdx = parts.lastIndexOf("agents");
  if (agentsIdx >= 0 && agentsIdx + 1 < parts.length) {
    return parts[agentsIdx + 1];
  }
  // Fallback: derive from path tail
  return parts[parts.length - 1] || "unknown";
}

function getCounterPath(agentName: string): string {
  return join(TURNS_DIR, `${agentName}.json`);
}

function getCounter(agentName: string): number {
  const p = getCounterPath(agentName);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8")).turns ?? 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function setCounter(agentName: string, turns: number): void {
  mkdirSync(TURNS_DIR, { recursive: true });
  const p = getCounterPath(agentName);
  writeFileSync(p, JSON.stringify({ turns, updated: new Date().toISOString() }), "utf8");
}

function getAgentConfig(agentName: string, config: Config): AgentConfig {
  const per = config.perAgent[agentName] ?? {};
  return {
    skill: per.skill ?? process.env["AUTO_REMIND_SKILL"] ?? config.defaultSkill,
    interval: per.interval ?? Number(process.env["AUTO_REMIND_INTERVAL"] ?? config.defaultInterval),
  };
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  pi.on("turn_end", async (event, ctx) => {
    const agentDir = process.env["AGENT_DIR"] ?? "";
    if (!agentDir) return;

    const agentName = getAgentName(agentDir);
    const { skill, interval } = getAgentConfig(agentName, config);

    const turns = getCounter(agentName) + 1;
    setCounter(agentName, turns);

    if (turns < interval) return;

    // Reset counter
    setCounter(agentName, 0);

    // Read the skill file
    const skillPath = join(process.env["HOME"] ?? "", "agents", "skills", skill, "SKILL.md");
    let skillContent = "";
    if (existsSync(skillPath)) {
      try {
        skillContent = readFileSync(skillPath, "utf8");
      } catch {
        skillContent = "";
      }
    }

    const now = new Date().toISOString();
    const time = now.slice(11, 16); // HH:MM

    // Inject reminder that looks like a skill invocation
    // The content mimics what the skill directive says to do
    const reminder = skillContent
      ? `## Reminder: run the \`${skill}\` skill\n\n${skillContent.trim()}\n\n**Time: ${time}**\n\nAppend your checkpoint to the journal now.`
      : `## Journal checkpoint — ${time}\n\nYou have completed ${interval} turns since your last journal entry.\n\nAppend a brief entry to \`journal/${now.slice(0, 10)}.md\`:\n- What did you do?\n- What decision did you make?\n- Any blocker or insight?\n\nFormat: \`HH:MM — <1-line summary>\``;

    ctx.sendMessage({
      customType: "auto-remind",
      content: reminder,
      display: false, // silent — doesn't clutter context
    });
  });

  // Also fire on session_start to check if agent hasn't journaled recently
  pi.on("session_start", async (event, ctx) => {
    const agentDir = process.env["AGENT_DIR"] ?? "";
    if (!agentDir) return;

    const agentName = getAgentName(agentDir);
    const turns = getCounter(agentName);

    if (turns > 0) {
      // Agent is resuming with pending turns — nudge immediately
      const { skill, interval } = getAgentConfig(agentName, config);
      ctx.sendMessage({
        customType: "auto-remind",
        content: `## Resuming — journal ${turns}/${interval} turns pending\n\nBefore continuing, append a journal checkpoint for the work done before this session.\n\nFormat: \`HH:MM — <1-line summary>\``,
        display: false,
      });
    }
  });
}
