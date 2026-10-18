#!/usr/bin/env node
// Dense-fixture transform audit (QA).
//
// Drives the REAL worker end to end on scripts/qa/dense-fixture.txt with the
// FULL client database payload (aiDb 3-file merge + idiomDb + suggestDb +
// lexicalDb), twice:
//   - offline: worker.fetch(req, {})  -> deterministic rescue path
//   - live:    anonymous POST to the deployed worker (no usage increment)
// and audits: NDJSON stream integrity, output duplication, per-defect
// catch/uncaught status against a pre-declared expectations table, false
// positives (every changed span NOT claimed by the table), word-level track
// changes integrity (reimplementation of ToolPage.wordDiff), and the
// scoring/rubric contract invariants.
//
// Usage:  node scripts/qa/audit.mjs            (offline + live)
//         SKIP_LIVE=1 node scripts/qa/audit.mjs   (offline only)
// Exit code 1 on any HARD failure (see HARD list in main()).
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_SRC = readFileSync(join(ROOT, "index.js"), "utf8");
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "dense-fixture.txt");
const WORKER_URL = process.env.WORKER_URL || "https://nativewrite-api.nativewrite-api.workers.dev";
const SKIP_LIVE = process.env.SKIP_LIVE === "1";

// --- minimal token-aware block extractor (copied from scripts/test-transform.mjs) ---
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
function extractVar(src, name) {
  const anchor = src.indexOf(`var ${name} =`);
  if (anchor === -1) throw new Error(`var ${name} not found in index.js`);
  const openIdx = src.indexOf("[", anchor);
  return `var ${name} =` + extractBalanced(src, openIdx, "[");
}

// The real doubled-word rule (editor == meter source of truth), extracted so
// the audit tests the shipped pattern, not a copy that could drift.
const dupApi = new Function(
  [extractVar(INDEX_SRC, "DUP_FUNCTION_WORDS"),
   extractFunction(INDEX_SRC, "doubledWordRe"),
   extractFunction(INDEX_SRC, "countDoubledFunctionWords")].join("\n") +
  "\n;return { countDoubledFunctionWords };"
)();

// --- load + merge databases exactly like the client (ToolPage/test-transform) ---
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
function buildDbs() {
  return {
    aiDb: buildAiDb(),
    idiomDb: loadJson("idioms-clunky-native.json"),
    suggestDb: loadJson("ai-suggestions.json"),
    lexicalDb: {
      academic: loadJson("lexical-academic.json"),
      business: loadJson("lexical-business.json"),
      creative: loadJson("lexical-creative.json"),
      general: loadJson("lexical-general.json"),
    },
  };
}
const DBS = buildDbs();
const { default: worker } = await import(pathToFileURL(join(ROOT, "index.js")));

