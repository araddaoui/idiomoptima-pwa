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
import { fileURLToPath, pathToFileURL } from "node:url";

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
  extractFunction(INDEX_SRC, "fixCommonMisspellings"),
  extractFunction(INDEX_SRC, "countMisspellings"),
  extractFunction(INDEX_SRC, "resolveBandedScores"),
  extractVarObject(INDEX_SRC, "DEDUCTION_RULES"),
  extractVar(INDEX_SRC, "MODAL_AUX_WORDS"),
  extractVar(INDEX_SRC, "PREPOSITION_WORDS"),
  extractFunction(INDEX_SRC, "tokenDiffTokens"),
  extractFunction(INDEX_SRC, "classifyRealEdits"),
  extractFunction(INDEX_SRC, "applyDeductions"),
  extractFunction(INDEX_SRC, "buildNativizationMaps"),
  extractVarObject(INDEX_SRC, "SEMANTIC_FUNCTION_WORDS"),
  extractFunction(INDEX_SRC, "addedContentWords"),
  extractFunction(INDEX_SRC, "applyDatabaseNativization"),
  extractVar(INDEX_SRC, "DUP_FUNCTION_WORDS"),
  extractFunction(INDEX_SRC, "doubledWordRe"),
  extractFunction(INDEX_SRC, "countDoubledFunctionWords"),
  extractFunction(INDEX_SRC, "detectDialect"),
].join("\n");

const api = new Function(
  extracted + "\n;return { DEFAULT_DATABASES, escapeRegExp, normalizeSentenceKey, replaceOutsideQuotes, fixCommonMisspellings, countMisspellings, resolveBandedScores, DEDUCTION_RULES, classifyRealEdits, applyDeductions, buildNativizationMaps, applyDatabaseNativization, boldHeadingSentences, addedContentWords, countDoubledFunctionWords, detectDialect };"
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
    // ToolPage also ships the ADVISE-ONLY tier (public/ai-suggestions.json).
    // The harness omitted it, which silently made the whole tier invisible to
    // every test that drives the worker with DBS — the reason the one-entry
    // stub went unnoticed.
    suggestDb: loadJson("ai-suggestions.json"),
    lexicalDb: buildLexicalDb(),
  };
}

const DBS = buildDbs();
// The REAL worker module, imported once at module scope so every section that
// needs to drive actual production code (certified layer, scoring, stream
// integrity) shares a single instance.
const { default: worker } = await import(pathToFileURL(join(ROOT, "index.js")));

// Drive the REAL worker end to end (offline: no provider keys, so this is the
// deterministic rescue path — exactly the code the scoring meter reads).
async function runWithDbs(text, domain = "academic", dbs = DBS) {
  const req = new Request("https://nativewrite-api.nativewrite-api.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, domain, tone: "neutral", mode: "hybrid", databases: dbs }),
  });
  const raw = await (await worker.fetch(req, {})).text();
  let data = JSON.parse(raw.split(/\r?\n/).filter((l) => l.trim()).pop() || "{}");
  while (data && typeof data === "object" && data.result && !data.finalVersion) data = data.result;
  return data;
}

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

