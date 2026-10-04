#!/usr/bin/env node
// Resource profiler for the IdiomOptima worker. Drives the REAL worker offline
// (no provider keys => the deterministic rescue path, which is where all of the
// deterministic cost lives) with the SAME database payload the client ships.
//
// The point of this harness is the Workers per-invocation CEILINGS, not latency:
//
//   MEMORY  128 MB, shared by the Free AND the Paid plan. Exceeding it returns
//           HTTP 503 "exceeded resource limits" -- the failure that made every
//           live transform carrying a real database payload fail. This is the
//           binding constraint (see AGENTS.md).
//   CPU     10 ms on Free, 30 s on Paid. Only CPU *time* is counted; network
//           wait is not, so the model call is invisible here on purpose.
//
// big800.txt is pinned in scripts/perf/ rather than scripts/corpus/ because it
// is a resource fixture, not a scoring fixture: it is an 812-word document,
// i.e. the largest the free tier's 800-word cap accepts, which is exactly where
// the memory ceiling was breached.
//
// Usage:
//   node scripts/perf/profile.mjs                 per-fixture CPU table (warm)
//   node scripts/perf/profile.mjs mem <fixture>   peak RSS + heap for ONE request
//   node scripts/perf/profile.mjs loop <f> <n>    per-request CPU, N iterations
//   node scripts/perf/profile.mjs cmp             baseline vs $WORKER_SRC identity
//
// `cmp` is the gate that matters for any optimization: it asserts the patched
// worker returns byte-identical output (finalVersion, both scores, provider,
// diagnostics and the full sentences array) across the whole corpus.

import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS_DIR = join(ROOT, "scripts", "corpus");
const PERF_DIR = join(ROOT, "scripts", "perf");

function loadDb() {
  const ai = JSON.parse(readFileSync(join(ROOT, "public", "ai-natural-database.json"), "utf8"));
  const idioms = JSON.parse(readFileSync(join(ROOT, "public", "idioms-clunky-native.json"), "utf8"));
  const lex = {};
  for (const k of ["academic", "business", "creative", "general"]) {
    lex[k] = JSON.parse(readFileSync(join(ROOT, "public", `lexical-${k}.json`), "utf8"));
  }
  return { aiDb: ai, idiomDb: idioms, lexicalDb: lex, suggestDb: JSON.parse(readFileSync(join(ROOT, "public", "ai-suggestions.json"), "utf8")) };
}

async function loadWorkerSrc(srcPath) {
  const tmp = mkdtempSync(join(tmpdir(), "nw-prof-"));
  const f = join(tmp, "worker.mjs");
  writeFileSync(f, readFileSync(srcPath, "utf8"));
  return (await import(pathToFileURL(f).href)).default;
}
const loadWorker = () => loadWorkerSrc(process.env.WORKER_SRC || join(ROOT, "index.js"));

async function readFinal(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", result = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt; try { evt = JSON.parse(line); } catch { continue; }
      if (evt.ev === "final") result = evt.result;
      if (evt.ev === "error") throw new Error("worker error: " + evt.message);
    }
  }
  if (!result) throw new Error("stream ended without a final event (truncated by the platform)");
  return result;
}

async function once(worker, db, item, text) {
  const req = new Request("https://worker.local/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, domain: item.domain, tone: item.tone, mode: item.mode, databases: db }),
  });
  return readFinal(await worker.fetch(req, {}));
}

const CORPUS = [
  { file: "general.txt", domain: "general", tone: "friendly", mode: "general" },
  { file: "academic.txt", domain: "academic", tone: "formal", mode: "academic" },
  { file: "literary.txt", domain: "creative", tone: "reflective", mode: "academic" },
  { file: "business.txt", domain: "business", tone: "professional", mode: "business" },
  { file: "kingston.txt", domain: "academic", tone: "formal", mode: "academic" },
  { file: "big800.txt", dir: PERF_DIR, domain: "academic", tone: "formal", mode: "academic" },
].map((c) => ({ ...c, path: () => join(c.dir || CORPUS_DIR, c.file) }));

const find = (name) => CORPUS.find((c) => c.file === name || c.file === name + ".txt") || CORPUS[0];
const mode = process.argv[2] || "table";

