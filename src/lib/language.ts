// English-only guard for IdiomOptima. This module is mirrored verbatim in
// index.js (the single-file Worker can't import from src). Keep both copies
// in sync — same constants, same logic, same thresholds.
//
// Deliberately conservative: short texts pass through, and the Latin-script
// heuristic requires BOTH a high accent density AND a low English function-word
// rate so English prose with loanwords, names, or citations isn't blocked.

const ENGLISH_FUNCTION_WORDS = [
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "as", "is", "are", "was", "were", "be", "been", "it",
  "this", "that", "his", "her", "its", "you", "your", "we", "they", "have",
  "has", "had", "will", "would", "can", "not", "no", "there", "their",
];

export const ENGLISH_ONLY_MESSAGE =
  "IdiomOptima only transforms English texts. Write or paste your text in English and try again.";

export function looksNonEnglish(text: string): boolean {
  if (!text) return false;

  // Honest text: strip ** markup and drop footnote/citation reference lines,
  // mirroring the word-count helper used by the badge and free-tier pre-gate.
  const cleaned = text
    .replace(/\*\*/g, " ")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*(\[\d+\]|Ibid\.?)(?:\s|$)/i.test(line))
    .join(" ");

  const tokens = cleaned.trim().split(/\s+/).filter(Boolean);

  const allLetters = (cleaned.match(/\p{L}/gu) || []).length;
  if (allLetters === 0) return false;
  const latin = (cleaned.match(/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/g) || []).length;
  const foreign = allLetters - latin;

  // Non-Latin script (Arabic, Cyrillic, CJK, Hangul, Kana, ...) is a decisive
  // signal, checked before the word-count guard because CJK has no separators.
  if (foreign / allLetters > 0.25) return true;

  // Too short (and word-separable) for a reliable verdict.
  if (tokens.length < 15) return false;

  const diacritics = (cleaned.match(/[\u00C0-\u00FF\u0100-\u017F\u1E00-\u1EFF]/g) || []).length;
  let stopHits = 0;
  for (const raw of tokens) {
    const tok = raw.replace(/[^A-Za-z\u00C0-\u024F\u1E00-\u1EFF']/g, "").toLowerCase();
    if (tok && ENGLISH_FUNCTION_WORDS.indexOf(tok) !== -1) stopHits++;
  }
  const stopRate = stopHits / tokens.length;
  const diacriticRate = diacritics / allLetters;

  // German-style low accent density is caught by its umlauts (ä ö ü ß);
  // French/Spanish density clears the rate threshold.
  return (diacriticRate > 0.015 || /[äöüß]/i.test(cleaned)) && stopRate < 0.12;
}