// ==================== 11. CERTIFIED DETERMINISTIC GRAMMAR/PUNCTUATION LAYER
// Authorized 2026-09-25 (scope: auto-Oxford regardless of dialect, citation
// commas, spacing, sv-agreement + coordinated bare verbs; deterministic WRITES
// in the offline/rescue path; grading now follows the quality gap).
section("11. certified deterministic grammar/punctuation layer (offline worker pipeline)");
{
  // Drive the REAL worker's rescue path (no provider keys) so the certified
  // edits and the re-banded scoring run on actual production code.
  // `worker` itself is imported once at module scope above, so the later
  // stream-integrity section (16) can drive the same real worker instance.
  const SAMPLE = [
    "Background ",
    "",
    "The publication in 1959 of Ferguson\u2019s Diglossia opened the gates on a plethora of Arabic sociolinguistic studies and compilations (Altoma, 1969; Badawi & Hinds, 1986; Blau, 1977; Fishman 1967; Holes, 1987; Maamouri, 1967; Shubashy, 2004, etc.). \u2018Diglossia\u2019 marked the start of an era in which Arabic linguistic scholarship enlarged its purview to include not just philological, stylistic and structural aspects of codified Arabic, but also its functional and dialectal dimensions. Between 1959 and 2011, three major transformations unfolded with crucial impact on the standing of Arabic. The first is the rise in rates of Arabic literacy among Arab populations as of the 1950s and 60s. The second dates back approximately to the mid-1980s and refers to what Ong (1988) calls the \u2018technologizing of the word\u2019, the emergence of word processing in Arabic and the subsequent localization of the web in Arabic around the mid-1990s. These changes saw a transition from massive illiteracy to wider access to digital Arabic literacy mediated by social networks, and manifest in the third transformation, the Arab Spring.",
  ].join("\n");
  const guardDb = { aiDb: [{ ai: "a plethora of", natural: "a host of" }], idiomDb: [], suggestDb: [], lexicalDb: {} };

  async function run(text, forcedDialect = "") {
    const req = new Request("https://nativewrite-api.nativewrite-api.workers.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, domain: "academic", forcedDialect, databases: guardDb }),
    });
    const resp = await worker.fetch(req, {});
    const raw = await resp.text();
    const line = raw.split(/\r?\n/).filter((l) => l.trim()).pop() || "{}";
    let data = JSON.parse(line);
    while (data && typeof data === "object" && data.result && !data.finalVersion) data = data.result;
    return data;
  }
  const has = (v, needle) => String(v || "").includes(needle);

  {
    const out = await run(SAMPLE);
    const fv = out.finalVersion;
    check("citation comma written (Fishman, 1967)", has(fv, "Fishman, 1967"), true);
    check("no bare 'Fishman 1967' remains", has(fv, "Fishman 1967"), false);
    check("Oxford comma written regardless of dialect", has(fv, "philological, stylistic, and structural"), true);
    check("two-item list left alone ('functional and dialectal')", /but also its functional and dialectal/.test(fv), true);
    check("coordinated bare verb fixed ('and manifested in')", has(fv, "and manifested in"), true);
    check("heading bold preserved", /\*\*Background\*\*/.test(fv), true);
    check("DB sweep still runs ('a host of')", has(fv, "a host of"), true);
    // Severity-weighted deduction rubric (2026-09-29): the source pays per class
    // (grammar -4, word-choice -3 ×2, punctuation -3 ×2 = -16 -> 84); the clean
    // revision earns the FULL delta back (full-delta banding) -> 98.
    check("grading follows the quality gap (original 84)", out.originalScore, 84);
    check("fully-cleaned revision scores 98 (full delta)", out.revisedScore, 98);
    const dd = out.rubric && out.rubric.deductions;
    check("deductions ledger audits the source classes", !!(dd && dd.source && dd.source.grammar && dd.source.wordChoice && dd.source.punctuation), true);
    check("deductions ledger credits a clean revision", !!(dd && dd.revised && Object.keys(dd.revised).length === 0), true);
  }
  {
    const out = await run(SAMPLE, "uk");
    check("UK-flagged text STILL receives the Oxford comma", has(out.finalVersion, "philological, stylistic, and structural"), true);
  }
  {
    // New scoring contract (2026-09-28): scores are identical ONLY when no
    // transformation took place — a genuinely pristine source must score flat.
    const pristine = "The library opens at eight, and the morning queue forms before the doors. Students borrow, read, and return every volume on time.";
    const out = await run(pristine);
    check("no-op (zero edits) scores input === output", out.originalScore === out.revisedScore, true);
    check("no-op on pristine source prints 98", out.originalScore, 98);
    check("no-op banding flatByContract true", out.rubric && out.rubric.banding && out.rubric.banding.flatByContract, true);
  }
  {
    const guard = async (sentence, needle, present) => {
      const out = await run(sentence);
      check((present ? "kept: " : "fixed: ") + "'" + needle + "' in '" + sentence.slice(0, 42) + "...'", has(out.finalVersion, needle), present);
    };
    await guard("The committee will review, discuss and approve the proposal.", "review, discuss and approve", true);
    await guard("The journal requires that the study show its limitations clearly.", "study show", true);
    await guard("The study show the results of the survey.", "study shows", true);
    await guard("These results hardly shows any improvement over time.", "results hardly show", true);
    await guard("The Woman Warrior (1976) and China Men (1977) share affinities with each other.", "(1976)", true);
    await guard("Ferguson wrote in 1967 his classic study of diglossia.", "in 1967 his", true);
    await guard("The budget reached 2,600 in 1967, and 3,400 in 1976.", "2,600", true);
    await guard("The data was collected,but the sample stayed small.", "collected, but", true);
  }
}

