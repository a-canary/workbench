import { describe, expect, test } from "bun:test";
import { ago, esc, fmt, sparkline } from "./fmt";

const now = Date.parse("2026-10-28T12:00:00Z");

describe("ago", () => {
  test("minutes under 1h, hours under 48h, else days", () => {
    expect(ago("2026-10-28T11:55:00Z", now)).toBe("5m ago");
    expect(ago("2026-10-28T11:01:00Z", now)).toBe("59m ago");
    expect(ago("2026-10-28T09:00:00Z", now)).toBe("3h ago");
    expect(ago("2026-10-26T13:00:00Z", now)).toBe("47h ago");
    expect(ago("2026-10-25T12:00:00Z", now)).toBe("3d ago");
    expect(ago("", now)).toBe("");
    expect(ago("not a date", now)).toBe("");
  });
});

describe("fmt", () => {
  test("3 significant digits below 100, integer at or above", () => {
    expect(fmt(0.123456)).toBe("0.123");
    expect(fmt(12.345)).toBe("12.3");
    expect(fmt(-1.5)).toBe("-1.5");
    expect(fmt(2)).toBe("2");
    expect(fmt(123.6)).toBe("124");
    expect(fmt(-250.2)).toBe("-250");
  });
});

describe("esc", () => {
  test("escapes the five HTML-special characters", () => {
    expect(esc(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
    expect(esc("plain")).toBe("plain");
  });
});

describe("sparkline", () => {
  test("empty for fewer than 2 finite samples", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([1, NaN, Infinity])).toBe("");
  });
  test("svg polyline scaled into the box, higher value drawn higher", () => {
    const s = sparkline([0, 10], 10, 6);
    expect(s).toStartWith('<svg class=lens-spark viewBox="0 0 10 6"');
    expect(s).toContain('aria-label="2 samples, latest 10"');
    expect(s).toContain('points="1.0,5.0 9.0,1.0"');
  });
  test("flat series does not divide by zero", () => {
    expect(sparkline([3, 3, 3], 10, 6)).toContain('points="1.0,5.0 5.0,5.0 9.0,5.0"');
  });
});
