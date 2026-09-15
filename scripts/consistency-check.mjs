#!/usr/bin/env node
// Consistency + determinism harness for IdiomOptima (NativeWrite).
//
// Proves the three guarantees the platform now enforces:
//   A. Offline determinism — the SAME input, through the REAL worker pipeline
//      (no provider keys => deterministic rescue path), yields byte-identical
//      output across repeated runs (score, finalVersion, sentences, census).
//   B. Coverage census — a per-field table of "matched rules vs present-but-
//      uncovered stiff patterns", so a quiet run has an explanation.
//   C. Literary anti-over-edit invariant — master native prose (Lolita) stays
//      untouched and scores >= 98.
// Live mode (`--live` / LIVE=1) additionally POSTs the corpus to the deployed
// worker 3x each and asserts: scores identical on every run, and output bytes
// identical whenever the SAME provider answered (provider changes caused by an
// upstream outage are reported, never hidden).
//
// Runs of the live mode consume real provider quota; offline mode is free.

import { readFileSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_DIR = join(ROOT, "scripts", "corpus");
const LIVE = process.argv.includes("--live") || process.env.LIVE === "1";
const REPEATS = 3;
const WORKER_URL = process.env.WORKER_URL || "https://nativewrite-api.nativewrite-api.workers.dev";

// Each corpus item: { file, domain, tone, mode, minMatched }
const CORPUS = [
  { file: "uae.txt", domain: "academic", tone: "formal", mode: "academic", minMatched: 6 },
  { file: "academic.txt", domain: "academic", tone: "formal", mode: "academic", minMatched: 6 },
  { file: "literary.txt", domain: "creative", tone: "reflective", mode: "academic", minMatched: 0, untouched: true },
  { file: "business.txt", domain: "business", tone: "professional", mode: "business", minMatched: 1 },
  { file: "general.txt", domain: "general", tone: "friendly", mode: "general", minMatched: 3 },
  { file: "military.txt", domain: "academic", tone: "formal", mode: "academic", minMatched: 6 },
];

// --- Result normalization: only the deterministic contract slices compare. ---
function normalized(r) {
  return {
    originalScore: r.originalScore,
    revisedScore: r.revisedScore,
    finalVersion: r.finalVersion,
    sentences: (r.sentences || []).map((s) => ({
      original: s.original,
      revised: s.revised,
      isImmutableFootnote: !!s.isImmutableFootnote,
      paragraphIndex: s.paragraphIndex,
    })),
    suggestions: r.suggestions || [],
    explanation: r.explanation,
    detectedDialect: r.detectedDialect,
    databaseStats: r.databaseStats,
    coverage: r.coverage,
  };
}

async function readNdjsonFinal(res) {
  if (!res.ok) {
    const body = await res.text();
    throw new Error("HTTP " + res.status + ": " + body.slice(0, 300));
  }
  const isNdjson =
    res.headers.get("X-Transform-Stream") === "ndjson" ||
    (res.headers.get("Content-Type") || "").includes("application/x-ndjson");
  if (!isNdjson) {
    const data = await res.json();
    return { result: data, provider: data.provider };
  }
  let buf = "";
  for await (const chunk of res.body) buf += new TextDecoder().decode(chunk);
  let result = null;
  let provider = null;
  for (const line of buf.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.ev === "final") result = evt.result;
      if (evt.ev === "error") throw new Error(evt.message);
    } catch (e) {
      if (e && e.message && e.message !== "Unexpected token e in JSON at position 0") throw e;
    }
  }
  if (!result) throw new Error("No final event in worker stream");
  provider = result.provider;
  return { result, provider };
}

function loadDatabases() {
  const ai = JSON.parse(readFileSync(join(ROOT, "public", "ai-natural-database.json"), "utf8"));
  const idioms = JSON.parse(readFileSync(join(ROOT, "public", "idioms-clunky-native.json"), "utf8"));
  const lex = (d) => JSON.parse(readFileSync(join(ROOT, "public", "lexical-" + d + ".json"), "utf8"));
  return {
    aiDb: ai,
    idiomDb: idioms,
    lexicalDb: {
      academic: lex("academic"),
      business: lex("business"),
      creative: lex("creative"),
      general: lex("general"),
    },
  };
}

// --- Offline mode: import the REAL worker code and drive it with no keys. ---
async function loadOfflineWorker() {
  const src = readFileSync(join(ROOT, "index.js"), "utf8");
  const tmp = mkdtempSync(join(tmpdir(), "idiomoptima-consist-"));
  const tmpWorker = join(tmp, "worker.mjs");
  writeFileSync(tmpWorker, src);
  const mod = await import(pathToFileURL(tmpWorker).href);
  return mod.default;
}