// ==================== 12. PARITY GATE (resolveBandedScores) — must never regress
// Authorized 2026-09-29 after a user-reported "98 -> 98 despite 2 real edits"
// lack-of-parity: a measured-flawless source prints 98 ONLY when it was ALSO
// left untouched; a flawless-measurement source the editor improved drops into
// the 95 band and the revision must score above it. These assertions pin the
// pure function every real run is banded through.
section("12. parity gate — identical scores ONLY when no transformation took place");
{
  const r = api.resolveBandedScores;
  {
    const b = r(100, 100, { anyChange: false, remainingSpelling: 0 });
    check("true no-op, flawless source -> 98/98 identical", b.originalScore === 98 && b.revisedScore === 98, true);
    check("true no-op flatByContract true", b.flatByContract, true);
  }
  {
    // The exact reported case: 2 real model edits, meter cannot see them
    // (raw 100->100, cleared 0). Original must leave the 98 tier; revision above.
    const b = r(100, 100, { anyChange: true, remainingSpelling: 0 });
    check("edited flawless-measured source NO LONGER prints 98 (drops to 95)", b.originalScore, 95);
    check("edited source revision scores ABOVE source (95 -> 97)", b.revisedScore, 97);
    check("floor boost +2 when cleared is unmeasurable", b.boostApplied, 2);
    check("parity: 98 -> 98 exactly when a transformation took place", b.originalScore === b.revisedScore, false);
  }
  {
    const b = r(97, 100, { anyChange: true, remainingSpelling: 0 });
    check("sub-98 measured source stays in the 95 band", b.originalScore, 95);
    check("cleared sub-98 result above source and below 98", b.revisedScore >= 96 && b.revisedScore <= 98, true);
    check("flatByContract false whenever a transformation landed", b.flatByContract, false);
  }
  {
    const b = r(90, 100, { anyChange: true, remainingSpelling: 0 });
    check("raw 90 cleared 10 -> +10 full delta", b.originalScore, 90);
    check("revised capped at 98 never above", b.revisedScore, 98);
  }
  {
    const b = r(60, 100, { anyChange: true, remainingSpelling: 0 });
    check("raw 60 cleared 40 -> +40 full delta, capped 98", b.revisedScore, 98);
  }
  {
    // FULL-DELTA exact pass-through: the revision inherits the whole measured
    // deduction, minus the persisting residual defect it could not clear.
    const b = r(86, 97, { anyChange: true, remainingSpelling: 0 });
    check("cleared deduction passes through exactly (86 -> 97)", b.revisedScore, 97);
  }
  {
    const b = r(100, 100, { anyChange: true, remainingSpelling: 2 });
    check("residual misspellings cap BOTH sides at 80", b.originalScore === 80 && b.revisedScore === 80, true);
    check("spell cap surfaced", b.spellCapApplied, true);
  }
  {
    const b = r(55, 60, { anyChange: true, remainingSpelling: 0 });
    check("revised never below source (platform promise)", b.revisedScore >= b.originalScore, true);
  }
  {
    const b = r(100, 100, { anyChange: false, remainingSpelling: 0 });
    check("no-op 98/98 still flat (Lolita/business/literary corner kept)", b.originalScore === 98 && b.revisedScore === 98, true);
  }
}

// ==================== 13. SEVERITY-WEIGHTED DEDUCTION RUBRIC (2026-09-29)
// User-approved values: grammar -4 (cap -16), spelling -3, word-choice -3,
// punctuation -3, duplication -3, capitalization -3 (each cap -12), register -2
// (cap -6). Tier-B evidence classification charges a real Pass-1 edit to the
// SOURCE; full-delta banding hands the whole cleared deduction to the revision.
section("13. severity-weighted deduction rubric + Tier-B classifier");
{
  const cls = api.classifyRealEdits;
  const ded = api.applyDeductions;
  {
    // The exact user-reported ASI manuscript shapes.
    check("tense modal switch -> grammar", cls("This could beat any international industrial states, but we have long devised their independence. Some sit on meetings without purpose.", "This could beat any international industrial states, but we had long devised their independence. Some sit in meetings without purpose.").grammar, 1);
    check("preposition swap -> grammar", cls("We review the report in the meeting.", "We review the report at the meeting.").grammar, 1);
    check("content-word swap -> word choice", cls("They obtained a result.", "They achieved a result.").wordChoice, 1);
    check("case-only -> capitalization", cls("the proposal was approved.", "The proposal was approved.").capitalization, 1);
    // Punctuation-marker-only deltas (paren/comma/shift) are NOT Tier-B evidence:
    // content tokens match, so the balanced-paren/Unbalanced counters in the
    // certified editor own the punctuation class (Tier A).
    check("paren-only change stays Tier-A (no Tier-B re-charge)", cls("The claim (Smith 1999", "The claim (Smith, 1999").punctuation, 0);
    check("misspelling fix -> spelling (owned by spell meter)", cls("This was a challanges.", "This was a challenge.").spelling, 1);
  }
  {
    const d = ded({ grammar: 1, wordChoice: 2, punctuation: 2 });
    check("deduction math: 1x4 + 2x3 + 2x3 = 84", d.score, 84);
    const cap = ded({ grammar: 9 });
    check("per-class cap: 9 grammar hits capped at -16", cap.score, 84);
    const floor = ded({ grammar: 255, spelling: 255, wordChoice: 255, punctuation: 255, capitalization: 255, duplication: 255, register: 255 });
    check("floor 40 holds across all capped classes", floor.score, 40);
    const spell = ded({ spelling: 3 });
    check("spelling hard 80 ceiling", spell.score, 80);
  }
  {
    // Tier-A write path: the curated verb+preposition table + unbalanced-bracket
    // count land through the certified editor (editor == meter), all quote-safe
    // via the real worker rescue path.
    const { default: worker } = await import(pathToFileURL(join(ROOT, "index.js")));
    const db = { aiDb: [], idiomDb: [], suggestDb: [], lexicalDb: {} };
    async function run(text) {
      const req = new Request("https://nativewrite-api.nativewrite-api.workers.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, domain: "academic", databases: db }),
      });
      const resp = await worker.fetch(req, {});
      const raw = await resp.text();
      const line = raw.split(/\r?\n/).filter((l) => l.trim()).pop() || "{}";
      let data = JSON.parse(line);
      while (data && typeof data === "object" && data.result && !data.finalVersion) data = data.result;
      return data;
    }
    const hard = "The committee will discuss about the plan, and the report draws on Altoma (Campbell, 1999); Sport, 1996) for the fuller picture and remains unfinished.";
    const out = await run(hard);
    check("Tier-A writes 'discuss about' -> 'discuss'", !out.finalVersion.includes("discuss about"), true);
    check("unbalanced bracket persists (count-only, never auto-fixed)", out.finalVersion.includes("Sport, 1996) for"), true);
    check("punctuation deduction charged on BOTH sides (paren left in)", !!(out.rubric && out.rubric.deductions && out.rubric.deductions.revised && out.rubric.deductions.revised.punctuation), true);
  }
}

