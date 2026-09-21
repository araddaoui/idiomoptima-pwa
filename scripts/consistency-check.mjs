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
//   D. Re-banded scoring contract — honest, provider-independent scores measured
//      on what is LEFT (spelling / grammar / density-normalized stiffness),
//      snapped to the 95/98 display band: a flawless source prints 98, everything
//      else at most 95, and the revision earns the measured clearing back on a
//      compressed scale (cap 98). Residual census surfaced; exact input-pinned
//      reference profiles catch drift.
//   E. Residual-detector honesty + success-criteria — the deterministic grammar
//      layer no longer WRITES (Pass 1 is the model's), so offline we assert the
//      detector catches planted grammar defects and never grows them; the
//      success-criteria fixture proves DB-only Pass 2 fires on exactly the DB
//      phrases, preserves UK dialect/footnotes, and lands in the re-band target.
// Live mode (`--live` / LIVE=1) additionally POSTs the corpus to the deployed
// worker 3x each and asserts: scores identical on every run, output bytes
// identical whenever the SAME provider answered (provider is always gemini for
// both tiers; a change would mean an upstream event), and the LIVE-only grammar
// fixes for the success-criteria fixture actually landed.
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

// Each corpus item: { file, domain, tone, mode, minMatched, reference }
const CORPUS = [
  { file: "uae.txt", domain: "academic", tone: "formal", mode: "academic", minMatched: 6, reference: "60->92" },
  { file: "academic.txt", domain: "academic", tone: "formal", mode: "academic", minMatched: 6, reference: "60->92" },
  { file: "literary.txt", domain: "creative", tone: "reflective", mode: "academic", minMatched: 0, untouched: true },
  { file: "business.txt", domain: "business", tone: "professional", mode: "business", minMatched: 1, reference: "98->98" },
  { file: "general.txt", domain: "general", tone: "friendly", mode: "general", minMatched: 3, reference: "91->98" },
  { file: "military.txt", domain: "academic", tone: "formal", mode: "academic", minMatched: 6, reference: "77->95" },
  // Two-pass contract fixture: DB-only Pass 2 must fire on the planted phrases,
  // preserve UK dialect + footnotes, and the meter must land inside the re-band
  // target. Grammar/spelling correction is the model's job (Pass 1), so those
  // are asserted against the LIVE worker only (liveClean).
  { file: "success-criteria.txt", domain: "general", tone: "neutral", mode: "general", minMatched: 4, reference: "80->96", dbOnly: true, liveClean: true },
  // Real-world acceptance input (user-reported): DB-only Pass 2 must swap the
  // 5 covered phrases and leave the 2 census patterns uncovered; the model must
  // NOT restructure ("continuing Maxine Hong Kingston’s aesthetic…") and must
  // NOT introduce S-V regressions ("have the asset", "strongly brings").
  { file: "kingston.txt", domain: "academic", tone: "formal", mode: "academic", minMatched: 5, reference: "60->92", kingston: true, liveNoSVR: true },
  // Residual-detector honesty suite: the deterministic grammar layer is a
  // DETECTOR only (no writes), so offline we assert it catches the planted
  // defects in the source and never reports MORE in the revision.
  { file: "grammar.txt", domain: "academic", tone: "formal", mode: "academic", minMatched: 0, reference: "79->84", grammarDetector: true, minGrammar: 4 },
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
    sourceIssues: r.sourceIssues || {},
    remainingIssues: r.remainingIssues || {},
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
  // Gemini returns 503 (high demand) periodically; a "rescued" run (provider
  // "none", original text unchanged) is NOT a valid determinism sample, so
  // retry up to 2 extra times until we get a real gemini result. Truncated
  // streams (no final event) get the same treatment.
  const RESCUE_RETRIES = 1;
  let lastErr = null;
  for (let attempt = 0; attempt <= RESCUE_RETRIES; attempt++) {
    try {
      const res = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const out = await readNdjsonFinal(res);
      if ((out.result && out.result.rescued) === true || out.provider === "none") {
        lastErr = new Error("rescued (upstream 503) — retry " + (attempt + 1));
        if (attempt < RESCUE_RETRIES) {
          await new Promise((r) => setTimeout(r, 8000 + attempt * 5000));
          continue;
        }
        // Final attempt came back rescued: it is NOT a valid determinism sample,
        // so fail loudly instead of returning a no-op as if it were real.
        throw lastErr;
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (attempt < RESCUE_RETRIES) {
        await new Promise((r) => setTimeout(r, 8000 + attempt * 5000));
        continue;
      }
      // Final attempt failed too — live runs must never fake-pass.
      throw lastErr;
    }
  }
  throw lastErr || new Error("live run failed after " + (RESCUE_RETRIES + 1) + " attempts");
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

    // Residual scoring contract (provider-independent, length-normalized):
    //  - No flat 99: a clean revision can print at most 98, so the meter never
    //    converges every text to 99 (the defect the 2026-09-14 unfreeze fixed).
    //  - The residual census must be present and numeric on both sides.
    //  - item.reference pins the exact honest profile (source->revised) for the
    //    corpus so drift is caught deterministically.
    const rem = r0.remainingIssues || {};
    check(key + " revisedScore <= 98 (no flat 99)", (r0.revisedScore || 0) <= 98, String(r0.originalScore) + "->" + String(r0.revisedScore));
    check(key + " residual census shape (spelling/grammar/stiffness numeric)",
      typeof rem.spelling === "number" && typeof rem.grammar === "number" && typeof rem.stiffness === "number",
      JSON.stringify(rem));
    if (item.reference) {
      check(key + " reference profile " + item.reference,
        String(r0.originalScore) + "->" + String(r0.revisedScore) === item.reference,
        String(r0.originalScore) + "->" + String(r0.revisedScore));
    }
    if (item.grammarDetector) {
      const src = r0.sourceIssues || {};
      check(key + " grammar defects detected in source (" + item.minGrammar + "+)", (src.grammar || 0) >= item.minGrammar, "src grammar=" + src.grammar);
      check(key + " residual grammar never grows in the revision (detector-only)", (rem.grammar || 0) <= (src.grammar || 0), "src=" + src.grammar + " rem=" + rem.grammar);
    }

    if (item.dbOnly) {
      const fv = r0.finalVersion || "";
      // DB-only Pass 2 fired the planted phrases...
      check(key + " DB rule fired: robust framework -> solid framework", /solid framework/.test(fv), "saw " + fv.slice(0, 220));
      check(key + " DB rule fired: it is important to note that -> note that", /note that/.test(fv) && !/it is important to note that/.test(fv), "saw " + fv.slice(0, 220));
      check(key + " DB rule fired: it is worth noting -> note that", /note that/.test(fv) && !/it is worth noting/.test(fv), "saw " + fv.slice(0, 220));
      check(key + " DB rule fired: navigate these challenges -> handle these challenges", /handle these challenges/.test(fv) && !/navigate these challenges/.test(fv), "saw " + fv.slice(0, 220));
      // ...and left UK dialect + footnote block intact.
      check(key + " UK dialect preserved (colonisation/travelled/labelled/characterisation)",
        ["colonisation", "travelled", "labelled", "characterisation"].every((w) => new RegExp(w, "i").test(fv)), "saw " + fv.slice(0, 260));
      check(key + " footnote block preserved", /\[1\] Clausewitz/.test(fv) && /\[2\] Ibid/.test(fv), "saw " + fv.slice(-160));
      // Re-band target: source never prints above 90 with measurable defects and
      // the revision lands >= 90 (the "heavy vs barely" swing is the fix).
      check(key + " originalScore <= 90 (source carries 4 measurable defects)", (r0.originalScore || 0) <= 90, String(r0.originalScore));
      check(key + " revisedScore >= 90 AND <= 98", (r0.revisedScore || 0) >= 90 && (r0.revisedScore || 0) <= 98, String(r0.revisedScore));
    }

    if (item.kingston) {
      const fv = r0.finalVersion || "";
      // Deterministic Pass-2 swaps (DB-only) must all land offline.
      check(key + " DB rule fired: remaining within the continuity of -> continuing", /continuing Maxine Hong Kingston/.test(fv) && !/remaining within the continuity of/.test(fv), "saw " + fv.slice(0, 260));
      check(key + " DB rule fired: have affinities with each other -> share affinities", /share affinities/.test(fv) && !/have affinities with each other/.test(fv), "saw " + fv.slice(0, 260));
      check(key + " DB rule fired: lends itself basically to the mere fact that -> rests essentially on the fact that", /rests essentially on the fact that/.test(fv), "saw " + fv.slice(0, 260));
      check(key + " DB rule fired: within the parameters of -> within the bounds of", /within the bounds of/.test(fv) && !/within the parameters of/.test(fv), "saw " + fv.slice(0, 260));
      check(key + " DB rule fired: underpinning representation -> underlying representation", /underlying representation/.test(fv) && !/underpinning representation/.test(fv), "saw " + fv.slice(0, 260));
      // The two census patterns must stay uncovered (by design).
      const unc = (r0.coverage || {}).uncovered || [];
      check(key + " census keeps 'the mere fact that' + 'such a common denominator' uncovered (never auto-edited)",
        unc.includes("the mere fact that") && unc.includes("such a common denominator"), JSON.stringify(unc));
    }

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
      // LIVE-only grammar/spelling asserts: Pass 1 (the model) must actually fix
      // the planted defects — the offline path can't, by contract.
      if (item.liveClean) {
        for (const r of runs) {
          const fv = r.norm.finalVersion || "";
          check(key + " live: spelling fixed (no 'challanges'/'underlaying')", !/challanges|underlaying/.test(fv), "still saw " + fv.slice(0, 260));
          check(key + " live: grammar fixed (demonstration -> demonstrate)", /demonstrate(?:s|d)? that the solid/.test(fv) || /demonstrat(e|ing)/i.test(fv), "still saw " + fv.slice(0, 260));
        }
      }
      // LIVE-only model-honesty assert: Pass 1 must not INTRODUCE grammar
      // regressions (the old multi-provider path turned "has the asset" into
      // "have the asset" and "bring" into "brings"). grammar/spelling-only pass
      // must leave correct S-V untouched.
      if (item.liveNoSVR) {
        for (const r of runs) {
          const fv = r.norm.finalVersion || "";
          check(key + " live: no S-V regression ('has the asset' kept, no 'have the asset')", /has the asset/.test(fv) && !/have the asset/.test(fv), "saw " + fv.slice(0, 300));
          check(key + " live: no S-V regression ('strongly bring to mind' kept, no 'strongly brings')", /strongly bring to mind/.test(fv) && !/strongly brings/.test(fv), "saw " + fv.slice(0, 300));
        }
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