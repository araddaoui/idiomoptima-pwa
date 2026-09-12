#!/usr/bin/env node
// Deterministic database enrichment for IdiomOptima (NativeWrite).
//
// Appends curated stiff->natural equivalence pairs to the served databases so
// the worker's deterministic pass actually FIRES on common real-world phrasing.
// Re-running is safe: every entry is deduped against the existing lowercase key
// (client merges ai files by lowercase key preferring the longest entry; lexical
// files are per-domain arrays of {clunky, native, type}).
//
// Rationale / safety rules baked into the additions:
//   - No bare single words except existing behavior (the worker gates <2 words).
//   - Targets chosen so word-boundary substitution can never break grammar or
//     flip register downward (academic additions stay formal).
//   - The "in general / in particular" correlative pair is deliberately NOT
//     added: the worker stoplist already blocks those phrases.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
function load(f) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "public", f), "utf8"));
}
function save(f, data) {
  fs.writeFileSync(path.join(ROOT, "public", f), JSON.stringify(data, null, 2) + "\n", "utf8");
}

// {ai, natural} shape for the merged ai-natural-database.json family.
const AI_NATURAL_ADDITIONS = [
  // --- universal discourse friction -------------------------------------
  { ai: "when it comes to", natural: "regarding" },
  { ai: "by virtue of", natural: "through" },
  { ai: "in conjunction with", natural: "with" },
  { ai: "in light of the fact that", natural: "given that" },
  { ai: "in the event that", natural: "if" },
  { ai: "at the end of the day", natural: "ultimately" },
  { ai: "in a nutshell", natural: "in short" },
  { ai: "it goes without saying that", natural: "clearly" },
  { ai: "in today's fast-paced world", natural: "today" },
  { ai: "in the ever-evolving landscape of", natural: "in the changing world of" },
  { ai: "in this day and age", natural: "today" },
  { ai: "more often than not", natural: "usually" },
  { ai: "time and time again", natural: "repeatedly" },
  { ai: "needless to say", natural: "obviously" },
  { ai: "last but not least", natural: "finally" },
  { ai: "first and foremost", natural: "primarily" },

  // --- single-word-risk hedging: phrase-level, not bare words ------------
  { ai: "play a pivotal role in", natural: "play a key role in" },
  { ai: "plays a pivotal role", natural: "plays a key role" },
  { ai: "plays a crucial role in", natural: "is key to" },
  { ai: "underscores the importance of", natural: "highlights the importance of" },
  { ai: "underscores the value of", natural: "highlights the value of" },
  { ai: "serves as a testament to", natural: "reflects" },
  { ai: "deep dive into", natural: "thorough look at" },
  { ai: "actionable insights", natural: "practical insights" },
  { ai: "unlock the potential of", natural: "make the most of" },
  { ai: "harness the power of", natural: "use" },
  { ai: "in the pipeline", natural: "underway" },
  { ai: "move the needle", natural: "make a difference" },
  { ai: "low-hanging fruit", natural: "quick wins" },
  { ai: "think outside the box", natural: "think creatively" },
  { ai: "a plethora of", natural: "a host of" },
  { ai: "take into consideration", natural: "consider" },
  { ai: "make significant strides", natural: "make great progress" },
  { ai: "significant strides", natural: "great progress" },
  { ai: "in light of the aforementioned", natural: "given the above" },

  // --- academic register (safe in every domain) --------------------------
  { ai: "delve into", natural: "explore" },
  { ai: "delves into", natural: "examines" },
  { ai: "fosters a culture of", natural: "encourages a culture of" },
  { ai: "fostering a culture of", natural: "encouraging a culture of" },
  { ai: "came to the conclusion that", natural: "concluded that" },
  { ai: "comes to the conclusion that", natural: "concludes that" },
  { ai: "it can be argued that", natural: "arguably" },
  { ai: "it is evident that", natural: "clearly" },
  { ai: "it is apparent that", natural: "clearly" },
  { ai: "prior to", natural: "before" },
  { ai: "subsequent to", natural: "after" },
  { ai: "in the course of", natural: "during" },
  { ai: "throughout the course of", natural: "throughout" },
  { ai: "in the midst of", natural: "amid" },
  { ai: "in the absence of", natural: "without" },
  { ai: "germane to", natural: "relevant to" },
  { ai: "pertinent to", natural: "relevant to" },
  { ai: "extant literature", natural: "existing research" },
  { ai: "is predicated on", natural: "depends on" },
  { ai: "is contingent upon", natural: "depends on" },
  { ai: "is of paramount importance", natural: "is essential" },
  { ai: "is of great significance", natural: "is important" },
  { ai: "plays a fundamental role in", natural: "is central to" },
  { ai: "plays a part in", natural: "contributes to" },
  { ai: "exerts a significant influence on", natural: "strongly influences" },
  { ai: "has a marked impact on", natural: "markedly affects" },
  { ai: "inter alia", natural: "among other things" },
  { ai: "lends itself to", natural: "is well suited to" },
  { ai: "I am of the view that", natural: "I believe that" },
  { ai: "we are of the view that", natural: "we believe that" },
  { ai: "on the grounds that", natural: "because" },
  { ai: "in an effort to", natural: "to" },
  { ai: "owing to the fact that", natural: "because" },
  { ai: "irrespective of", natural: "regardless of" },
];