// Live defects found 2026-10-03 by probing the deployed worker end to end:
//   (a) the revision ledger hardcoded duplication to 0, so a doubled word that
//       survived to finalVersion scored 98/98 while shipping the slip, and the
//       hard 85 duplicate ceiling could never fire on a revision. NOTE: a later
//       owner decision the same day ALSO made the certified layer fix doublings
//       outright (section 15); the meter change here is what makes that
//       measurable on both sides;
//   (b) VERB_PREP_CORRECTIONS matched only base forms, so "discussed about",
//       "comprised of" and "emphasised on" reached the shipped text (past tense
//       is the commonest form in academic prose). Section 13 only tested the
//       base form, which is why CI stayed green.
// Policy: duplication is COUNT-ONLY (no new write rule); the verb+prep
// inflections are write fixes that must preserve the author's verb form.
section("14. revision-side duplication meter + inflected verb+prep");
{
  const dup = api.countDoubledFunctionWords;
  {
    check("catches 'the the'", dup("Note that the the team met."), 1);
    check("catches 'of of'", dup("a matter of of concern"), 1);
    check("catches 'and and'", dup("the result and and the claim"), 1);
    check("counts every occurrence", dup("the the team and and the plan of of"), 3);
    check("case-insensitive", dup("The the team met."), 1);
    // Legitimate English doubles must NOT be charged.
    check("'had had' is legitimate (perfect) -> 0", dup("he had had enough time"), 0);
    check("'that that' is legitimate (quoted speech) -> 0", dup("she said that that was fine"), 0);
    check("'very very' is deliberate emphasis -> 0", dup("it is very very important"), 0);
    // A doubled word straddling a line/paragraph break is not a defect.
    check("no charge across a paragraph break", dup("drawn from the source.\n\nThe source is thin."), 0);
    check("clean prose -> 0", dup("The committee reviewed the report and approved the plan."), 0);
    check("empty input -> 0", dup(""), 0);
  }
  {
    const { default: worker } = await import(pathToFileURL(join(ROOT, "index.js")));
    const db = { aiDb: [], idiomDb: [], suggestDb: [], lexicalDb: {} };
    async function run(text) {
      const req = new Request("https://nativewrite-api.nativewrite-api.workers.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, domain: "academic", databases: db }),
      });
      const resp = await worker.fetch(req, {});
      const raw = await resp.text();
      const line = raw.split(/\r?\n/).filter((l) => l.trim()).pop() || "{}";
      let data = JSON.parse(line);
      while (data && typeof data === "object" && data.result && !data.finalVersion) data = data.result;
      return data;
    }

    // (a) The regression that shipped: the revision's duplication class used to
    // be hardcoded to 0, so a surviving doubled word scored 98/98 while shipping
    // the slip. The class is now genuinely measured on BOTH sides — and since
    // the 2026-10-03 reversal the editor also FIXES the doubling, so the source
    // is charged and the residual genuinely clears. Section 15 carries the full
    // write/no-write matrix; these assertions pin the ledger itself.
    const dupOut = await run("The team noted that the the sample was small.");
    check("source-side duplication charged", dupOut.rubric.deductions.source.duplication.count, 1);
    check("doubled word now FIXED by the certified pass", dupOut.finalVersion.includes("the sample"), true);
    check("residual clears on the revision (not a permanent cap)", dupOut.rubric.axes.duplicates.remaining, 0);
    check("no revision-side duplication deduction", dupOut.rubric.deductions.revised.duplication, undefined);
    check("revision escapes the hard 85 duplicate ceiling", dupOut.revisedScore > 85, true);

    // Clean text must NOT be charged on either side (no false-positive regression).
    const cleanOut = await run("The team noted that he had had enough time to review the sample.");
    check("'had had' text: zero duplication on BOTH sides", cleanOut.rubric.axes.duplicates.source + cleanOut.rubric.axes.duplicates.remaining, 0);
    check("'had had' text: no duplication deduction on the revision", cleanOut.rubric.deductions.revised.duplication, undefined);

    // (b) Inflected verb+preposition forms must fire AND keep the verb form.
    const vp = await run("The committee discussed about the plan and the study comprised of two parts, so the author emphasised on the evidence.");
    check("'discussed about' -> 'discussed'", !vp.finalVersion.includes("discussed about"), true);
    check("'comprised of' -> 'comprised'", !vp.finalVersion.includes("comprised of"), true);
    check("'emphasised on' -> 'emphasised'", !vp.finalVersion.includes("emphasised on"), true);
    check("verb form PRESERVED (no de-inflection to 'discuss')", /\bdiscussed\b/.test(vp.finalVersion), true);
    check("3rd-person 'discusses about' fires", !/\bdiscusses about\b/.test(await run("The committee discusses about the plan.").then((r) => r.finalVersion)), true);
  }
}

