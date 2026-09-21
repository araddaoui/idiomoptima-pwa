import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WORKER_URL = process.env.VITE_WORKER_URL || "http://127.0.0.1:8788";

function printUsage() {
  console.log(`
IdiomOptima Local Dev Transform Tool
====================================
POSTs text directly to your local Cloudflare Worker on port 8788.
Does NOT require a Clerk sign-in (anonymous requests bypass usage limits).

Usage:
  node scripts/dev-transform.mjs --text "your text here" [--domain <domain>] [--tone <tone>] [--mode <mode>] [--json]
  node scripts/dev-transform.mjs --file path/to/file.txt [--domain <domain>] [--tone <tone>] [--mode <mode>] [--json]

Options:
  --domain    academic (default), business, creative, general
  --tone      formal (default), professional, friendly, reflective, neutral
  --mode      academic (default), business, general
  --json      Output raw worker JSON instead of a formatted rubric breakdown
`);
  process.exit(1);
}

// Minimal argument parser
const args = process.argv.slice(2);
let text = "";
let domain = "academic";
let tone = "formal";
let mode = "academic";
let rawJsonMode = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--text") {
    text = args[++i];
  } else if (arg === "--file") {
    const filePath = args[++i];
    if (!existsSync(filePath)) {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }
    text = readFileSync(filePath, "utf8");
  } else if (arg === "--domain") {
    domain = args[++i];
  } else if (arg === "--tone") {
    tone = args[++i];
  } else if (arg === "--mode") {
    mode = args[++i];
  } else if (arg === "--json") {
    rawJsonMode = true;
  } else if (arg === "--help" || arg === "-h") {
    printUsage();
  }
}

if (!text || !text.trim()) {
  console.error("Error: No input text provided.");
  printUsage();
}

console.log(`Sending request to ${WORKER_URL}...`);
console.log(`Configuration: domain=${domain}, tone=${tone}, mode=${mode}\n`);

const payload = {
  text,
  domain,
  tone,
  mode,
};

try {
  const response = await fetch(WORKER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`HTTP ${response.status} Error:`, errText);
    process.exit(1);
  }

  // Parse NDJSON response stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.ev === "phase" || evt.ev === "tick") {
          if (!rawJsonMode) {
            console.log(`[${evt.pct}%] ${evt.phase}`);
          }
        } else if (evt.ev === "error") {
          console.error("\nPipeline Error:", evt.message);
          if (evt.detail) console.error("Details:", evt.detail);
          process.exit(1);
        } else if (evt.ev === "final") {
          finalResult = evt.result;
        }
      } catch (e) {
        // Line-split or chunk parse issue
      }
    }
  }

  if (!finalResult) {
    console.error("\nError: Stream completed without a final result event.");
    process.exit(1);
  }

  if (rawJsonMode) {
    console.log(JSON.stringify(finalResult, null, 2));
    process.exit(0);
  }

  // Beautiful formatting
  console.log("\n==============================================");
  console.log("             TRANSFORMATION COMPLETED         ");
  console.log("==============================================");
  console.log(`Scores  : ${finalResult.originalScore} -> ${finalResult.revisedScore}`);
  console.log(`Provider: ${finalResult.provider} ${finalResult.rescued ? "(RESCUED - not counted against quota)" : ""}`);
  console.log(`Dialect : ${finalResult.detectedDialect}`);
  
  if (finalResult.rubric) {
    const r = finalResult.rubric;
    console.log("\n[SCORING RUBRIC]");
    console.log(`  Residual Meter: ${r.meter.source} -> ${r.meter.revised} (cleared: ${r.meter.cleared})`);
    console.log("  Axes Metrics  :");
    
    const printAxis = (name, axis) => {
      const label = name.padEnd(15);
      console.log(`    - ${label}: ${axis.source} -> ${axis.remaining}  (health: ${axis.sourceHealth} -> ${axis.remainingHealth})`);
    };
    
    printAxis("Spelling", r.axes.spelling);
    printAxis("Grammar", r.axes.grammar);
    printAxis("Stiffness", r.axes.stiffness);
    printAxis("Duplicates", r.axes.duplicates);
    
    console.log("\n  Banding Decision:");
    console.log(`    - Changes detected : ${r.banding.realChanges} real sentence change(s)`);
    console.log(`    - DB rules matched : ${r.banding.dbRulesFired} rule match(es)`);
    if (r.banding.boostApplied > 0) {
      console.log(`    - Score boost      : +${r.banding.boostApplied}`);
    }
    if (r.banding.spellingCapApplied) {
      console.log("    - Spelling cap     : active (capped both scores at 80)");
    }
    if (r.banding.flatByContract) {
      console.log("    - Flat contract    : active (scored exactly like source, no phantom credit)");
    }
  }

  if (finalResult.humanize) {
    const h = finalResult.humanize;
    console.log("\n[GATED HUMANIZE AUDIT]");
    console.log(`  Flagged sentences: ${h.flagged}`);
    console.log(`  Rewritten        : ${h.changed}`);
    if (h.skippedReason) {
      console.log(`  Skipped reason   : ${h.skippedReason}`);
    }
  }

  if (finalResult.databaseStats) {
    console.log("\n[DETERMINISTIC DATABASE ACTIVITY]");
    const ds = finalResult.databaseStats;
    console.log(`  Total Matches : ${ds.totalMatches ?? 0}`);
    console.log(`  AI Phrases    : ${ds.aiPhrases ?? 0}`);
    console.log(`  Idioms        : ${ds.idioms ?? 0}`);
    console.log(`  Lexical       : ${ds.lexical ?? 0}`);
  }

  if (finalResult.coverage) {
    console.log("\n[COVERAGE CENSUS]");
    console.log(`  Matched stiff phrases: ${finalResult.coverage.matched}`);
    if (finalResult.coverage.uncovered && finalResult.coverage.uncovered.length > 0) {
      console.log(`  Present but uncovered: ${finalResult.coverage.uncovered.join(", ")}`);
    } else {
      console.log("  Present but uncovered: none");
    }
  }

  if (finalResult.sentences && finalResult.sentences.length > 0) {
    console.log("\n==============================================");
    console.log("               SENTENCE CHANGES               ");
    console.log("==============================================");
    let changeIndex = 1;
    finalResult.sentences.forEach(s => {
      if (s.isImmutableFootnote) return;
      const isChanged = (s.original || "").trim() !== (s.revised || "").trim();
      if (isChanged) {
        console.log(`\n${changeIndex++}. Original: "${s.original}"`);
        console.log(`   Revised : "${s.revised}"`);
        if (s.explanation && s.explanation !== "No corrections needed.") {
          console.log(`   Note    : ${s.explanation}`);
        }
      }
    });
    if (changeIndex === 1) {
      console.log("\n(No sentences were changed.)");
    }
  }

  console.log("\n==============================================\n");

} catch (error) {
  console.error("Fatal request failure:", error.message || error);
}