// {clunky, native, type} per-domain arrays.
const LEXICAL_ADDITIONS = {
  academic: [
    // Directly targets the user's sample paragraph.
    { clunky: "it is like saying", native: "it is akin to saying", type: "Phrase" },
    { clunky: "does not have much to do with", native: "bears little relation to", type: "Phrase" },
    { clunky: "do not have much to do with", native: "bear little relation to", type: "Phrase" },
    { clunky: "better suited for", native: "better suited to", type: "Phrase" },
    { clunky: "generally oblivious to", native: "largely unaware of", type: "Phrase" },
    // Other high-value academic awkwardness.
    { clunky: "in light of the aforementioned findings", native: "given the findings above", type: "Phrase" },
    { clunky: "previous studies have shown that", native: "earlier studies show that", type: "Phrase" },
    { clunky: "extensive research has shown that", native: "research shows that", type: "Phrase" },
    { clunky: "a considerable body of literature", native: "much of the research", type: "Phrase" },
    { clunky: "the findings of this study suggest that", native: "these findings suggest that", type: "Phrase" },
    { clunky: "there is a growing recognition that", native: "there is growing awareness that", type: "Phrase" },
    { clunky: "a significant component of", native: "a large part of", type: "Phrase" },
  ],
  business: [
    { clunky: "it is very important to note that", native: "note that", type: "Phrase" },
    { clunky: "we are excited to", native: "we are pleased to", type: "Phrase" },
    { clunky: "get the ball rolling", native: "get started", type: "Idiom" },
    { clunky: "hit the ground running", native: "make quick progress", type: "Idiom" },
    { clunky: "touch base with", native: "check in with", type: "Idiom" },
    { clunky: "circle back to", native: "return to", type: "Idiom" },
    { clunky: "circle back on", native: "return to", type: "Idiom" },
    { clunky: "keep me in the loop", native: "keep me informed", type: "Idiom" },
    { clunky: "have the bandwidth to", native: "have the capacity to", type: "Idiom" },
    { clunky: "in tandem with", native: "alongside", type: "Phrase" },
    { clunky: "robust growth", native: "strong growth", type: "Phrase" },
    { clunky: "fast-track the", native: "speed up the", type: "Phrase" },
    { clunky: "kick off", native: "start", type: "Phrase" },
    { clunky: "wrap up", native: "finish", type: "Phrase" },
    { clunky: "zero in on", native: "focus on", type: "Idiom" },
    { clunky: "value-add", native: "benefit", type: "Phrase" },
    { clunky: "game plan", native: "plan", type: "Phrase" },
    { clunky: "ballpark figure", native: "rough estimate", type: "Phrase" },
    { clunky: "drill down into", native: "look closely at", type: "Phrase" },
    { clunky: "high-level overview", native: "overview", type: "Phrase" },
    { clunky: "in the interim", native: "meanwhile", type: "Phrase" },
  ],
  creative: [
    { clunky: "she was very tired", native: "she was utterly exhausted", type: "Phrase" },
    { clunky: "he ran very fast", native: "he sprinted", type: "Phrase" },
    { clunky: "she felt very happy", native: "she felt elated", type: "Phrase" },
    { clunky: "he was very angry", native: "he was seething", type: "Phrase" },
    { clunky: "the sky was very beautiful", native: "the sky was breathtaking", type: "Phrase" },
    { clunky: "they were very surprised", native: "they were stunned", type: "Phrase" },
    { clunky: "the food was very good", native: "the food was delicious", type: "Phrase" },
    { clunky: "it was raining heavily", native: "rain lashed the streets", type: "Phrase" },
    { clunky: "she walked very fast", native: "she hurried", type: "Phrase" },
    { clunky: "the market was very crowded", native: "the market was teeming with people", type: "Phrase" },
    { clunky: "he spoke very quietly", native: "he whispered", type: "Phrase" },
    { clunky: "the problem is very hard", native: "the problem is intractable", type: "Phrase" },
    { clunky: "she was very interested", native: "she was intrigued", type: "Phrase" },
    { clunky: "the room was very quiet", native: "silence hung in the room", type: "Phrase" },
    { clunky: "the night was very dark", native: "darkness pressed in on all sides", type: "Phrase" },
  ],
  general: [
    { clunky: "at this point in time", native: "now", type: "Phrase" },
    { clunky: "at the present time", native: "now", type: "Phrase" },
    { clunky: "in the near future", native: "soon", type: "Phrase" },
    { clunky: "a lot of times", native: "often", type: "Phrase" },
    { clunky: "in today's world", native: "nowadays", type: "Phrase" },
    { clunky: "until such time as", native: "until", type: "Phrase" },
    { clunky: "on account of", native: "because of", type: "Phrase" },
    { clunky: "owing to", native: "because of", type: "Phrase" },
    { clunky: "regardless of the fact that", native: "even though", type: "Phrase" },
    { clunky: "in the neighborhood of", native: "about", type: "Phrase" },
    { clunky: "the vast majority of", native: "most", type: "Phrase" },
    { clunky: "as a matter of fact", native: "in fact", type: "Phrase" },
    { clunky: "over the course of time", native: "over time", type: "Phrase" },
    { clunky: "more likely than not", native: "probably", type: "Phrase" },
    { clunky: "down the road", native: "later", type: "Idiom" },
    { clunky: "out of the blue", native: "unexpectedly", type: "Idiom" },
  ],
};