// Owner decision 2026-10-03 (reversing the count-only policy): a doubled
// closed-class word / article is now FIXED in the certified grammar pass, while
// deliberate repetition is left alone — "this is very, very good" must survive
// untouched. Runs through the real worker.fetch path, so it also proves the
// certified editor and the duplication meter agree (editor == meter).
section("15. doubled-word WRITE in the certified pass (deliberate repetition spared)");
{
  const dup = api.countDoubledFunctionWords;
  {
    // The \b guard: without it a word TAIL reads as a duplicate. These two are
    // the regression that made \b mandatory.
    check("\\b guard: 'this is ...' is NOT 'is is'", dup("this is very, very good."), 0);
    check("\\b guard: 'The team met' is NOT 'm m'", dup("The team met."), 0);
    check("detects 'the the'", dup("Note that the the team met."), 1);
    check("detects two ('the the ... of of')", dup("the the team and of of it"), 2);
  }
  {
    const { default: worker } = await import(pathToFileURL(join(ROOT, "index.js")));
    const db = { aiDb: [], idiomDb: [], suggestDb: [], lexicalDb: {} };
    async function run(text) {
      const req = new Request("https://nativewrite-api.nativewrite-api.workers.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, domain: "academic", databases: db }),
      });
      const resp = await worker.fetch(req, {});
      const raw = await resp.text();
      const line = raw.split(/\r?\n/).filter((l) => l.trim()).pop() || "{}";
      let data = JSON.parse(line);
      while (data && typeof data === "object" && data.result && !data.finalVersion) data = data.result;
      return data;
    }

    // --- MUST be fixed -------------------------------------------------
    for (const [before, after] of [
      ["The team noted that the the sample was small.", "the sample"],
      ["A range of of values was observed.", "A range of values"],
      ["The team and and the plan clashed.", "The team and the plan"],
      ["It was an an unusual case.", "It was an unusual case"],
      ["The the report was late.", "The report"],
    ]) {
      const out = await run(before);
      check(`fixed: "${before.slice(0, 34)}..."`, out.finalVersion.includes(after), true);
    }
    // First word's case is kept ("The the" -> "The", never "the").
    check("case preserved: 'The the' -> 'The'", (await run("The the report was late.")).finalVersion.trim().startsWith("The report"), true);
    // Spacing runs first, so a double-space doubling is still caught.
    check("spacing runs first: 'the  the' collapsed", (await run("The team reviewed the  the plan.")).finalVersion.includes("the plan"), true);

    // --- MUST NOT be touched (owner requirement + regressions) --------
    for (const [label, text, keep] of [
      ["owner example: 'very, very good'", "This is very, very good.", "very, very good"],
      ["comma repetition: 'yes, yes'", "The answer was yes, yes.", "yes, yes"],
      ["comma repetition: 'no, no'", "The answer was no, no.", "no, no"],
      ["emphasis: 'very very' (no comma)", "It is very very important.", "very very"],
      ["perfect: 'had had'", "He had had enough time.", "had had"],
      ["quoted speech: 'that that'", "She said that that was fine.", "that that"],
      ["quoted comma repetition", 'He said "no, no" firmly.', '"no, no"'],
      ["\\b guard: 'this is ...' kept", "This is very, very good.", "This is"],
      ["\\b guard: 'The team met' kept", "The team met.", "The team met"],
    ]) {
      const out = await run(text);
      check(`kept: ${label}`, out.finalVersion.includes(keep), true);
    }

    // --- editor == meter ----------------------------------------------
    // Source charged, then genuinely cleared by the editor on the revision.
    const fixed = await run("The team noted that the the sample was small.");
    check("source charged for the doubling", fixed.rubric.deductions.source.duplication.count, 1);
    check("revision CLEARED (editor fixed it)", fixed.rubric.axes.duplicates.remaining, 0);
    check("no revision-side duplication deduction", fixed.rubric.deductions.revised.duplication, undefined);
    check("revision no longer capped at 85", fixed.revisedScore > 85, true);
    check("revision scores above source", fixed.revisedScore >= fixed.originalScore, true);
    // Editor == meter: the same class that charged the source is now 0.
    check("axes show source 1 -> remaining 0", fixed.rubric.axes.duplicates.source, 1);

    // Deliberate repetition is never charged on EITHER side.
    const kept = await run("This is very, very good and he had had enough time.");
    check("deliberate repetition uncharged on the source", kept.rubric.axes.duplicates.source, 0);
    check("deliberate repetition uncharged on the revision", kept.rubric.axes.duplicates.remaining, 0);
    check("no duplication deduction at all", kept.rubric.deductions.source.duplication, undefined);

    // Footnote / citation lines are the author's: never edited, never charged.
    const cited = await run("The the sample was small.\n\n[1] See the the appendix for details.");
    check("footnote line NOT edited", cited.finalVersion.includes("[1] See the the appendix"), true);
    check("body doubling still fixed", cited.finalVersion.includes("The sample was small"), true);
  }
}