if (mode === "mem") {
  const item = find(process.argv[3] || "big800");
  const text = readFileSync(item.path(), "utf8");
  const db = loadDb();
  let peakRss = 0, peakHeap = 0;
  const t = setInterval(() => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  }, 5);
  const worker = await loadWorker();
  const before = process.memoryUsage().rss;
  const r = await once(worker, db, item, text);
  clearInterval(t);
  const after = process.memoryUsage();
  peakRss = Math.max(peakRss, after.rss);
  console.log(JSON.stringify({
    file: item.file,
    words: text.trim().split(/\s+/).length,
    sentences: r?.sentences?.length ?? 0,
    rssBeforeMB: +(before / 1048576).toFixed(1),
    peakRssMB: +(peakRss / 1048576).toFixed(1),
    peakHeapMB: +(peakHeap / 1048576).toFixed(1),
    finalHeapMB: +(after.heapUsed / 1048576).toFixed(1),
  }));
} else if (mode === "cmp") {
  const base = await loadWorkerSrc(join(ROOT, "index.js"));
  const proto = await loadWorkerSrc(process.env.WORKER_SRC || join(ROOT, "index.js"));
  const db = loadDb();
  let bad = 0;
  for (const item of CORPUS) {
    const text = readFileSync(item.path(), "utf8");
    const a = await once(base, db, item, text);
    const b = await once(proto, db, item, text);
    const keys = ["finalVersion", "originalScore", "revisedScore", "provider", "diagnostics"];
    const diffs = keys.filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
    const sa = JSON.stringify(a?.sentences), sb = JSON.stringify(b?.sentences);
    if (diffs.length || sa !== sb) {
      bad++;
      console.log(`  DIFF ${item.file}: fields=[${diffs.join(",")}] sentencesEqual=${sa === sb}`);
      for (const k of diffs) {
        console.log(`    base.${k} = ${JSON.stringify(a?.[k])?.slice(0, 300)}`);
        console.log(`    prot.${k} = ${JSON.stringify(b?.[k])?.slice(0, 300)}`);
      }
    } else {
      console.log(`  IDENTICAL ${item.file}  (${a?.originalScore}->${a?.revisedScore}, ${a?.sentences?.length} sents)`);
    }
  }
  console.log(bad === 0 ? "ALL IDENTICAL" : `${bad} FIXTURE(S) DIVERGED`);
  process.exitCode = bad === 0 ? 0 : 1;
} else if (mode === "loop") {
  const item = find(process.argv[3] || "big800");
  const N = Number(process.argv[4] || 40);
  const text = readFileSync(item.path(), "utf8");
  const db = loadDb();
  const worker = await loadWorker();
  await once(worker, db, item, text); // warm the JIT
  const c0 = process.cpuUsage();
  for (let i = 0; i < N; i++) await once(worker, db, item, text);
  const c1 = process.cpuUsage(c0);
  const words = text.trim().split(/\s+/).length;
  const per = (c1.user + c1.system) / 1000 / N;
  console.log(JSON.stringify({
    file: item.file, iters: N, words,
    perReqCpuMs: +per.toFixed(1),
    cpuPerKWord: +(per / (words / 1000)).toFixed(1),
  }));
} else {
  console.log("file            words  warmCpuMs  ms/1000w");
  const db = loadDb();
  const worker = await loadWorker();
  for (const item of CORPUS) {
    const text = readFileSync(item.path(), "utf8");
    const words = text.trim().split(/\s+/).length;
    await once(worker, db, item, text); // warm up JIT
    const N = 3;
    const c0 = process.cpuUsage();
    for (let i = 0; i < N; i++) await once(worker, db, item, text);
    const c1 = process.cpuUsage(c0);
    const per = (c1.user + c1.system) / 1000 / N;
    console.log(
      item.file.padEnd(16) + String(words).padStart(5) +
      per.toFixed(1).padStart(11) + (per / (words / 1000)).toFixed(1).padStart(11)
    );
  }
  console.log("\npeak RSS on the 812-word fixture (budget 115 MB, Workers ceiling 128 MB):");
  console.log("  npm run profile -- mem big800");
}