function dedupeAdditions(existing, additions, sourceKey) {
  const seen = new Set(existing.map((e) => String(e[sourceKey] || "").toLowerCase().trim()).filter(Boolean));
  let added = 0;
  const out = existing.slice();
  for (const a of additions) {
    const k = String(a[sourceKey] || "").toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
    added++;
  }
  return { out, added };
}

// Removes inert junk rows: empty source/target or source === target
// (case-insensitive). The worker already skips these at buildNativizationMaps,
// but keeping the files clean avoids wasted payload weight.
function pruneJunk(existing, sourceKey, targetKey) {
  const out = existing.filter((e) => {
    const src = String(e[sourceKey] || "").trim();
    const tgt = String(e[targetKey] || "").trim();
    return src && tgt && src.toLowerCase() !== tgt.toLowerCase();
  });
  return { out, pruned: existing.length - out.length };
}

let totalAdded = 0;

// 1) ai-natural-database.json (the merged family's authoritative longest file).
{
  const file = "ai-natural-database.json";
  let existing = load(file);
  const { out, added } = dedupeAdditions(existing, AI_NATURAL_ADDITIONS, "ai");
  const { out: cleaned, pruned } = pruneJunk(out, "ai", "natural");
  save(file, cleaned);
  totalAdded += added;
  console.log(`${file}: +${added} new, pruned ${pruned} idempotent/empty (len ${existing.length} -> ${cleaned.length})`);
}

// 1b) the two smaller ai-natural files ({clunky, native} shape) — prune only,
//     they are fallback tiers of the main file, not edited directly.
for (const file of ["ai-natural-database-1500.json", "ai-natural-database-1000.json"]) {
  const existing = load(file);
  const { out: cleaned, pruned } = pruneJunk(existing, "clunky", "native");
  save(file, cleaned);
  totalAdded += 0;
  console.log(`${file}: pruned ${pruned} idempotent/empty (len ${existing.length} -> ${cleaned.length})`);
}

// 2) per-domain lexical files.
for (const [domain, additions] of Object.entries(LEXICAL_ADDITIONS)) {
  const file = `lexical-${domain}.json`;
  let existing = load(file);
  const { out, added } = dedupeAdditions(existing, additions, "clunky");
  const { out: cleaned, pruned } = pruneJunk(out, "clunky", "native");
  save(file, cleaned);
  totalAdded += added;
  console.log(`${file}: +${added} new, pruned ${pruned} idempotent/empty (len ${existing.length} -> ${cleaned.length})`);
}

console.log(`Total new entries: ${totalAdded}`);