section("16. stream integrity: EVERY run ends with a terminal event (no truncated streams)");
{
  // Regression guard for the production bug where the platform terminated the
  // worker mid-stream (`outcome: exceededCpu`) and the client could only report
  // "Stream ended without a final result from the worker." A stream that closes
  // with neither `final` nor `error` is indistinguishable from success until it
  // is not, so the worker now guarantees a terminal event in a `finally` block.
  const driveStream = async (payload) => {
    const req = new Request("https://nativewrite-api.nativewrite-api.workers.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const resp = await worker.fetch(req, {});
    // Pre-stream rejections (empty text, non-English) answer with a real JSON
    // error status, never a truncated stream. Assert that explicitly so this
    // test cannot be satisfied by an early return.
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return { httpStatus: resp.status, terminal: "http-error", error: body.error || "" };
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal = null;
    let rid = null;
    let events = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const evt = JSON.parse(line);
        events++;
        if (evt.rid) rid = evt.rid;
        if (evt.ev === "final") terminal = "final";
        if (evt.ev === "error") terminal = "error";
      }
    }
    return { terminal, rid, events };
  };

  const prose = "The committee conducted a comprehensive review of the methodology utilized by the research team. It was observed that a significant number of participants were not able to utilize the resources effectively. The mere fact that the timeline was very tight meant the team had to make use of every avenue.";

  // Representative shapes: plain, multi-paragraph, quoted, unicode, long.
  const cases = [
    ["plain prose", prose],
    ["multi-paragraph", prose + "\n\n" + prose + "\n\nThe data was very robust and the results framework was not really needed."],
    ["quoted text", 'The report noted that "the mere fact that the timeline was tight" caused delays. Furthermore, it was observed that a significant number of participants were not able to utilize the resources effectively.'],
    ["unicode + emphasis", "The naïve café analysis — “quoted” ‘text’ — showed a significant result. It was observed that a significant number of participants were not able to utilize the available resources effectively."],
    ["long (multi-chunk path)", prose.repeat(30)],
  ];

  for (const [label, text] of cases) {
    const out = await driveStream({ text, domain: "academic", tone: "formal", mode: "auto", databases: DBS });
    check("stream ends with a terminal event: " + label, out.terminal, "final");
    check("terminal event carries a correlation id: " + label, typeof out.rid === "string" && out.rid.length > 0, true);
    check("stream is not empty: " + label, out.events > 1, true);
  }

  // Pre-stream rejections must be honest HTTP errors, never silent truncations.
  const empty = await driveStream({ text: "   ", domain: "academic", mode: "auto", databases: DBS });
  check("empty text -> real HTTP error, not a truncated stream", empty.terminal, "http-error");
  check("empty text error is non-empty", typeof empty.error === "string" && empty.error.length > 0, true);
}

