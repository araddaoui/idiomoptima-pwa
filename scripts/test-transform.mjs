#!/usr/bin/env node
// Mother-of-all transformation tests for IdiomOptima (NativeWrite).
//
// Exercises the REAL worker functions (buildNativizationMaps,
// applyDatabaseNativization, replaceOutsideQuotes, normalizeSentenceKey,
// escapeRegExp) extracted verbatim from the current index.js, fed with the
// SAME merged databases the client ships.
//
// Coverage:
//   1. Reproduced user sample (academic) — real transformations fire, paired
//      "in general … in particular" stays byte-identical.
//   2. Correlative-collocation safety ("in general" fires ONLY unpaired).
//   3. Single-word allowlist (fires for curated words, stays blocked otherwise).
//   4. Per-domain sweeps (business / general / creative).
//   5. Pass-2 pure-DB layer (no builtin rules; DB phrases are the only editor).
//   6. Quote safety (never rewrite inside quotation marks).
//   7. Database health (sizes, shapes, no idempotent/empty/dangerous entries).
//   8. "DIFFERENCE IS MADE" SWEEP: deterministically sample the live
//      gate-filtered maps and prove each active phrase consumes its source in a
//      carrier sentence. Reports a fire-rate per domain — the internal metric
//      for "is any difference being made".
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_SRC = readFileSync(join(ROOT, "index.js"), "utf8");
const SWEEP_CAP = Number(process.env.SWEEP_CAP || 200);

