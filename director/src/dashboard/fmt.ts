export function ago(ts: string, now: number): string {
  const m = Math.round((now - Date.parse(ts)) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 2880) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function fmt(n: number): string {
  if (Math.abs(n) >= 100) return n.toFixed(0);
  return Number(n.toPrecision(3)).toString();
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sparkline(raw: number[], w = 64, h = 16): string {
  const vals = raw.filter((v) => Number.isFinite(v));
  const len = vals.length;
  if (len < 2) return "";
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const last = vals[len - 1];
  const pts = vals
    .map((v, i) => {
      const x = (i / (len - 1)) * (w - 2) + 1;
      const y = h - 1 - ((v - lo) / span) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class=lens-spark viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${len} samples, latest ${last}"><polyline fill="none" stroke="currentColor" stroke-width="1" points="${pts}"/></svg>`;
}
