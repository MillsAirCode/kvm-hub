/**
 * Map an opaque session id (e.g. "agent-main-telegram-dm-5913219338" or
 * "20260425_170911_cfe162a0") to a stable, human-readable nickname like
 * "purple-talking-fox" or "twinkly-hugging-dragon".
 *
 * Pure function: same input → same output, no state.
 */

const ADJ1 = [
  "purple", "amber", "scarlet", "twinkly", "midnight", "azure", "violet",
  "crimson", "neon", "mossy", "frosty", "golden", "iron", "indigo", "obsidian",
  "lavender", "rusted", "shimmery", "thundering", "gentle",
];

const ADJ2 = [
  "talking", "humming", "dancing", "wandering", "scheming", "dreaming",
  "calculating", "leaping", "whispering", "weaving", "drifting", "soaring",
  "pondering", "tinkering", "grinning", "loitering", "skulking", "pacing",
  "hugging", "winking",
];

const NOUNS = [
  "fox", "dragon", "owl", "raccoon", "octopus", "panther", "moth", "salmon",
  "yak", "lemur", "raven", "stoat", "wombat", "axolotl", "narwhal", "ferret",
  "gecko", "tapir", "manta", "puffin",
];

function hash(s: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function sessionNickname(id: string): string {
  if (!id) return "anonymous";
  const h = hash(id);
  const a1 = ADJ1[h % ADJ1.length];
  const a2 = ADJ2[Math.floor(h / ADJ1.length) % ADJ2.length];
  const n = NOUNS[Math.floor(h / (ADJ1.length * ADJ2.length)) % NOUNS.length];
  return `${a1}-${a2}-${n}`;
}
