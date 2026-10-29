// driverPanel — pure render of a lane's sprint state (ported from arc-webui).
import { ago, fmt, esc, sparkline } from "./fmt.ts";
import { live, trends, type Sprint } from "../sprint/log.ts";
import type { Steer } from "../sprint/steer.ts";

export type Rel = { id: string; title: string; status?: string };
export type Ctx = {
  deps: Rel[];
  dependents: Rel[];
  comments: { ts: string; author: string; text: string }[];
  missions: { slug: string; um: string; problem: string }[];
  queue: Rel[];
};

const SPRINT_MIN = 60;

const CSS = `
.dr-panel{font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.5;color:#1a1a1a}
.dr-lane{font-weight:700;font-size:15px;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.dr-status{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;letter-spacing:.3px}
.dr-status.ok{background:#d4edda;color:#155724}
.dr-status.warn{background:#fff3cd;color:#856404}
.dr-status.over{background:#f8d7da;color:#721c24}
.dr-status.idle{background:#e2e3e5;color:#383d41}
.dr-section{margin:12px 0;padding:8px 10px;background:#fafafa;border-radius:6px}
.dr-section h3{margin:0 0 6px 0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#666}
.dr-chip{display:inline-block;padding:1px 6px;border-radius:3px;background:#e9ecef;margin-right:4px;font-size:11px}
.dr-sprint{padding:6px 0;border-bottom:1px solid #eee}
.dr-sprint:last-child{border-bottom:0}
.dr-spark{vertical-align:middle;margin-left:4px}
.dr-ago{color:#888;font-size:11px}
`;

function st(label: string, cls: string) {
  return `<span class="dr-status ${cls}">${esc(label)}</span>`;
}

function relLi(r: Rel) {
  return `<li><a href="#${esc(r.id)}">${esc(r.id)}</a> — ${esc(r.title)}${r.status ? " " + st(r.status, "s") : ""}</li>`;
}

function chip(label: string, value: string) {
  return `<span class="dr-chip">${esc(label)}: ${esc(value)}</span>`;
}

export function driverPanel(
  lane: string,
  all: Sprint[],
  ctx: Ctx,
  steer: Steer,
  o?: { project?: string; lanes?: string[]; flash?: string; now?: number },
): string {
  const now = o?.now ?? Date.now();
  const project = o?.project;

  const sprints = project ? all.filter((s) => s.project === project) : all;
  const cur = live(sprints);

  let h = `<div class="dr-panel"><style>${CSS}</style>`;
  h += `<div class="dr-lane">${esc(lane)}</div>`;

  if (o?.flash) {
    h += `<div class="dr-flash" style="background:#fff3cd;padding:6px 10px;border-radius:4px;margin-bottom:8px">${esc(o.flash)}</div>`;
  }

  // Live sprint
  if (cur) {
    const over = cur.minutes > SPRINT_MIN;
    const cls = over ? "over" : "ok";
    h += `<div class="dr-section">`;
    h += `<h3>Live</h3>`;
    h += `<div>${st(`${cur.minutes} / ${SPRINT_MIN} min${over ? " — over timebox" : ""}`, cls)}</div>`;
    h += `<div style="margin:4px 0">${chip("id", cur.id)} ${chip("project", cur.project)} ${chip("priority", String(cur.priority))}</div>`;
    h += `<div><strong>${esc(cur.title)}</strong></div>`;
    h += `<div class="dr-ago">${ago(cur.ts, now)}</div>`;

    // Prep hits
    const hits: string[] = [];
    if (cur.mem.length > 0) {
      hits.push(`<div><strong>Memory:</strong> ${cur.mem.map((m) => chip(m.key, m.text)).join(" ")}</div>`);
    }
    if (cur.ke.length > 0) {
      hits.push(`<div><strong>Knowledge:</strong> ${cur.ke.map((k) => `<span class="dr-chip">${Number.isFinite(k.score) ? fmt(k.score) + "%" : "—"} — ${esc(k.title)}</span>`).join(" ")}</div>`);
    }
    if (cur.steer.length > 0) {
      hits.push(`<div><strong>Steering:</strong> steering delivered: ${cur.steer.map((s) => esc(s.text)).join(", ")}</div>`);
    }
    if (hits.length > 0) {
      h += `<div style="margin-top:6px">${hits.join("")}</div>`;
    }
    h += `</div>`;
  } else {
    h += `<div class="dr-section"><h3>Live</h3><div>${st("Idle", "idle")}</div></div>`;
  }

  // Trends
  const trs = trends(sprints);
  if (trs.length > 0) {
    h += `<div class="dr-section"><h3>Trends</h3>`;
    for (const t of trs) {
      const last = t.vals[t.vals.length - 1];
      h += `<div style="margin:4px 0">${chip(t.name, fmt(last))} ${sparkline(t.vals)}</div>`;
    }
    h += `</div>`;
  }

  // Mission alignment
  h += `<div class="dr-section"><h3>Mission alignment</h3>`;
  const alignProject = project ?? cur?.project;
  if (alignProject) {
    const mission = ctx.missions.find((m) => m.slug === alignProject);
    if (mission) {
      h += `<div>${chip("UM", mission.um)}</div>`;
      h += `<div><strong>Problem:</strong> ${esc(mission.problem)}</div>`;
    }
  }
  h += `</div>`;

  // Depends on
  if (ctx.deps.length > 0) {
    h += `<div class="dr-section"><h3>Depends on</h3><ul>${ctx.deps.map(relLi).join("")}</ul></div>`;
  }

  // Dependents
  if (ctx.dependents.length > 0) {
    h += `<div class="dr-section"><h3>Dependents</h3><ul>${ctx.dependents.map(relLi).join("")}</ul></div>`;
  }

  // Queue
  if (ctx.queue.length > 0) {
    h += `<div class="dr-section"><h3>Queue</h3><ul>${ctx.queue.map(relLi).join("")}</ul></div>`;
  }

  // Comments
  if (ctx.comments.length > 0) {
    h += `<div class="dr-section"><h3>Comments</h3>`;
    for (const c of ctx.comments) {
      h += `<div><strong>${esc(c.author)}</strong> <span class="dr-ago">${ago(c.ts, now)}</span> ${esc(c.text)}</div>`;
    }
    h += `</div>`;
  }

  // Pending steering
  if (steer.pin.length > 0 || steer.skip.length > 0 || steer.notes.length > 0) {
    h += `<div class="dr-section"><h3>Steering</h3>`;
    if (steer.pin.length > 0) h += `<div>${chip("pin", steer.pin.join(", "))}</div>`;
    if (steer.skip.length > 0) h += `<div>${chip("skip", steer.skip.join(", "))}</div>`;
    if (steer.notes.length > 0) {
      for (const n of steer.notes) {
        h += `<div><em>${ago(n.ts, now)}:</em> ${esc(n.text)}</div>`;
      }
    }
    h += `</div>`;
  }

  // History
  const ended = sprints.filter((s) => s.end !== undefined).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 15);
  if (ended.length > 0) {
    h += `<div class="dr-section"><h3>History</h3>`;
    for (const s of ended) {
      const e = s.end!;
      h += `<div class="dr-sprint">`;
      h += `<div>${chip("id", s.id)} ${chip("outcome", e.outcome)} ${chip("min", String(s.minutes))}</div>`;
      h += `<div><strong>${esc(s.title)}</strong></div>`;
      h += `<div>finding: ${esc(e.finding)}</div>`;
      if (e.mission) {
        h += `<div>↗ ${esc(e.mission)}</div>`;
      }
      h += `</div>`;
    }
    h += `</div>`;
  }

  h += `</div>`;
  return h;
}
