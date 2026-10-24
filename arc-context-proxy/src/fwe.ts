// RULER FWE: plant words at known frequencies in a haystack of noise words,
// ask for the most common. Exact-match scored, unanswerable from top-k retrieval.
// ponytail: seeded LCG instead of a PRNG dep — reproducible prompt sets matter more than statistical quality.

export type FweItem = { prompt: string; answer: string[]; words: number };

const SYL = "ka to ne mi ra su lo bi ta ze nu vi ko sa re mo pi da lu he".split(" ");

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function word(rnd: () => number) {
  const n = 2 + Math.floor(rnd() * 2);
  let w = "";
  for (let i = 0; i < n; i++) w += SYL[Math.floor(rnd() * SYL.length)];
  return w;
}

/**
 * One FWE item. `words` sets haystack size (~1.56 tokens/word on this backend).
 * Three planted words at clearly separated frequencies; the answer is the top 3 in order.
 */
export function makeItem(seed: number, words: number): FweItem {
  const rnd = lcg(seed);

  const vocab = new Set<string>();
  while (vocab.size < 60) vocab.add(word(rnd));
  const all = [...vocab];
  const planted = all.slice(0, 3);
  const noise = all.slice(3);

  // Frequencies well outside noise: noise words land ~words/57 each.
  const base = Math.max(6, Math.floor(words / 57));
  const freqs = [base * 6, base * 4, base * 2];

  const tokens: string[] = [];
  planted.forEach((w, i) => { for (let j = 0; j < freqs[i]; j++) tokens.push(w); });
  while (tokens.length < words) tokens.push(noise[Math.floor(rnd() * noise.length)]);

  // Fisher-Yates so planted words are spread, not clustered at the front.
  for (let i = tokens.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
  }

  const prompt =
    `Below is a list of words. Some appear far more often than others.\n\n` +
    `${tokens.join(" ")}\n\n` +
    `Which 3 words appear most often? Answer with exactly 3 words, most frequent first, ` +
    `separated by commas. No other text.`;

  return { prompt, answer: planted, words: tokens.length };
}

/**
 * Partial credit: fraction of the 3 answers correct at the right rank.
 * Models prefix replies with filler ("The answer is: ..."), so keep only tokens
 * that are actual vocabulary words. Vocabulary is syllable-built, so English
 * filler never collides with it.
 */
export function score(reply: string, answer: string[]): number {
  const lower = answer.map((w) => w.toLowerCase());
  const got = reply.toLowerCase().match(/[a-z]+/g) ?? [];

  // Strip only leading filler; once the first vocabulary word appears, every
  // subsequent token counts positionally so a junk guess costs its slot
  // instead of silently promoting the words behind it.
  const start = got.findIndex((w) => lower.includes(w));
  const guess = start === -1 ? [] : got.slice(start, start + 3);

  let hits = 0;
  for (let i = 0; i < 3; i++) if (guess[i] === lower[i]) hits++;
  return hits / 3;
}