section("17. advise-only tier is real (B1), coherent, and never edits (B1+B4)");
{
  // 2026-10-03 audit: the ADVISE-ONLY tier shipped with exactly ONE entry
  // (`some sort of`), identical to the DEFAULT_DATABASES floor, so the whole
  // tier was unreachable — `registerNotes` could never fire for real prose and
  // the Notes-tab "kept as written" affordance was dead. A live academic
  // passage containing "one can understand that" and "not to mention that"
  // reported zero register notes. The inventory is now populated; these checks
  // are the regression guard so it cannot silently collapse back to a stub.

  const SUGGEST = loadJson("ai-suggestions.json");
  const normKey = (s) => String(s || "").toLowerCase().replace(/[""\u201C\u201D]/g, "").replace(/\s+/g, " ").trim();

  check("advise tier is non-trivial (not a stub)", SUGGEST.length > 50, true);
  check("worker floor still carries advise entries", api.DEFAULT_DATABASES.suggestDb.length > 0, true);

  const VALID_KINDS = ["informal", "filler", "cliche", "formulaic"];
  const seen = new Map();
  let badShape = 0, badKind = 0, identity = 0, dupes = 0;
  for (const e of SUGGEST) {
    const s = normKey(e.ai), t = normKey(e.natural);
    if (!s || !t || s.split(" ").length < 2) badShape++;
    if (!VALID_KINDS.includes(String(e.kind || "").toLowerCase())) badKind++;
    if (s === t) identity++;
    if (seen.has(s)) dupes++;
    seen.set(s, e);
  }
  check("every advise entry has a multi-word source and a target", badShape, 0);
  check("every advise entry declares a valid kind (drives the note copy)", badKind, 0);
  check("no identity pairs (the map builder would silently drop them)", identity, 0);
  check("no duplicate advise sources", dupes, 0);

  // Coherent policy: an advise entry must not ALSO be an auto-tier rewrite, or
  // the tool would tell the author to consider a phrasing it just replaced.
  const autoSources = new Set();
  for (const e of DBS.aiDb) autoSources.add(normKey(e.ai || e.clunky));
  for (const e of DBS.idiomDb) autoSources.add(normKey(e.ai || e.clunky));
  for (const d of ["academic", "business", "creative", "general"])
    for (const e of DBS.lexicalDb[d] || []) autoSources.add(normKey(e.ai || e.clunky));
  const conflicts = SUGGEST.filter((e) => autoSources.has(normKey(e.ai)));
  check("no advise entry overlaps the auto tier", conflicts.map((e) => e.ai).join(", "), "");

  // --- the load-bearing invariant: ADVISE-ONLY NEVER EDITS -------------------
  // A text saturated with advise-tier phrases must come back byte-identical and
  // must not move a single scoring axis. This is what keeps the tier
  // "data-only and freeze-safe" (AGENTS.md) true.
  const sat = "We should figure out the plan and deal with the risk. It is the elephant in the room. She tends to burn the midnight oil and touch base often, so she makes a decision late. In the nick of time we find out that a lot of people kind of agree, and there is no doubt that things like this happen every day. One can see that the tip of the iceberg is not the whole problem.";
  const satOut = await runWithDbs(sat, "academic", DBS);
  check("advise-only text is NOT rewritten", satOut.finalVersion.trim() === sat.trim(), true);
  check("advise-only text docks no stiffness on the source", satOut.rubric.axes.stiffness.source, 0);
  check("advise-only text docks no stiffness on the revision", satOut.rubric.axes.stiffness.remaining, 0);
  check("advise-only text docks no word-choice deduction (source)", satOut.rubric.deductions.source.wordChoice, undefined);
  check("advise-only text docks no word-choice deduction (revised)", satOut.rubric.deductions.revised.wordChoice, undefined);
  // `register` is charged only when the MODEL replaced an advise phrase. Pass 1
  // is grammar-only and the advise tier never edits, so it must stay uncharged
  // offline — an author is never docked for acceptable English.
  check("advise-only text docks no register deduction", satOut.rubric.deductions.source.register, undefined);
  check("advise-only text scores identically on both sides", satOut.originalScore, satOut.revisedScore);
  check("advise-only text produces register notes", (satOut.registerNotes || []).length > 0, true);
  check("register notes are capped at 5", (satOut.registerNotes || []).length <= 5, true);

  // --- B1 regression guard: the exact phrases the audit found invisible ------
  const audit = await runWithDbs(
    "Whether it is the spiritual that she sings, or the child calling her a name, one can understand that Martine could not see herself as a survivor. Babies are innocent creatures, not to mention that they cannot even speak yet.",
    "academic", DBS);
  const joined = (audit.registerNotes || []).join(" | ");
  check("advise note fires on 'one can understand that'", joined.includes("one can understand that"), true);
  check("advise note fires on 'not to mention that'", joined.includes("not to mention that"), true);

  // --- B4: the note must name the ACTUAL register issue and the ACTUAL domain.
  check("note reports the entry's kind, not a blanket 'informal'", /“one can understand that” is formulaic/.test(joined), true);
  check("note targets the requested register (academic)", joined.includes("in academic writing"), true);
  // Kind labelling is asserted on SINGLE-phrase inputs: registerNotes is capped
  // at 5, so a saturated text would drop the phrase under test.
  const fillerOut = await runWithDbs("She had a lot of questions about the schedule.", "academic", DBS);
  check("filler entries are labelled 'filler'", /“a lot of” is filler/.test((fillerOut.registerNotes || []).join(" | ")), true);
  const clicheOut = await runWithDbs("It is the elephant in the room, and everyone knows it.", "academic", DBS);
  check("cliche entries are labelled 'is a cliche'", /“the elephant in the room” is a cliche/.test((clicheOut.registerNotes || []).join(" | ")), true);
  const bizOut = await runWithDbs("We need to figure out a plan for the quarter.", "business", DBS);
  check("note targets business writing for a business document", (bizOut.registerNotes || []).join(" ").includes("in business writing"), true);
  const genOut = await runWithDbs("We need to figure out a plan for the quarter.", "general", DBS);
  check("note targets formal writing for a general document", (genOut.registerNotes || []).join(" ").includes("in formal writing"), true);
  const creOut = await runWithDbs("We need to figure out a plan for the quarter.", "creative", DBS);
  check("note targets creative writing for a creative document", (creOut.registerNotes || []).join(" ").includes("in creative writing"), true);
}