async function runOffline(worker, databases, item, text) {
  const payload = {
    text,
    domain: item.domain,
    tone: item.tone,
    mode: item.mode,
    databases,
  };
  const req = new Request("https://worker.local/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const res = await worker.fetch(req, {});
  const { result } = await readNdjsonFinal(res);
  return result;
}

async function runLive(databases, item, text) {
  const payload = {
    text,
    domain: item.domain,
    tone: item.tone,
    mode: item.mode,
    databases,
  };
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readNdjsonFinal(res);
}

// --- Tiny test runner ---------------------------------------------------------
let passes = 0;
let fails = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    passes++;
    console.log("  PASS  " + name);
  } else {
    fails++;
    failures.push(name + (detail ? " :: " + detail : ""));
    console.log("  FAIL  " + name + (detail ? " :: " + detail : ""));
  }
}

async function main() {
  console.log("Consistency harness (offline determinism + coverage census)" + (LIVE ? " + LIVE provider audit" : "") + " — corpus: " + readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".txt")).join(", "));
  console.log("");

  const databases = loadDatabases();
  const worker = await loadOfflineWorker();

  const items = CORPUS.map((c) => ({ ...c, text: readFileSync(join(CORPUS_DIR, c.file), "utf8") }));

  // --- A + C: offline determinism, coverage, and the literary invariant -------
  console.log("== Offline determinism (3 identical runs each) ==");
  for (const item of items) {
    const key = basename(item.file, ".txt");
    const runs = [];
    for (let i = 0; i < REPEATS; i++) runs.push(normalized(await runOffline(worker, databases, item, item.text)));
    const sigs = runs.map((r) => JSON.stringify(r));
    check(key + " repeatable (" + REPEATS + "x identical normalized output)", new Set(sigs).size === 1);

    const r0 = runs[0];
    const cov = r0.coverage || { matched: 0, uncovered: [] };
    console.log("      coverage match=" + cov.matched + " uncovered=[" + cov.uncovered.join(", ") + "] offlineScore=" + r0.originalScore + "->" + r0.revisedScore);

    check(key + " coverage matched >= " + item.minMatched, cov.matched >= item.minMatched, "see offline coverage");

    if (item.untouched) {
      const unhanged = (r0.sentences || [])
        .filter((s) => !s.isImmutableFootnote)
        .filter((s) => String(s.original || "").trim() !== String(s.revised || "").trim());
      check(key + " master native prose untouched (0 altered prose sentences)", unhanged.length === 0, "altered: " + unhanged.map((s) => s.revised).slice(0, 3).join(" | "));
      check(key + " scores stay >= 98", r0.originalScore >= 98 && r0.revisedScore >= 98, String(r0.originalScore) + "->" + String(r0.revisedScore));
    }
  }

  // --- B: the census table -----------------------------------------------------
  console.log("");
  console.log("== Coverage census (matched vs present-but-uncovered) ==");
  console.log(String("field").padEnd(10) + String("matched").padEnd(9) + "uncovered patterns");
  for (const item of items) {
    const key = basename(item.file, ".txt");
    const runs = [];
    for (let i = 0; i < REPEATS; i++) runs.push(normalized(await runOffline(worker, databases, item, item.text)));
    const cov = runs[0].coverage || { matched: 0, uncovered: [] };
    console.log(String(key).padEnd(10) + String(cov.matched).padEnd(9) + (cov.uncovered.length ? cov.uncovered.join(" | ") : "(none — all detectable stiffness covered)"));
  }

  // --- D: live provider audit (opt-in) -----------------------------------------
  if (LIVE) {
    console.log("");
    console.log("== Live determinism (" + WORKER_URL + ", 3 runs each, provider audited) ==");
    for (const item of items) {
      const key = basename(item.file, ".txt");
      const runs = [];
      for (let i = 0; i < REPEATS; i++) {
        const { result, provider } = await runLive(databases, item, item.text);
        runs.push({ norm: normalized(result), provider });
      }
      const scores = runs.map((r) => r.norm.originalScore + "->" + r.norm.revisedScore).join(" | ");
      check(key + " live scores invariant across runs", new Set(scores ? runs.map((r) => r.norm.originalScore + "->" + r.norm.revisedScore) : []).size === 1, scores);
      const stableProvider = new Set(runs.map((r) => r.provider)).size === 1;
      console.log("      providers: " + runs.map((r) => r.provider).join(", "));
      if (stableProvider) {
        const sigs = new Set(runs.map((r) => JSON.stringify(r.norm)));
        check(key + " live bytes identical (stable provider)", sigs.size === 1);
      } else {
        console.log("      WARN provider changed mid-run (upstream outage) — byte identity N/A, scores above still enforced");
      }
    }
  }

  console.log("");
  console.log(passes + " passed, " + fails + " failed");
  if (fails > 0) {
    failures.forEach((f) => console.log("  - " + f));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});