// --- word-level LCS diff, ported verbatim from src/pages/ToolPage.tsx:61-87 ---
const normWordKey = (w) => w.replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/[^a-z]/g, "");
const wordDiff = (a, b) => {
  const aa = a.split(/\s+/).filter(Boolean);
  const bb = b.split(/\s+/).filter(Boolean);
  const ka = aa.map(normWordKey);
  const kb = bb.map(normWordKey);
  const n = aa.length;
  const m = bb.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const parts = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { parts.push({ text: aa[i], type: "same" }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { parts.push({ text: aa[i], type: "del" }); i++; }
    else { parts.push({ text: bb[j], type: "add" }); j++; }
  }
  while (i < n) { parts.push({ text: aa[i], type: "del" }); i++; }
  while (j < m) { parts.push({ text: bb[j], type: "add" }); j++; }
  return parts;
};

// --- expectations table (built BEFORE any run; tier classified against the shipped DBs) ---
// re matches the UNWANTED (error) form, case-insensitive. requiredOffline=true
// means a deterministic editor (certified layer or auto-tier DB) MUST clear it.
const EXPECT = [
  // (a) core English grammar — model-only offline (Pass 1); meter is editor==meter
  { id: "G1", cat: "a-grammar", tier: "model", planted: "which include three new clauses", re: /which include\s+three/ },
  { id: "G2", cat: "a-grammar", tier: "model", planted: "list … were rejected", re: /\bwere rejected\b/ },
  { id: "G3", cat: "a-grammar", tier: "model", planted: "Walking into the boardroom, the lights were…", re: /\blights were unexpectedly dim\b/ },
  { id: "G4", cat: "a-grammar", tier: "model", planted: "and announces the merger", re: /\bannounces the merger\b/ },
  { id: "G5", cat: "a-grammar", tier: "model", planted: "suggested that we must submit", re: /\bwe must submit\b/ },
  { id: "G6", cat: "a-grammar", tier: "model", planted: "many informations", re: /\bmany informations\b/ },
  { id: "G7", cat: "a-grammar", tier: "model", planted: "asked what was the deadline", re: /\basked what was the deadline\b/ },
  { id: "G8", cat: "a-grammar", tier: "model", planted: "employees, which signed", re: /\bemployees, which signed\b/ },
  { id: "G9", cat: "a-grammar", tier: "model", planted: "budget was communicated", re: /\bbudget was communicated\b/ },
  // (b) clunky nonnative — certified verb+prep writes (editor==meter, guaranteed)
  { id: "B1", cat: "b-clunky", tier: "certified", planted: "discussed about", re: /\bdiscussed about\b/, requiredOffline: true },
  { id: "B2", cat: "b-clunky", tier: "certified", planted: "emphasised on", re: /\bemphasised on\b/, requiredOffline: true },
  { id: "B3", cat: "b-clunky", tier: "certified", planted: "comprised of", re: /\bcomprised of\b/, requiredOffline: true },
  // (b) clunky nonnative — auto-tier aiDb rules (requiredOffline via DB layer)
  { id: "B4", cat: "b-clunky", tier: "aiDb", planted: "in order to", re: /\bin order to\b/, requiredOffline: true },
  { id: "B5", cat: "b-clunky", tier: "aiDb", planted: "With regard to", re: /with regard to/i, requiredOffline: true },
  { id: "B6", cat: "b-clunky", tier: "aiDb", planted: "In the event that", re: /in the event that/i, requiredOffline: true },
  // (b) clunky nonnative — absent from every DB (model-only)
  { id: "B7", cat: "b-clunky", tier: "absent", planted: "made a research", re: /\bmade a research\b/ },
  { id: "B8", cat: "b-clunky", tier: "absent", planted: "it was decided by the steering committee…", re: /\bit was decided by the steering committee\b/ },
  // (c) AI-ese — auto-tier aiDb
  { id: "C1", cat: "c-aise", tier: "aiDb", planted: "delve into", re: /\bdelve into\b/, requiredOffline: true },
  { id: "C2", cat: "c-aise", tier: "aiDb", planted: "this is a testament to", re: /\bthis is a testament to\b/, requiredOffline: true },
  { id: "C3", cat: "c-aise", tier: "aiDb", planted: "plays a pivotal role", re: /\bplays a pivotal role\b/, requiredOffline: true },
  { id: "C4", cat: "c-aise", tier: "aiDb", planted: "the evolving landscape of", re: /the evolving landscape of/i, requiredOffline: true },
  { id: "C5", cat: "c-aise", tier: "aiDb", planted: "It is important to note that", re: /it is important to note that/i, requiredOffline: true },
  { id: "C6", cat: "c-aise", tier: "aiDb", planted: "robust framework", re: /robust framework/i, requiredOffline: true },
  { id: "C7", cat: "c-aise", tier: "aiDb", planted: "a plethora of", re: /a plethora of/i, requiredOffline: true },
  { id: "C8", cat: "c-aise", tier: "aiDb", planted: "Due to the fact that", re: /due to the fact that/i, requiredOffline: true },
  { id: "C9", cat: "c-aise", tier: "aiDb", planted: "cutting-edge", re: /cutting-edge/, requiredOffline: true },
  { id: "C10", cat: "c-aise", tier: "absent", planted: "needless to say (rule RETIRED 2026-10-18 — no longer deterministically fixed)", re: /needless to say/i },
  { id: "C11", cat: "c-aise", tier: "aiDb", planted: "At the end of the day", re: /at the end of the day/i, requiredOffline: true },
  // (c) AI-ese — promoted from advise-only to the auto tier on 2026-10-18: MUST
  // now be deterministically cleared. The advise tier is exercised by npm test §17.
  { id: "C12", cat: "c-aise", tier: "aiDb", planted: "has the ability to", re: /has the ability to/i, requiredOffline: true },
  // (c) AI-ese — structural rhythm, absent from DBs (model-only)
  { id: "C13", cat: "c-aise", tier: "absent", planted: "It is essential. It is urgent. It is unavoidable.", re: /\bit is essential\b/i },
  // legitimate certified writes / guards the audit must see (not false positives)
  { id: "S1", cat: "legit", tier: "certified", mustFire: false, planted: "budget, the schedule and the staffing plan (no introducer — Oxford must NOT fire)", re: /\bbudget,\s+the schedule,\s+and\b/i },
  { id: "S2", cat: "legit", tier: "certified", mustFire: true, planted: "including deadlines, budgets and staffing (list-introducer — Oxford must fire)", re: /deadlines,\s+budgets,\s+and\b/i, requiredOffline: true },
];

// --- NDJSON stream integrity parse -------------------------------------------
function parseStream(rawText) {
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim());
  const events = [];
  const parseErrors = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); }
    catch (e) { parseErrors.push(line.slice(0, 120)); }
  }
  const finals = events.filter((e) => e && e.ev === "final");
  const errors = events.filter((e) => e && e.ev === "error");
  let ridMissing = 0, pctRegression = 0, lastPct = -1;
  for (const e of events) {
    if (!e || !e.ev) continue;
    if (!e.rid) ridMissing++;
    if (typeof e.pct === "number") {
      if (e.pct < lastPct) pctRegression++;
      lastPct = Math.max(lastPct, e.pct);
    }
  }
  let result = finals.length ? finals[finals.length - 1].result : null;
  while (result && typeof result === "object" && result.result && !result.finalVersion) result = result.result;
  return { events, finals, errors, ridMissing, pctRegression, parseErrors, result, lines: lines.length };
}

