// Live end-to-end payload probe (anonymous -> no usage increment, no quota auth).
// Mirrors EXACTLY what the browser sends: ToolPage loads/merges the three
// ai-natural-database files by longest-JSON-wins, and geminiService maps
// aiPhraseMap/idiomDatabase/aiSuggestions/lexicalDatabases ->
// aiDb/idiomDb/suggestDb/lexicalDb. Getting this wrong makes the worker silently
// fall back to its 25-entry DEFAULT_DATABASES floor and report stiffness 0.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = process.env.PUBLIC_DIR || join(ROOT, "public");
const FIXTURE = process.env.TEXT_FILE || join(ROOT, "scripts", "perf", "big800.txt");
const URL = process.env.WORKER_URL || "https://nativewrite-api.nativewrite-api.workers.dev";
const N = Number(process.env.N || 3);

const j = (f) => JSON.parse(readFileSync(join(PUBLIC, f), "utf8"));

// --- ToolPage's aiDb merge, verbatim in behaviour -------------------------
const merged = new Map();
for (const f of ["ai-natural-database.json", "ai-natural-database-1500.json", "ai-natural-database-1000.json"]) {
  let db = [];
  try { db = j(f); } catch { db = []; }
  for (const entry of db) {
    const key = (entry.ai || entry.clunky || "").toLowerCase().trim();
    if (key && (entry.natural || entry.native)) {
      const existing = merged.get(key);
      if (!existing || JSON.stringify(entry).length > JSON.stringify(existing).length) merged.set(key, entry);
    }
  }
}
const lexicalDb = {};
for (const d of ["academic", "business", "creative", "general"]) {
  try { lexicalDb[d] = j(`lexical-${d}.json`); } catch { lexicalDb[d] = []; }
}
let idiomDb = [], suggestDb = [];
try { idiomDb = j("idioms-clunky-native.json"); } catch {}
try { suggestDb = j("ai-suggestions.json"); } catch {}

const databases = { aiDb: [...merged.values()], idiomDb, suggestDb, lexicalDb };
const text = readFileSync(FIXTURE, "utf8");
console.log("payload: aiDb=" + databases.aiDb.length + " idiomDb=" + idiomDb.length +
  " suggestDb=" + suggestDb.length + " lexical=" + Object.values(lexicalDb).map((v) => v.length).join("/") +
  "  text=" + text.trim().split(/\s+/).length + " words  (" + (JSON.stringify(databases).length / 1048576).toFixed(2) + " MB)");

let ok = 0, truncated = 0, http503 = 0;
for (let i = 1; i <= N; i++) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(URL + "/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, domain: "academic", tone: "formal", mode: "academic", databases }),
    });
  } catch (e) {
    console.log(`  run ${i}: NETWORK ERROR ${e.message}`); continue;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const body = Buffer.from(await res.arrayBuffer()).toString("utf8");
  if (!res.ok) { http503++; console.log(`  run ${i}: HTTP ${res.status} in ${secs}s :: ${body.slice(0, 220)}`); continue; }
  // NDJSON: progress events terminated by ev:"final" -> take the LAST final.
  let final = null;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e.ev === "final") final = e.result; } catch {}
  }
  if (!final) { truncated++; console.log(`  run ${i}: TRUNCATED (no final event) in ${secs}s, ${body.length} bytes`); continue; }
  ok++;
  const r = final;
  console.log(`  run ${i}: ok in ${secs}s  provider=${r.provider}  ${r.originalScore}->${r.revisedScore}  ` +
    `sents=${r.sentences?.length}  stats=${JSON.stringify(r.databaseStats || {})}  cov=${JSON.stringify(r.coverage?.matched)}/${(r.coverage?.uncovered || []).length}`);
}
console.log(`\ncompleted=${ok}/${N}  httpErrors=${http503}  truncated=${truncated}`);
process.exitCode = ok === N ? 0 : 1;