// --- minimal token-aware block extractor ------------------------------------
function isIdentOrDigit(c) {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}
function skipString(src, i, quote) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === quote) return i + 1;
    i++;
  }
  return i;
}
function skipTemplate(src, i) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && src[i + 1] === "{") { i = extractBalanced(src, i + 1, "{"); continue; }
    i++;
  }
  return i;
}
function skipRegex(src, i) {
  i++;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    else if (c === "\n") return i;
    i++;
  }
  return i;
}
function isRegexStart(prev) {
  return prev === undefined || /[([{,;:?=!&|+\-*%^~<>]/.test(prev);
}
function extractBalanced(src, openIdx, openCh) {
  const closeCh = openCh === "{" ? "}" : openCh === "[" ? "]" : ")";
  let depth = 0;
  let i = openIdx;
  let prev = "";
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "\r" || c === "\n" || c === " " || c === "\t") { i++; continue; }
    if (c === "/" && c2 === "/") {
      const e = src.indexOf("\n", i);
      if (e === -1) return src.slice(openIdx, src.length);
      i = e + 1;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e === -1) return src.slice(openIdx, src.length);
      i = e + 2;
      continue;
    }
    if (c === '"' || c === "'") { i = skipString(src, i, c); prev = "s"; continue; }
    if (c === "`") { i = skipTemplate(src, i); prev = "s"; continue; }
    if (c === "/" && isRegexStart(prev)) { i = skipRegex(src, i); prev = "s"; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
    if (c === "(") prev = "(";
    else if (c === "{") prev = "{";
    else if (c === "}") prev = "}";
    else if (c === ")") prev = ")";
    else if (c === "[") prev = "[";
    else if (c === "]") prev = "]";
    else if (c === "," || c === ";" || c === ":" || c === "=" || c === "?") prev = c;
    else if (isIdentOrDigit(c)) {
      const m = /[A-Za-z0-9_$]+/.exec(src.slice(i));
      i += m[0].length - 1;
      prev = "id";
    } else prev = c;
    i++;
  }
  throw new Error(`unbalanced block starting at ${openIdx}`);
}
function extractFunction(src, name) {
  const anchor = src.indexOf(`function ${name}(`);
  if (anchor === -1) throw new Error(`function ${name} not found in index.js`);
  const openIdx = src.indexOf("{", anchor);
  const paramsStart = anchor + "function ".length + name.length;
  return "function " + name + src.slice(paramsStart, openIdx) + extractBalanced(src, openIdx, "{");
}
function extractVarObject(src, name) {
  const anchor = src.indexOf(`var ${name} = {`);
  if (anchor === -1) throw new Error(`var ${name} = { not found in index.js`);
  const end = src.indexOf("\n};", anchor);
  if (end === -1) throw new Error(`end of var ${name} not found`);
  return src.slice(anchor, end + 3);
}
function extractVar(src, name) {
  const anchor = src.indexOf(`var ${name} =`);
  if (anchor === -1) throw new Error(`var ${name} not found in index.js`);
  const openIdx = src.indexOf("[", anchor);
  return `var ${name} =` + extractBalanced(src, openIdx, "[");
}

function extractVariableDecls(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return src.slice(start, end).trim();
}

const extracted = [
  extractVariableDecls(
    INDEX_SRC,
    "// --- Deterministic nativization gates",
    "// Builds deterministic nativization maps"
  ),
  extractFunction(INDEX_SRC, "escapeRegExp"),
  extractFunction(INDEX_SRC, "normalizeSentenceKey"),
  extractFunction(INDEX_SRC, "replaceOutsideQuotes"),
  extractFunction(INDEX_SRC, "buildNativizationMaps"),
  extractVarObject(INDEX_SRC, "SEMANTIC_FUNCTION_WORDS"),
  extractFunction(INDEX_SRC, "addedContentWords"),
  extractFunction(INDEX_SRC, "applyDatabaseNativization"),
].join("\n");

const api = new Function(
  extracted + "\n;return { DEFAULT_DATABASES, escapeRegExp, normalizeSentenceKey, replaceOutsideQuotes, buildNativizationMaps, applyDatabaseNativization, boldHeadingSentences, addedContentWords };"
)();

// --- load + merge databases exactly like the client (ToolPage) ---------------
function loadJson(f) {
  return JSON.parse(readFileSync(join(ROOT, "public", f), "utf8"));
}
function buildAiDb() {
  const merged = new Map();
  for (const f of ["ai-natural-database.json", "ai-natural-database-1500.json", "ai-natural-database-1000.json"]) {
    for (const entry of loadJson(f)) {
      const key = String(entry.ai || entry.clunky || "").toLowerCase().trim();
      if (key && (entry.natural || entry.native)) {
        const existing = merged.get(key);
        if (!existing || JSON.stringify(entry).length > JSON.stringify(existing).length) merged.set(key, entry);
      }
    }
  }
  return Array.from(merged.values());
}
function buildLexicalDb() {
  const out = {};
  for (const d of ["academic", "business", "creative", "general"]) out[d] = loadJson(`lexical-${d}.json`);
  return out;
}
function buildDbs() {
  return {
    aiDb: buildAiDb(),
    idiomDb: loadJson("idioms-clunky-native.json"),
    lexicalDb: buildLexicalDb(),
  };
}

const DBS = buildDbs();

function transform(sentences, domain = "general") {
  const input = sentences.map((original) => ({ original, revised: original, paragraphIndex: 0 }));
  const result = api.applyDatabaseNativization(input, DBS, domain);
  return { revised: result.sentences.map((s) => s.revised), stats: result.stats };
}
function containsPhrase(text, phrase) {
  return new RegExp("\\b" + api.escapeRegExp(phrase) + "\\b", "i").test(String(text || ""));
}

// --- tiny assert runner ------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  if (ok) {
    pass++;
    console.log(`  ok - ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL - ${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}

// ================================================================ 1. ACADEMIC
section("1. academic: reproduced user sample (the reported 95->95 no-op)");
{
  const { revised, stats } = transform(
    [
      "Authoritarian backsliding in the developing world in general and the MENA region in particular is often treated as an externality.",
      "It is like saying that a fire department is the solution to arson.",
      "This comparison does not have much to do with building genuine legitimacy.",
      "There is an explicit assumption that domestic affairs do not have much to do with foreign policy.",
      "These frameworks are better suited for analyzing formal institutions than lived politics.",
      "Public opinion under newer surveillance states is generally oblivious to the strategic dimension of digital control.",
    ],
    "academic"
  );
  check("It is like saying -> It is akin to saying", revised[1], "It is akin to saying that a fire department is the solution to arson.");
  check("does not have much to do with -> bears little relation to", revised[2], "This comparison bears little relation to building genuine legitimacy.");
  check("user phrasing 'do not have much to do with' -> bear little relation to", revised[3], "There is an explicit assumption that domestic affairs bear little relation to foreign policy.");
  check("better suited for -> better suited to", revised[4], "These frameworks are better suited to analyzing formal institutions than lived politics.");
  check("generally oblivious to -> largely unaware of", revised[5], "Public opinion under newer surveillance states is largely unaware of the strategic dimension of digital control.");
  check("paired 'in general ... in particular' sentence left intact (collocation lock)", revised[0], "Authoritarian backsliding in the developing world in general and the MENA region in particular is often treated as an externality.");
  check("sentencesChanged >= 4", stats.sentencesChanged >= 4, true);
  check("totalMatches >= 4", stats.totalMatches >= 4, true);
}

// ================================================================ 2. CORRELATIVES
section("2. correlative safety: 'in general' fires ONLY unpaired; 'in particular' stays blocked");
{
  const { revised } = transform(
    [
      "In general, the results confirm the hypothesis.",
      "This pattern holds in general, not just in the sample.",
      "The MENA region, in particular, faces fiscal pressure.",
    ],
    "academic"
  );
  check("sentence-start 'In general,' -> 'Generally,' (unpaired)", revised[0], "Generally, the results confirm the hypothesis.");
  check("mid-sentence 'in general' -> 'generally' (unpaired)", revised[1], "This pattern holds generally, not just in the sample.");
  check("'in particular' ALWAYS stays blocked", revised[2], "The MENA region, in particular, faces fiscal pressure.");
}

// ================================================================ 3. SINGLE WORDS
section("3. single-word allowlist: curated words fire, others stay gated");
{
  const { revised } = transform(
    [
      "Our workflow is seamless and fully automated.",
      "Optimize the query before the deadline.",
      "These tools enable users to publish directly.",
      "We will surface the issue tomorrow.",
      "Please navigate to the account page.",
      "We execute and then review the pipeline.",
    ],
    "general"
  );
  check("seamless -> smooth (allowlisted)", revised[0], "Our workflow is smooth and fully automated.");
  check("optimize -> improve (allowlisted, sentence-start)", revised[1], "Improve the query before the deadline.");
  check("enable -> allow (allowlisted)", revised[2], "These tools allow users to publish directly.");
  check("surface NOT allowlisted -> unchanged", revised[3], "We will surface the issue tomorrow.");
  check("navigate NOT allowlisted -> unchanged", revised[4], "Please navigate to the account page.");
  check("bare 'execute' NOT allowlisted -> unchanged (no 'execute the plan' phrase present)", revised[5], "We execute and then review the pipeline.");
}

// ================================================================ 4. DOMAINS
section("4. per-domain sweeps");
{
  const { revised } = transform(
    [
      "We are excited to launch the platform next week.",
      "Let's touch base with the client before shipping.",
      "The rollout delivered robust growth for the quarter.",
    ],
    "business"
  );
  check("business: we are excited to -> we are pleased to", revised[0], "We are pleased to launch the platform next week.");
  check("business: touch base with -> check in with", revised[1], "Let's check in with the client before shipping.");
  check("business: robust growth -> strong growth", revised[2], "The rollout delivered strong growth for the quarter.");
}
{
  const { revised } = transform(
    [
      "When it comes to pricing, we have to consider the margins.",
      "By virtue of its location, the port thrived.",
      "The plan was accepted in light of the fact that costs were falling.",
      "At this point in time, let's review the budget.",
      "The vast majority of users never reach the second stage.",
    ],
    "general"
  );
  check("general: when it comes to -> regarding (start-cap)", revised[0], "Regarding pricing, we have to consider the margins.");
  check("general: by virtue of -> through", revised[1], "Through its location, the port thrived.");
  check("general: in light of the fact that -> given that", revised[2], "The plan was accepted given that costs were falling.");
  check("general: at this point in time -> now", revised[3], "Now, let's review the budget.");
  check("general: the vast majority of -> most", revised[4], "Most users never reach the second stage.");
}
{
  const { revised } = transform(
    [
      "She felt very happy about the outcome.",
      "The sky was very beautiful that evening.",
    ],
    "creative"
  );
  check("creative: she felt very happy -> she felt elated", revised[0], "She felt elated about the outcome.");
  check("creative: the sky was very beautiful -> the sky was breathtaking", revised[1], "The sky was breathtaking that evening.");
}

// ================================================================ 5. PASS 2 DB-ONLY
section("5. pass-2 pure-DB layer: DB phrases are the ONLY editor (no builtin rules)");
{
  const { revised, stats } = transform([
    "The robust framework is ready for deployment.",
    "It is important to note that costs fell.",
    "Engineers routinely navigate these challenges in production.",
    "Despite of the evidence, the decision stood.",
    "They utilize the tool in weekly reviews.",
  ]);
  check("robust framework -> solid framework", revised[0], "The solid framework is ready for deployment.");
  check("it is important to note that -> note that (sentence-start cap)", revised[1], "Note that costs fell.");
  check("navigate these challenges -> handle these challenges", revised[2], "Engineers routinely handle these challenges in production.");
  check("'despite of' is NOT edited (builtin rules removed)", revised[3], "Despite of the evidence, the decision stood.");
  check("'utilize' is NOT edited (builtin rules removed)", revised[4], "They utilize the tool in weekly reviews.");
  check("3 DB rules fired (no template/builtin credit)", stats.totalMatches, 3);
}

// ================================================================ 6. QUOTES
section("6. quote safety: replacements never touch quoted spans");
{
  const { revised } = transform(
    [
      "He said \u2018this does not have much to do with the matter\u2019 but the claim is easy to test.",
      "When it comes to \u201cthe margins\u201d, we should wait.",
    ],
    "academic"
  );
  check("inside quoted phrase untouched", revised[0], "He said \u2018this does not have much to do with the matter\u2019 but the claim is easy to test.");
  check("outside swap lands, quoted span preserved", revised[1], "Regarding \u201cthe margins\u201d, we should wait.");
}

// ================================================================ 7. DATABASE HEALTH
section("7. database health & integrity");
{
  const ai = DBS.aiDb;
  const idiomDb = DBS.idiomDb;
  const acad = DBS.lexicalDb.academic;
  const acadKeys = new Set(acad.map((e) => String(e.clunky || "").toLowerCase()));

  check("ai-natural merged size >= 3500 (" + ai.length + ")", ai.length >= 3500, true);
  check("idioms db size is 2000", idiomDb.length, 2000);
  check("sample-target pairs present in lexical-academic", ["it is like saying", "does not have much to do with", "do not have much to do with", "better suited for", "generally oblivious to"].every((k) => acadKeys.has(k)), true);

  let empty = 0;
  let idempotent = 0;
  for (const e of [...ai, ...idiomDb, ...Object.values(DBS.lexicalDb).flat()]) {
    const src = String(e.ai || e.clunky || e.source || "");
    const tgt = String(e.natural || e.native || e.target || "");
    if (!src.trim() || !tgt.trim()) empty++;
    if (src.toLowerCase() === tgt.toLowerCase()) idempotent++;
  }
  check("no empty source/target entries", empty, 0);
  check("no idempotent (source === target) entries", idempotent, 0);
}

// ================================================================ 8. DIFFERENCE SWEEP
section("8. DIFFERENCE IS MADE — active-phrase fire-rate sweep (deterministic sample)");
{
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const domainOrder = ["general", "academic", "business", "creative"];
  let sampleTotal = 0;
  let firedTotal = 0;
  const offenders = [];

  for (const domain of domainOrder) {
    const maps = api.buildNativizationMaps(DBS, domain); // the REAL gate-filtered maps
    const list = maps.phraseList;
    if (list.length === 0) { console.log(`  (${domain}: no active phrases)`); continue; }

    // deterministic, reproducible sample
    const rng = mulberry32(0xc0ffee + domain.length);
    const idx = list.map((_, i) => i).sort(() => rng() - 0.5).slice(0, Math.min(SWEEP_CAP, list.length));
    const sampled = idx.map((i) => list[i]);

    let fired = 0;
    const misses = [];
    for (let b = 0; b < sampled.length; b += 25) {
      const batch = sampled.slice(b, b + 25);
      const carriers = batch.map((item) => `The report highlights that ${item.src} across the sector.`);
      const { revised } = transform(carriers, domain);
      batch.forEach((item, j) => {
        if (!containsPhrase(revised[j], item.src)) {
          fired++;
        } else {
          misses.push({ domain, src: item.src, out: revised[j] });
        }
      });
    }
    const rate = (fired / sampled.length) * 100;
    sampleTotal += sampled.length;
    firedTotal += fired;
    console.log(`  ${domain}: ${fired}/${sampled.length} active phrases consumed source (${rate.toFixed(1)}%)`);
    if (misses.length === 0) continue;
    for (const m of misses.slice(0, 15)) offenders.push(m);
  }

  const overallRate = (firedTotal / sampleTotal) * 100;
  console.log(`  OVERALL fire-rate: ${firedTotal}/${sampleTotal} = ${overallRate.toFixed(1)}% of active phrases produce a difference when present`);
  check("overall fire-rate >= 90%", overallRate >= 90, true);
  for (const m of offenders) {
    console.log(`    offender[${m.domain}] ${JSON.stringify(m.src)} -> ${JSON.stringify(m.out)}`);
  }
  if (offenders.length > 0 && fail === 0) {
    fail += 1;
    failures.push(`sweep: ${offenders.length} active phrases did not consume their source (see offender lines above)`);
  }
}

// ============================================ 9. SERVER-SIDE DEFAULT DB FLOOR
section("9. server-side DEFAULT_DATABASES floor (empty/absent client payload still fires)");
{
  const floor = api.DEFAULT_DATABASES;
  check("DEFAULT_DATABASES is defined on the worker", !!floor && typeof floor === "object", true);

  const { sentences: revised, stats } = api.applyDatabaseNativization(
    [
      { original: "It is like saying there are two distinct states.", revised: "It is like saying there are two distinct states.", paragraphIndex: 0 },
      { original: "These frameworks are better suited for analyzing developing states.", revised: "These frameworks are better suited for analyzing developing states.", paragraphIndex: 0 },
      { original: "Affairs do not have much to do with foreign policy.", revised: "Affairs do not have much to do with foreign policy.", paragraphIndex: 0 },
      { original: "They are generally oblivious to domestic factors.", revised: "They are generally oblivious to domestic factors.", paragraphIndex: 0 },
    ],
    floor,
    "academic"
  );
  check("floor: it is like saying -> akin (empty payload still fires)", revised[0].revised, "It is akin to saying there are two distinct states.");
  check("floor: better suited for -> better suited to", revised[1].revised, "These frameworks are better suited to analyzing developing states.");
  check("floor: do not have much to do with -> bear little relation to", revised[2].revised, "Affairs bear little relation to foreign policy.");
  check("floor: generally oblivious to -> largely unaware of", revised[3].revised, "They are largely unaware of domestic factors.");
  check("floor: stats.totalMatches >= 4", stats.totalMatches >= 4, true);

  // Regression: body prose that BEGINS with an inline "[N] " marker must still
  // be nativized (the derive step can glue "policy. [1] This approach..." so the
  // marker lands at sentence start; the footnote guard must not swallow it).
  const { sentences: marked } = api.applyDatabaseNativization(
    [
      { original: "[1] This approach is better suited for analysing developing states in general and the MENA region in particular.", revised: "[1] This approach is better suited for analysing developing states in general and the MENA region in particular.", paragraphIndex: 0 },
      { original: "[3] It is like saying there are two distinct states.", revised: "[3] It is like saying there are two distinct states.", paragraphIndex: 0 },
      { original: "[31] Nonneman, G. (2005). Analysing the foreign policies of the Middle East and North Africa: A conceptual framework. Routledge. https://doi.org/10.4324/9780203008829", revised: "[31] Nonneman, G. (2005). Analysing the foreign policies of the Middle East and North Africa: A conceptual framework. Routledge. https://doi.org/10.4324/9780203008829", paragraphIndex: 0 },
      { original: "[2] Ibid.", revised: "[2] Ibid.", paragraphIndex: 0 },
    ],
    floor,
    "academic"
  );
  check("floor: [1]-prefixed body prose still nativized (better suited for -> to)", marked[0].revised.includes("better suited to analysing"), true);
  check("floor: [3]-prefixed body prose still nativized (is like saying -> akin)", marked[1].revised.includes("It is akin to saying"), true);
  check("floor: author-year citation stays untouched", marked[2].revised, marked[2].original);
  check("floor: 'Ibid.' stays untouched", marked[3].revised, "[2] Ibid.");

  // Wiring guard: the request handler must fall back to DEFAULT_DATABASES.
  check(
    "handler falls back to DEFAULT_DATABASES when client payload is empty",
    /options\.databases = hasAnyDb \? clientDb : DEFAULT_DATABASES;/.test(INDEX_SRC),
    true
  );
}

// ============================================ 10. HEADING RE-BOLD (title fix)
section("10. boldHeadingSentences re-bolds titles the model may have stripped");
{
  const bh = (txt) => api.boldHeadingSentences([{ original: txt, revised: txt, paragraphIndex: 0 }])[0].revised;

  check("user title gets re-bolded", bh("Application & Adaptation to This Study"), "**Application & Adaptation to This Study**");
  check("already-bold heading left untouched", bh("**Application & Adaptation to This Study**"), "**Application & Adaptation to This Study**");
  check("question-form title alone on its line gets re-bolded", bh("Where does Use of Military Power Literature come from?"), "**Where does Use of Military Power Literature come from?**");
  {
    const twoInPara = (a, b) => [{ original: a, revised: a, paragraphIndex: 0 }, { original: b, revised: b, paragraphIndex: 0 }];
    check(
      "question sentence inside body prose stays plain",
      api.boldHeadingSentences(twoInPara("What does this mean for the analysis?", "The framework reframes the debate.")).map((s) => s.revised).join("|"),
      "What does this mean for the analysis?|The framework reframes the debate."
    );
  }
  check("sentence ending in '.' stays plain", bh("This is better suited to analysing the states."), "This is better suited to analysing the states.");
  check("'...following:' label stays plain (no colon bolding)", bh("At a minimum, the contextuality criterion requires an understanding of the following:"), "At a minimum, the contextuality criterion requires an understanding of the following:");
  check("footnote marker line stays plain", bh("[1] Nonneman, G. (2005). Routledge."), "[1] Nonneman, G. (2005). Routledge.");
  check("lowercase-starting line stays plain", bh("application & adaptation to this study"), "application & adaptation to this study");
  check("long body sentence (>= 15 words) stays plain", bh("Standard approaches to IR focus on a spectrum of notions such as the state, survival, cooperation, alliances, and wars"), "Standard approaches to IR focus on a spectrum of notions such as the state, survival, cooperation, alliances, and wars");

  // Added-word note parity: replacement words from a MATCHED DB rule are
  // whitelisted (p.tgt, not p.dst), so the Notes tab stops flagging the rule's
  // own replacements as "possibly invented detail".
  {
    const added = (orig, fin) =>
      api.addedContentWords(orig, fin, { databases: api.DEFAULT_DATABASES, domain: "academic" });
    const got = added(
      "The politicians took the decision. [1]",
      "The politicians made the decision. [1]"
    );
    check("DB-rule target word 'made' whitelisted in added-word notes", got.includes("made"), false);
    const got2 = added(
      "The use of military power takes the decision to go to war.",
      "The use of military power decides to go to war."
    );
    check("DB-rule target word 'decides' whitelisted in added-word notes", got2.includes("decides"), false);
    const got3 = added(
      "Their motives harks back to old beliefs and levels of certainty about winning.",
      "Their motives traces back to old beliefs and confidence in winning."
    );
    check("DB-rule target words 'traces'+'confidence' whitelisted", got3.includes("traces") || got3.includes("confidence"), false);
    const got4 = added(
      "Puts the use of power within reach.",
      "Places the use of power within reach."
    );
    check("non-covered model word 'places' still flagged in added-word notes", got4.includes("places"), true);
  }

  // Wiring guard: ensureValidResult must apply the pass before rebuild.
  check(
    "ensureValidResult applies boldHeadingSentences to sentences",
    /sentences = boldHeadingSentences\(sentences\);/.test(INDEX_SRC),
    true
  );
  check(
    "response carries a timing breakdown",
    /result\.timing = \{\s*provider: provider,\s*totalMs: Date\.now\(\) - providerStartMs,\s*attempts: attemptTimes,\s*\};/.test(INDEX_SRC),
    true
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("Failed checks: " + failures.join("; "));
  process.exit(1);
}