section("18. detectDialect: UK markers present, US false-positive traps absent");
{
  // 2026-10-03 audit: the UK list omitted `foetus` — the single most
  // distinctively British spelling in the language — so a UK academic passage
  // using it twice reported "US" on the offline/rescue path. Two further traps
  // found while fixing it, both of which a naive regex reintroduces:
  //   * `\w+is(ed|es|ing)` also matches ADVISE/REVISE/COMPRISE/PROMISE/
  //     PRECISE/CONCISE — all correct US English.
  //   * "analyses" is the ordinary US plural of "analysis", and "fetus"/"grey"
  //     are accepted US spellings, so none of them are UK markers.
  const d = api.detectDialect;
  for (const t of [
    "A foetus in her womb could in no way be real.",
    "We need to analyse the colour of the behaviour.",
    "She travelled a labelled distance amid characterisation.",
    "The centre of gravity shifted towards a paediatric cohort.",
    "He recognised the anaemia and the defence line.",
    "A programme of colonisation and generalisation followed.",
    "Amongst the neighbours, the theatre metre measured oddly.",
    "The haematology report noted a haemorrhage.",
  ]) check(`detectDialect -> UK: ${JSON.stringify(t.slice(0, 42))}`, d(t), "UK");

  for (const t of [
    "She advises the committee and revises the draft.",
    "The study comprises three phases and promises results.",
    "It is a precise and concise summary of a precise problem.",
    "Such an exercise will surprise everyone and arise often.",
    "The analyses show a clear pattern across all sites.",
    "The manager will devise a plan and supervise the team.",
    "He organized the meeting and memorized the schedule.",
    "The fetus is a fetus, and the fibers of the meter align.",
    "A grey day; the storey above was empty.",
    "The license was practiced in a center near the theater.",
    "She optimized the process and summarized the results.",
  ]) check(`detectDialect -> US: ${JSON.stringify(t.slice(0, 42))}`, d(t), "US");

  // Canadian/Australian English uses UK spellings, so those regions must be
  // tested FIRST or every Canadian text with "colour" reads as UK.
  check("CA wins over UK spellings", d("In Canada the colour of the behaviour matters."), "CA");
  check("AU wins over UK spellings", d("Australian centres emphasise behaviour and colour."), "AU");
  check("empty text falls back to US", d(""), "US");
  check("neutral text falls back to US", d("The report reached a conclusion."), "US");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("Failed checks: " + failures.join("; "));
  process.exit(1);
}