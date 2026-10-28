export type Steer = {
  pin: string[];
  skip: string[];
  notes: { ts: string; text: string }[];
};

const BEAD_ID_RE = /^[a-z0-9]+-[a-z0-9.]+$/i;

export function applySteer(
  s: Steer,
  f: { action: string; id?: string; text?: string },
  now = new Date()
): Steer | string {
  const id = (f.id ?? "").trim();
  const text = (f.text ?? "").trim();

  switch (f.action) {
    case "pin":
    case "skip":
    case "unpin":
    case "unskip": {
      if (!BEAD_ID_RE.test(id)) return "bad bead id";

      const pin = [...s.pin];
      const skip = [...s.skip];

      switch (f.action) {
        case "pin": {
          if (pin.includes(id)) return { pin, skip: [...skip], notes: [...s.notes] };
          const i = skip.indexOf(id);
          if (i !== -1) skip.splice(i, 1);
          pin.push(id);
          break;
        }
        case "skip": {
          if (skip.includes(id)) return { pin: [...pin], skip, notes: [...s.notes] };
          const i = pin.indexOf(id);
          if (i !== -1) pin.splice(i, 1);
          skip.push(id);
          break;
        }
        case "unpin": {
          const i = pin.indexOf(id);
          if (i !== -1) pin.splice(i, 1);
          break;
        }
        case "unskip": {
          const i = skip.indexOf(id);
          if (i !== -1) skip.splice(i, 1);
          break;
        }
      }

      return { pin, skip, notes: [...s.notes] };
    }

    case "note": {
      if (text.length < 1 || text.length > 2000) return "note must be 1\u20132000 chars";
      const notes = [...s.notes, { ts: now.toISOString(), text }];
      return { pin: [...s.pin], skip: [...s.skip], notes };
    }

    case "clearnotes": {
      return { pin: [...s.pin], skip: [...s.skip], notes: [] };
    }

    default:
      return "unknown action";
  }
}