// --- runners ------------------------------------------------------------------
async function runOffline(text) {
  const req = new Request("https://worker.local/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, domain: "academic", tone: "formal", mode: "academic", databases: DBS }),
  });
  const res = await worker.fetch(req, {});
  const raw = Buffer.from(await res.arrayBuffer()).toString("utf8");
  return { httpStatus: res.status, stream: parseStream(raw) };
}
async function runLive(text) {
  const t0 = Date.now();
  const res = await fetch(WORKER_URL + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, domain: "academic", tone: "formal", mode: "academic", databases: DBS }),
    signal: AbortSignal.timeout(150000),
  });
  const raw = Buffer.from(await res.arrayBuffer()).toString("utf8");
  return { httpStatus: res.status, ms: Date.now() - t0, stream: parseStream(raw) };
}

// --- helpers ------------------------------------------------------------------
const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean);
const normText = (s) => String(s || "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
const stripStars = (s) => String(s || "").replace(/\*/g, "");

function expectRegions(original) {
  const regions = [];
  for (const e of EXPECT) {
    const m = e.re.exec(original);
    if (m) regions.push({ id: e.id, start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return regions;
}

function diffRuns(original, revised) {
  const parts = wordDiff(original, revised);
  const runs = [];
  let cur = null;
  let origOff = 0;
  for (const p of parts) {
    if (p.type === "same") {
      if (cur) { runs.push(cur); cur = null; }
      origOff += p.text.length + 1;
    } else if (p.type === "del") {
      if (!cur) cur = { del: [], add: [], start: origOff, end: origOff };
      cur.del.push(p.text);
      cur.end = origOff + p.text.length;
      origOff += p.text.length + 1;
    } else {
      if (!cur) cur = { del: [], add: [], start: origOff, end: origOff };
      cur.add.push(p.text);
    }
  }
  if (cur) runs.push(cur);
  return { parts, runs };
}

function analyze(label, r, stream) {
  const out = { label, hard: [], warns: [], info: [], raw: r };
  const final = r.finalVersion || "";
  const notesBlob = normText([...(r.registerNotes || []), ...(r.suggestions || [])].join(" | "));

  // ---- stream integrity (hard) ----
  if (stream.parseErrors.length) out.hard.push(`[${label}] NDJSON parse errors: ${stream.parseErrors.length}`);
  if (stream.finals.length !== 1) out.hard.push(`[${label}] expected exactly 1 ev:"final", got ${stream.finals.length}`);
  if (stream.errors.length) out.hard.push(`[${label}] ${stream.errors.length} ev:"error" event(s)`);
  if (stream.ridMissing) out.hard.push(`[${label}] ${stream.ridMissing} event(s) missing rid`);
  if (stream.pctRegression) out.hard.push(`[${label}] pct regressed ${stream.pctRegression} time(s)`);
  if (!r || !r.finalVersion) { out.hard.push(`[${label}] no finalVersion`); return out; }
  const inputText = r._inputText || "";

  // ---- duplication (hard unless noted) ----
  const paras = final.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const seen = new Map();
  for (const p of paras) {
    const k = normText(p);
    if (!k) continue;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(p);
  }
  let bodyDup = 0, headDup = 0, fnDup = 0;
  for (const [k, group] of seen) {
    if (group.length < 2) continue;
    if (group.every((p) => p.startsWith("**"))) headDup += group.length - 1;
    else if (/^[\[(]?\d+[\])]?\s|^\bIbid\b/i.test(stripStars(group[0]))) fnDup += group.length - 1;
    else bodyDup += group.length - 1;
  }
  if (bodyDup) out.hard.push(`[${label}] ${bodyDup} duplicate body paragraph(s) in finalVersion`);
  if (fnDup) out.hard.push(`[${label}] ${fnDup} duplicate footnote line(s) in finalVersion`);
  if (headDup) out.info.push(`[${label}] ${headDup} repeated bold heading(s) (exempt by design, index.js:4570)`);

  const sents = r.sentences || [];
  let echoes = 0;
  for (let i = 1; i < sents.length; i++) {
    if (sents[i].original === "" && normText(sents[i].revised) === normText(sents[i - 1].revised)) echoes++;
  }
  if (echoes) out.hard.push(`[${label}] ${echoes} phantom-echo sentence pair(s) survived`);

  // Non-adjacent verbatim duplicate sentences inside one paragraph. The
  // adjacent-only echo check above cannot see this shape: when the DB
  // pre-sweep nativizes a sentence enough that deriveSentencesFromTexts fails
  // to align it, the nativized form was emitted BOTH in place (via the DB
  // backstop) and again as an "added" sentence at the tail. A full sentence
  // repeated verbatim is a defect, not rhetoric (short exclamations are
  // skipped by the length floor).
  let sentDup = 0;
  for (const p of paras) {
    const ps = p.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const seenSent = new Set();
    for (const s of ps) {
      if (s.length < 30) continue;
      const k = normText(s);
      if (!k) continue;
      if (seenSent.has(k)) { sentDup++; continue; }
      seenSent.add(k);
    }
  }
  if (sentDup) out.hard.push(`[${label}] ${sentDup} duplicate sentence(s) within a paragraph in finalVersion`);

  const dupWords = dupApi.countDoubledFunctionWords(final);
  if (dupWords > 0) out.hard.push(`[${label}] ${dupWords} doubled closed-class word(s) in finalVersion`);

  const inW = words(inputText).length;
  const outW = words(final).length;
  const ratio = inW ? outW / inW : 0;
  if (ratio < 0.75) out.hard.push(`[${label}] output token loss: ${inW} -> ${outW} words (${ratio.toFixed(2)})`);
  else if (ratio < 0.9) out.warns.push(`[${label}] output compressed ${inW} -> ${outW} words (${ratio.toFixed(2)}) — expected for AI-ese-heavy text, verify no content drop`);
  if (ratio > 1.3) out.warns.push(`[${label}] output grew unexpectedly: ${inW} -> ${outW} words (${ratio.toFixed(2)})`);

  // ---- expectations walk ----
  const statuses = [];
  for (const e of EXPECT) {
    const hit = e.re.test(final);
    let status;
    if (e.cat === "legit") {
      const mustFire = e.mustFire !== false;
      if (mustFire) {
        status = hit ? "INSERTED (legit)" : "MISSING (certified write absent)";
        if (!hit) out.hard.push(`[${label}] ${e.id} legit certified write did not happen: ${e.planted}`);
      } else {
        status = hit ? "FIRED but must not (guard violated)" : "CORRECTLY untouched (guard holds)";
        if (hit) out.hard.push(`[${label}] ${e.id} guard list was rewritten without an introducer: ${e.planted}`);
      }
    } else if (e.tier === "advise") {
      if (!hit) status = "EDITED (advise tier must never edit)";
      else if (notesBlob.includes(normText(e.planted).split(" ").slice(0, 3).join(" "))) status = "ADVISED (note)";
      else status = "SURVIVED, no register note";
    } else {
      if (!hit) status = "FIXED";
      else if (e.requiredOffline) status = "SHOULD-HAVE-FIRED (deterministic editor missed)";
      else status = "UNCAUGHT (model-only by contract)";
    }
    if (e.tier === "advise" && status.startsWith("EDITED")) out.hard.push(`[${label}] ${e.id} advise phrase edited: ${e.planted}`);
    if (e.cat !== "legit" && e.requiredOffline && hit) out.hard.push(`[${label}] ${e.id} required deterministic fix did not fire: ${e.planted}`);
    statuses.push({ ...e, status, stillPresent: hit });
  }

  // ---- false-positive inventory: every changed span not claimed by the table ----
  const fpRuns = [];
  let changedSents = 0;
  for (const s of sents) {
    if (s.isImmutableFootnote) continue;
    const o = s.original || "", rv = s.revised || "";
    if (o === rv) continue;
    changedSents++;
    const regions = expectRegions(o);
    const { runs } = diffRuns(o, rv);
    for (const run of runs) {
      if (!run.del.length && !run.add.length) continue;
      const expected = regions.some((reg) => run.start < reg.end + 2 && run.end > reg.start - 2);
      if (!expected) {
        fpRuns.push({
          del: run.del.join(" "),
          add: run.add.join(" "),
          context: o.slice(Math.max(0, run.start - 25), Math.min(o.length, run.end + 25)),
        });
      }
    }
  }
  if (fpRuns.length) {
    out.warns.push(`[${label}] ${fpRuns.length} changed span(s) NOT claimed by the expectations table (review below)`);
  }

  // known-unsound certified shape: stripping the stranded preposition from the
  // PASSIVE "was comprised of X" yields "was comprised X", which is not English
  // ("the system comprised X" is fine; "was comprised X" is not).
  let passiveComprise = 0;
  for (const s of sents) {
    if (/\bwas comprised of\b/i.test(s.original || "") && /\bwas comprised\b(?!\s+of)/i.test(s.revised || "")) passiveComprise++;
  }
  if (passiveComprise) out.warns.push(`[${label}] ${passiveComprise} passive "was comprised of" stripped to "was comprised <NP>" — ungrammatical output (VERB_PREP guard gap)`);

  // ---- diff / formatting integrity (hard) ----
  let reconFail = 0, boldFail = 0, explFail = 0, containFail = 0, paraMono = true;
  let lastPara = -1;
  const finalNorm = normText(final);
  for (const s of sents) {
    const o = s.original || "", rv = s.revised || "";
    const { parts } = diffRuns(o, rv);
    // ToolPage renders ORIGINAL tokens for "same" parts by design (glyph flips
    // like straight->curly apostrophes must not show as add+del pairs), so the
    // reconstruction invariant is key-normalized, not byte-exact.
    const reconO = parts.filter((p) => p.type !== "add").map((p) => normWordKey(p.text));
    const reconR = parts.filter((p) => p.type !== "del").map((p) => normWordKey(p.text));
    if (JSON.stringify(reconO) !== JSON.stringify(words(o).map(normWordKey))) reconFail++;
    if (JSON.stringify(reconR) !== JSON.stringify(words(rv).map(normWordKey))) reconFail++;
    const starCount = ((rv.match(/\*\*/g) || []).length);
    if (starCount % 2 !== 0 || /\w\*\*/.test(rv)) boldFail++;
    const unchanged = o === rv;
    const noCorr = s.explanation === "No corrections needed.";
    if (unchanged && !noCorr) explFail++;
    if (!unchanged && noCorr && o.trim() !== "") explFail++;
    if (rv.trim() && !finalNorm.includes(normText(rv))) containFail++;
    if (typeof s.paragraphIndex === "number") {
      if (s.paragraphIndex < lastPara) paraMono = false;
      lastPara = Math.max(lastPara, s.paragraphIndex);
    }
  }
  if (reconFail) out.hard.push(`[${label}] ${reconFail} sentence(s) failed word-diff token reconstruction`);
  if (boldFail) out.hard.push(`[${label}] ${boldFail} sentence(s) with broken/unbalanced ** markup`);
  if (explFail) out.warns.push(`[${label}] ${explFail} sentence(s) with explanation/changed-state mismatch`);
  if (containFail) out.hard.push(`[${label}] ${containFail} sentence revised text(s) missing from finalVersion`);
  if (!paraMono) out.hard.push(`[${label}] paragraphIndex not monotonic`);

  // ---- sentence pairing sanity ----
  const inputSents = inputText.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).length;
  const realSents = sents.filter((s) => !s.isImmutableFootnote).length;
  if (realSents < inputSents) out.warns.push(`[${label}] sentence pairing: input ${inputSents} vs output ${realSents} (dropped/merged)`);
  out.info.push(`[${label}] sentence pairs=${sents.length} (input sentences≈${inputSents}), changed=${changedSents}`);

  // ---- caps introduced by sentence-start-lowering (DB case trap) ----
  const lowered = [];
  for (const para of final.split(/\n\n+/)) {
    for (const sent of stripStars(para).split(/(?<=[.!?])\s+/)) {
      const t = sent.trim();
      if (t && /^[a-z]/.test(t)) lowered.push(t.slice(0, 60));
    }
  }
  if (lowered.length) out.warns.push(`[${label}] ${lowered.length} lowercase sentence start(s) in output: ${lowered.map((s) => `"${s}…"`).join("; ")}`);

  // ---- scoring contract ----
  const sc = r.rubric || {};
  if (typeof r.originalScore !== "number" || typeof r.revisedScore !== "number") out.hard.push(`[${label}] missing originalScore/revisedScore`);
  if ("inputScore" in r || "outputScore" in r) out.warns.push(`[${label}] unexpected inputScore/outputScore field present`);
  if ("diagnostics" in r) out.info.push(`[${label}] result.diagnostics present (unexpected on success)`);
  const oS = r.originalScore, rS = r.revisedScore;
  if (!(oS >= 40 && oS <= 98)) out.hard.push(`[${label}] originalScore out of range: ${oS}`);
  if (!(rS >= 40 && rS <= 98)) out.hard.push(`[${label}] revisedScore out of range: ${rS}`);
  if (rS < oS) out.hard.push(`[${label}] revisedScore ${rS} < originalScore ${oS} (clamp violated)`);
  if (sc.banding && sc.banding.anyChange === false && rS !== oS) out.hard.push(`[${label}] !anyChange but scores differ`);
  if (sc.meter && sc.meter.source >= 98 && sc.banding && sc.banding.anyChange && oS !== 95) out.hard.push(`[${label}] parity gate violated (raw>=98+change should print 98->95, got ${oS})`);
  if (r.remainingIssues && r.remainingIssues.spelling > 0 && (oS > 80 || rS > 80)) out.hard.push(`[${label}] residual spelling >0 but scores above 80 cap`);
  if (sc.axes && sc.axes.duplicates && sc.axes.duplicates.remaining > 0 && sc.meter && sc.meter.revised > 85) out.hard.push(`[${label}] residual duplication >0 but revised raw meter ${sc.meter.revised} > 85`);
  // density verdict
  if (label === "offline") {
    if (oS === 98) out.hard.push(`[offline] dense-defect fixture measured 98 input — scoring density blind spot`);
    else if (oS >= 95) out.warns.push(`[offline] input scored ${oS} despite ~25 planted defects (review rubric density)`);
    const aiRequired = EXPECT.filter((e) => e.requiredOffline && e.cat !== "legit").length;
    const total = (r.databaseStats && r.databaseStats.totalMatches) || 0;
    if (total < Math.ceil(aiRequired * 0.6)) out.hard.push(`[offline] databaseStats.totalMatches=${total} below 60% of ${aiRequired} required DB fires`);
    if (!r.coverage || !(r.coverage.matched > 0)) out.hard.push(`[offline] coverage.matched not > 0`);
    if (r.provider !== "none" || r.rescued !== true) out.warns.push(`[offline] expected provider=none rescued=true, got provider=${r.provider} rescued=${r.rescued}`);
  }

  // ---- promise gate: certification + release gate + no user-hand-off ----
  if (!r.certification) {
    out.hard.push(`[${label}] result.certification missing (release-gate contract not surfaced)`);
  } else {
    const c = r.certification;
    if (label === "offline") {
      if (c.skippedReason !== "no-api-key") out.hard.push(`[offline] expected certification skippedReason="no-api-key", got "${c.skippedReason}"`);
      if (c.verified !== false) out.hard.push(`[offline] certification.verified should be false offline, got ${c.verified}`);
      if (c.ran !== false) out.hard.push(`[offline] certification.ran should be false offline, got ${c.ran}`);
    } else {
      if (c.ran !== true) out.warns.push(`[live] certification did not run (skippedReason=${c.skippedReason})`);
      if (c.verified && c.residualIssues != null && c.residualIssues > 0) out.hard.push(`[${label}] verified=true but residualIssues=${c.residualIssues}`);
    }
  }
  const gate = r.rubric && r.rubric.releaseGate;
  if (!gate) out.hard.push(`[${label}] rubric.releaseGate missing`);
  else {
    // releaseGate.clean must mean "deterministic clean AND (verified OR degraded)"
    const detClean = !!(r.remainingIssues && r.remainingIssues.spelling === 0 && r.remainingIssues.grammar === 0 && r.remainingIssues.punctuation === 0 && r.remainingIssues.capitalization === 0 && r.remainingIssues.stiffness === 0);
    if (gate.deterministicClean !== detClean) out.hard.push(`[${label}] releaseGate.deterministicClean=${gate.deterministicClean} disagrees with residual census (detClean=${detClean})`);
    if (gate.clean && !detClean) out.hard.push(`[${label}] releaseGate.clean=true with residual census non-zero`);
  }
  // no user-hand-off language anywhere in the output surface
  const surface = [].concat(r.suggestions || [], r.registerNotes || [], [r.explanation || ""]).join(" | ");
  if (/\b(use|try|run)\b[^.]{0,60}\b(grammar ?ly|grammar tool|another (tool|editor|app)|external (tool|grammar))/i.test(surface)) {
    out.hard.push(`[${label}] output tells the user to run an external grammar tool (promise violation)`);
  }
  // F1: hyphenated compound "cutting-edge" must be replaceable by the DB layer
  if (/cutting-edge/i.test(inputText) && /cutting-edge/i.test(final)) {
    out.warns.push(`[${label}] "cutting-edge" still present in output (DB single-token gate may be dropping it)`);
  }

  out.statuses = statuses;
  out.fpRuns = fpRuns;
  out.metrics = {
    originalScore: oS, revisedScore: rS,
    meter: sc.meter, banding: sc.banding,
    deductions: sc.deductions && { source: sc.deductions.source, revised: sc.deductions.revised },
    axes: sc.axes,
    databaseStats: r.databaseStats, coverage: r.coverage,
    sourceIssues: r.sourceIssues, remainingIssues: r.remainingIssues,
    registerNotes: r.registerNotes, suggestions: r.suggestions,
    detectedDialect: r.detectedDialect, provider: r.provider, rescued: r.rescued,
    explanation: r.explanation, humanize: r.humanize,
    certification: r.certification, releaseGate: gate,
  };
  return out;
}

// --- report -------------------------------------------------------------------
function mdEscape(s) { return String(s).replace(/\|/g, "\\|"); }

function printReport(text, off, live) {
  const L = [];
  L.push("# IdiomOptima Dense-Fixture Transform Audit");
  L.push("");
  L.push(`Fixture: \`scripts/qa/dense-fixture.txt\` · ${words(text).length} words · domain=academic tone=formal mode=academic`);
  L.push(`Payload: aiDb=${DBS.aiDb.length} (3-file merge) idiomDb=${DBS.idiomDb.length} suggestDb=${DBS.suggestDb.length} lexicalDb=${Object.values(DBS.lexicalDb).map((v) => v.length).join("/")}`);
  L.push("");

  L.push("## [ ] Raw Generated Fixture");
  L.push("");
  L.push("```text");
  L.push(text.trim());
  L.push("```");
  L.push("");

  L.push("## [ ] Transformed Output");
  L.push("");
  L.push("### Offline (deterministic rescue path, provider=none)");
  L.push("");
  if (off && off.raw && off.raw.finalVersion) {
    L.push("```text");
    L.push(off.raw.finalVersion);
    L.push("```");
  } else L.push("_offline run failed_");
  L.push("");
  if (live && live.raw && live.raw.finalVersion) {
    L.push(`### Live (deployed worker, provider=${live.raw.provider}, ${((live.ms || 0) / 1000).toFixed(1)}s)`);
    L.push("");
    L.push("```text");
    L.push(live.raw.finalVersion);
    L.push("```");
    L.push("");
  }

  L.push("## [ ] Duplication Check Status");
  L.push("");
  const dupHard = [...(off?.hard || []), ...(live?.hard || [])].filter((h) => /duplicat|echo|doubled|token loss|ev:"final"|ev:"error"|rid|pct regressed|parse error/i.test(h));
  L.push(`**Overall: ${dupHard.length === 0 ? "PASS" : "FAIL"}**`);
  L.push("");
  L.push("| Check | Offline | Live |");
  L.push("|---|---|---|");
  const dl = (arr, re) => { const hits = (arr || []).filter((h) => re.test(h)); return hits.length ? "FAIL: " + hits[0] : "PASS"; };
  L.push(`| Exactly one ev:\"final\", zero errors | ${dl(off?.hard, /ev:"final"|ev:"error"/)} | ${dl(live?.hard, /ev:"final"|ev:"error"/)} |`);
  L.push(`| rid present, pct monotonic | ${dl(off?.hard, /rid|pct/)} | ${dl(live?.hard, /rid|pct/)} |`);
  L.push(`| No duplicate body/footnote paragraphs | ${dl(off?.hard, /duplicate body|duplicate footnote/)} | ${dl(live?.hard, /duplicate body|duplicate footnote/)} |`);
  L.push(`| No phantom-echo sentences | ${dl(off?.hard, /phantom-echo/)} | ${dl(live?.hard, /phantom-echo/)} |`);
  L.push(`| No doubled closed-class words | ${dl(off?.hard, /doubled closed/)} | ${dl(live?.hard, /doubled closed/)} |`);
  const cons = (a) => ((a?.hard || []).some((h) => /token loss/.test(h)) ? "FAIL" : (a?.warns || []).some((w) => /compressed/.test(w)) ? "WARN (compression)" : "PASS");
  L.push(`| Output token conservation (≥75% hard) | ${cons(off)} | ${cons(live)} |`);
  L.push("");

  for (const run of [off && { tag: "Offline", a: off }, live && { tag: "Live", a: live }].filter(Boolean)) {
    const a = run.a;
    const r = a.raw;
    L.push(`## [ ] Uncaught Errors Breakdown — ${run.tag}`);
    L.push("");
    const st = a.statuses || [];
    const byCat = {};
    for (const s of st) {
      if (s.cat === "legit") continue;
      (byCat[s.cat] = byCat[s.cat] || []).push(s);
    }
    for (const [cat, list] of Object.entries(byCat)) {
      const label = cat === "a-grammar" ? "Core English grammar" : cat === "b-clunky" ? "Clunky nonnative expressions" : "AI-ese artifacts";
      L.push(`### ${label}`);
      L.push("");
      L.push("| ID | Planted defect | Tier | Status |");
      L.push("|---|---|---|---|");
      for (const s of list) L.push(`| ${s.id} | ${mdEscape(s.planted)} | ${s.tier} | ${s.status} |`);
      L.push("");
    }
    const uncaught = st.filter((s) => s.status.startsWith("UNCAUGHT") || s.status.startsWith("SHOULD-HAVE") || s.status.startsWith("SURVIVED") || s.status.startsWith("MISSING"));
    L.push(`**Catch rate — ${run.tag}:** ${st.filter((s) => s.cat !== "legit" && (s.status === "FIXED" || s.status.startsWith("INSERTED") || s.status.startsWith("ADVISED"))).length}/${st.filter((s) => s.cat !== "legit").length} planted defects cleared or advised.`);
    if (r && r.coverage) L.push(` Coverage: matched=${r.coverage.matched}, uncovered=${JSON.stringify(r.coverage.uncovered)}.`);
    L.push("");
  }

  L.push("## [ ] Diff & Formatting Integrity Assessment");
  L.push("");
  const diffHard = [...(off?.hard || []), ...(live?.hard || [])].filter((h) => /reconstruction|balanced \*\*|missing from finalVersion|paragraphIndex|explanation/i.test(h));
  L.push(`**Overall: ${diffHard.length === 0 ? "PASS" : "FAIL"}** (word-level LCS reimplemented from \`src/pages/ToolPage.tsx:61-87\`; worker emits sentence-aligned pairs, track changes is client-side)`);
  L.push("");
  L.push("| Check | Offline | Live |");
  L.push("|---|---|---|");
  L.push(`| same+add tokens == revised; same+del == original | ${dl(off?.hard, /reconstruction/)} | ${dl(live?.hard, /reconstruction/)} |`);
  L.push(`| ** markup balanced, none mid-word | ${dl(off?.hard, /balanced \*\*|broken\/unbalanced/)} | ${dl(live?.hard, /balanced \*\*|broken\/unbalanced/)} |`);
  L.push(`| every sentence revised ∈ finalVersion | ${dl(off?.hard, /missing from finalVersion/)} | ${dl(live?.hard, /missing from finalVersion/)} |`);
  L.push(`| paragraphIndex monotonic | ${dl(off?.hard, /paragraphIndex/)} | ${dl(live?.hard, /paragraphIndex/)} |`);
  L.push(`| explanation ↔ changed-state agreement | ${dl(off?.warns, /explanation\/changed-state/)} | ${dl(live?.warns, /explanation\/changed-state/)} |`);
  L.push("");
  // sample diffs
  const sampleSrc = (off && off.raw) || null;
  if (sampleSrc) {
    L.push("Sample rendered diffs (offline, `~~del~~` → `++add++`):");
    L.push("");
    let shown = 0;
    for (const s of sampleSrc.sentences) {
      if (shown >= 6) break;
      if (!s.original || s.original === s.revised || s.isImmutableFootnote) continue;
      const { parts } = diffRuns(s.original, s.revised);
      const md = parts.map((p) => (p.type === "del" ? `~~${p.text}~~` : p.type === "add" ? `++${p.text}++` : p.text)).join(" ");
      L.push(`- ${md}`);
      shown++;
    }
    L.push("");
  }

  L.push("## [ ] False Positives / Over-correction");
  L.push("");
  for (const run of [off && { tag: "Offline", a: off }, live && { tag: "Live", a: live }].filter(Boolean)) {
    const fps = run.a.fpRuns || [];
    L.push(`### ${run.tag}: ${fps.length === 0 ? "none" : fps.length + " unclaimed changed span(s)"}`);
    L.push("");
    if (fps.length) {
      L.push("| Deleted | Added | Context |");
      L.push("|---|---|---|");
      for (const f of fps.slice(0, 20)) L.push(`| ${mdEscape(f.del || "—")} | ${mdEscape(f.add || "—")} | ${mdEscape("…" + f.context + "…")} |`);
      L.push("");
    }
  }
  const offWarns = (off?.warns || []).filter((w) => /lowercase sentence start/i.test(w));
  if (offWarns.length) { L.push(offWarns[0]); L.push(""); }

  L.push("## [ ] Scoring & Metrics Verification");
  L.push("");
  for (const run of [off && { tag: "Offline", a: off }, live && { tag: "Live", a: live }].filter(Boolean)) {
    const r = run.a.raw;
    const m = run.a.metrics || {};
    if (!r) continue;
    L.push(`### ${run.tag}`);
    L.push("");
    L.push(`- **Scores:** \`${r.originalScore}\` → \`${r.revisedScore}\` (fields verified: \`originalScore\`/\`revisedScore\`; no \`inputScore\`/\`outputScore\`/\`diagnostics\` on success)`);
    if (m.meter) L.push(`- **Raw meter:** source=${m.meter.source} revised=${m.meter.revised} cleared=${m.meter.cleared}${m.meter.note ? ` (${m.meter.note})` : ""}`);
    if (m.banding) L.push(`- **Band:** anyChange=${m.banding.anyChange} realChanges=${m.banding.realChanges} dbRulesFired=${m.banding.dbRulesFired} nativizedRuleCount=${m.banding.nativizedRuleCount} boostApplied=${m.banding.boostApplied}`);
    if (m.deductions) {
      const fmt = (d) => Object.entries(d || {}).filter(([k]) => k !== "rules").map(([k, v]) => `${k}:${v.count}×${v.per}=${v.total}`).join(", ") || "none";
      L.push(`- **Deductions source:** ${fmt(m.deductions.source)}`);
      L.push(`- **Deductions revised:** ${fmt(m.deductions.revised)}`);
    }
    if (m.axes) {
      const ax = ["spelling", "grammar", "punctuation", "capitalization", "stiffness", "duplicates"].map((k) => m.axes[k] ? `${k} ${m.axes[k].source}→${m.axes[k].remaining}` : null).filter(Boolean).join(" · ");
      L.push(`- **Axes (source→remaining):** ${ax}`);
    }
    L.push(`- **databaseStats:** ${JSON.stringify(m.databaseStats)}`);
    L.push(`- **coverage:** ${JSON.stringify(m.coverage)}`);
    L.push(`- **sourceIssues:** ${JSON.stringify(m.sourceIssues)} · **remainingIssues:** ${JSON.stringify(m.remainingIssues)}`);
    L.push(`- **registerNotes:** ${JSON.stringify(m.registerNotes)}`);
    L.push(`- **dialect:** ${m.detectedDialect} · **provider:** ${m.provider}${m.rescued ? " (rescued)" : ""} · **explanation:** ${m.explanation}`);
    if (m.certification) L.push(`- **certification:** ${JSON.stringify(m.certification)}`);
    if (m.releaseGate) L.push(`- **releaseGate:** ${JSON.stringify(m.releaseGate)}`);
    L.push("");
  }

  L.push("## Hard failures & warnings");
  L.push("");
  const allHard = [...(off?.hard || []), ...(live?.hard || [])];
  const allWarn = [...(off?.warns || []), ...(live?.warns || [])];
  L.push(allHard.length ? "**HARD:**" : "**HARD: none**");
  for (const h of allHard) L.push(`- ${h}`);
  L.push("");
  L.push(allWarn.length ? "**WARN:**" : "**WARN: none**");
  for (const w of allWarn) L.push(`- ${w}`);
  L.push("");
  for (const i of [...(off?.info || []), ...(live?.info || [])]) L.push(`- _info:_ ${i}`);
  L.push("");
  L.push(`**Tally: ${allHard.length} hard failure(s), ${allWarn.length} warning(s).**`);
  const md = L.join("\n");
  console.log(md);
  return { hardCount: allHard.length, md };
}

// --- main ---------------------------------------------------------------------
const text = readFileSync(FIXTURE, "utf8");
console.error(`fixture: ${words(text).length} words · building DB payload (aiDb=${DBS.aiDb.length})…`);
const off = await runOffline(text);
if (off.stream.result) off.stream.result._inputText = text;
const offA = analyze("offline", off.stream.result || {}, off.stream);
let live = null, liveA = null;
if (!SKIP_LIVE) {
  console.error(`live probe → ${WORKER_URL} …`);
  try {
    live = await runLive(text);
    if (live.stream.result) live.stream.result._inputText = text;
    liveA = analyze("live", live.stream.result || {}, live.stream);
    liveA.ms = live.ms;
  } catch (e) {
    console.error("live probe failed: " + e.message);
  }
}
const { hardCount, md } = printReport(text, offA, liveA);
if (process.env.REPORT_OUT) writeFileSync(process.env.REPORT_OUT, md, "utf8");
process.exit(hardCount > 0 ? 1 : 0);
