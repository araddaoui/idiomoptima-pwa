export interface SentenceResult {
  original: string;
  revised: string;
  suggestions?: string[];
  explanation?: string;
  isImmutableFootnote?: boolean;
  paragraphIndex?: number;
}

export interface TransformationResult {
  originalScore: number;
  revisedScore: number;
  finalVersion: string;
  sentences: SentenceResult[];
  suggestions: string[];
  explanation: string;
  detectedDialect: string;
  appliedMode?: string;
  provider?: string;
  timing?: {
    provider: string;
    totalMs: number;
    attempts: { provider: string; ms: number; ok: boolean; skipped?: boolean }[];
  };
  databaseStats?: {
    idiomReplacements: number;
    aiPhraseReplacements: number;
    lexicalReplacements: number;
    totalReplacements: number;
    sentencesChanged?: number;
  };
  // One-sentence transparency line about the nativization layer (rules sent to
  // the model vs deterministic backstop applied). Rendered as its own card in
  // the Notes tab, NOT as a numbered suggestion.
  databaseLine?: string;
  // Coverage census (worker-computed): how many stiff phrases the rule set
  // matched in the source vs. common stiff patterns present but not covered by
  // any rule (left to the model/author). Rendered as a transparency note.
  coverage?: {
    matched: number;
    uncovered: string[];
  };
  tier?: string;
  usage?: number;
  // Rescue honesty: set when the provider produced no usable revision and the
  // original text was returned unchanged (safe DB rules still apply). Such runs
  // do NOT count against the daily limit. providerErrors explains why.
  rescued?: boolean;
  providerErrors?: string[];
  // Residual-defect census (worker-computed): unambiguous counts measured in the
  // source vs what remains in the revision, so the rubric is explainable.
  sourceIssues?: { spelling: number; grammar: number; stiffness: number };
  remainingIssues?: { spelling: number; grammar: number; stiffness: number };
  // Phase C gated-humanize audit: residual-stiff sentences flagged for the
  // nativize model pass, how many were rewritten, and why it was skipped.
  humanize?: {
    flagged: number;
    changed: number;
    skippedReason?: string;
  };
  // Phase D scoring rubric: why the two scores landed where they did. The
  // worker computes it from the SAME deterministic meter the scores use; it is
  // descriptive only and never feeds back into the scores.
  rubric?: {
    display: { originalScore: number; revisedScore: number };
    meter: { source: number; revised: number; cleared: number; note: string };
    axes: {
      spelling: { source: number; remaining: number; sourceHealth: number; remainingHealth: number };
      grammar: { source: number; remaining: number; sourceHealth: number; remainingHealth: number };
      stiffness: {
        source: number; remaining: number; sourceHealth: number; remainingHealth: number;
        proseSentenceCount: number; rulesConsumed: number;
      };
      duplicates: { source: number; remaining: number; sourceHealth: number; remainingHealth: number };
    };
    banding: {
      anyChange: boolean;
      realChanges: number;
      dbRulesFired: number;
      boostApplied: number;
      nativizedRuleCount: number;
      spellingCapApplied: boolean;
      flatByContract: boolean;
      rule: string;
    };
    caveats: { coverageUncovered: number; semanticRiskSentences: number; humanizeSkipped?: string | null };
  };
}

const envAny = (import.meta as any).env || {};
export const WORKER_URL = envAny.VITE_WORKER_URL || envAny.VITE_API_URL || "https://nativewrite-api.nativewrite-api.workers.dev";

/**
 * Layer 1 - Mode Detection Engine (Heuristic)
 */
export function detectBestMode(text: string): { mode: string; reason: string } {
  const t = text.toLowerCase();
  
  const academicTriggers = ["theory", "framework", "analysis", "literature suggests", "empirical", "hypothesis", "methodology"];
  const citationMarkers = [/\[\d+\]/g, /\(\d{4}\)/g, /\([A-Z][a-z]+, \d{4}\)/g, /\bet al\./i, /DOI:/i];
  
  const hasAcademicVocab = academicTriggers.some(word => t.includes(word));
  const hasCitations = citationMarkers.some(regex => regex.test(text));

  if (hasAcademicVocab || hasCitations) {
    return { mode: "academic", reason: "Academic triggers (theory/analysis/citations) detected." };
  }

  const businessTriggers = ["stakeholders", "rollout", "alignment", "execution", "timeline", "budget", "operations", "coordination", "strategy"];
  const hasBusinessVocab = businessTriggers.some(word => t.includes(word));
  
  if (hasBusinessVocab) {
    return { mode: "business", reason: "Business triggers (operations/stakeholders/execution) detected." };
  }

  const creativeTriggers = [/\bI \w+/i, /\bme\b/i, /\bmy\b/i, /feeling/i, /breath/i, /silence/i, /whisper/i, /shadow/i, /metaphor/i];
  const hasCreativeVocab = creativeTriggers.some(regex => typeof regex === 'string' ? t.includes(regex) : regex.test(text));
  
  if (hasCreativeVocab) {
    return { mode: "creative", reason: "Creative/Reflective triggers detected." };
  }

  return { mode: "hybrid", reason: "Hybrid or default signals detected." };
}

interface UnifiedPhrase {
  source: string;
  target: string;
}

function normalizeToUnified(data: any[]): UnifiedPhrase[] {
  if (!data || !Array.isArray(data)) return [];
  return data
    .filter((e: any) => (e.ai || e.clunky) && (e.natural || e.native))
    .map((e: any) => ({
      source: (e.ai || e.clunky || "").trim(),
      target: (e.natural || e.native || "").trim(),
    }))
    .filter((e: UnifiedPhrase) => e.source.length > 0 && e.target.length > 0);
}

function applyReplacements(text: string, phrases: UnifiedPhrase[]): { text: string; count: number } {
  if (!phrases || phrases.length === 0) return { text, count: 0 };

  let result = text;
  let count = 0;
  const sorted = [...phrases].sort((a, b) => b.source.length - a.source.length);

  for (const { source, target } of sorted) {
    // A no-op (identity) "replace" is not a real edit — it must never inflate the
    // "AI-ese/idiom replaced" counter with a fake fix (e.g. "in short` -> "in short").
    if (!source || source === target) continue
    try {
      const regex = new RegExp("\\b" + source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "\\b", "gi");
      if (regex.test(result)) {
        result = result.replace(regex, target);
        count++;
      }
    } catch {}
  }

  return { text: result, count };
}

export async function transformText(
  text: string,
  domain: string,
  tone: string,
  forcedDialect?: string,
  onProgress?: (percent: number, chunkIndex: number, totalChunks: number, debugMessage?: string) => void,
  mode: string = "auto",
  databases?: {
    idiomDatabase?: any[];
    aiPhraseMap?: any[];
    lexicalDatabases?: Record<string, any[]>;
  },
  authToken?: string
): Promise<TransformationResult> {
  if (!text.trim()) {
    return {
      originalScore: 100,
      revisedScore: 100,
      finalVersion: "",
      sentences: [],
      suggestions: [],
      explanation: "Empty text processed.",
      detectedDialect: "US"
    };
  }

  let activeMode: string;
  let autoReason = "";

  if (mode === "auto" || !["academic", "business", "creative", "hybrid"].includes(mode)) {
    const detection = detectBestMode(text);
    activeMode = detection.mode;
    autoReason = detection.reason;
  } else {
    activeMode = mode;
  }

  if (onProgress) onProgress(10, 0, 1, "Connecting to server...");

  // Progress is driven entirely by real NDJSON events from the worker.
  // No fake timer — every tick the user sees is a genuine server milestone.

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text,
        domain,
        tone,
        forcedDialect,
        mode: activeMode,
        // The worker uses these for deterministic database enforcement (its
        // authority); the client then skips its own passes to avoid double-editing.
        databases: databases
          ? {
              aiDb: databases.aiPhraseMap || [],
              idiomDb: databases.idiomDatabase || [],
              lexicalDb: databases.lexicalDatabases || {},
            }
          : undefined,
      }),
    });

    // --- NDJSON stream consumption -------------------------------------------
    // If the worker returned an NDJSON stream, read it line-by-line and forward
    // each real milestone to onProgress. Both bars (paste + transform) receive
    // the SAME events, so they move on an identical timeline by construction.
    // If the worker returned a plain JSON error, fall back to legacy handling.

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.error || `Server error: ${response.status}`);
      (error as any).limitReached = Boolean(errorData.limitReached);
      (error as any).wordLimitReached = Boolean(errorData.wordLimitReached);
      (error as any).tier = errorData.tier;
      (error as any).usage = errorData.usage;
      (error as any).limit = errorData.limit;
      (error as any).wordLimit = errorData.wordLimit;
      (error as any).notEnglish = Boolean(errorData.notEnglish);
      throw error;
    }

    // Content-Type is a CORS-safelisted header, so it is always readable by
    // the browser even if the custom X-Transform-Stream header is not exposed
    // (older worker / CDN stripping). Trust either one.
    const isNdjson =
      response.headers.get("X-Transform-Stream") === "ndjson" ||
      (response.headers.get("Content-Type") || "").includes("application/x-ndjson");
    let data: TransformationResult;

    if (isNdjson && response.body) {
      // --- Stream path: real worker-driven progress -------------------------
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastPct = 10;
      let streamError: string | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let evt: any;
            try {
              evt = JSON.parse(line);
            } catch {
              continue;
            }
            if (evt.ev === "final") {
              data = evt.result;
            } else if (evt.ev === "error") {
              // Surface the worker's real failure instead of the generic no-final
              // message. A throw here used to be swallowed by the parse catch,
              // leaving only "Stream ended..." no matter what the worker said.
              streamError = evt.message || "The AI service is temporarily unavailable.";
              break;
            } else if (evt.ev === "phase" || evt.ev === "tick") {
              // Forward real worker milestones to both bars — monotonically
              // increasing, never fabricated.
              if (typeof evt.pct === "number" && evt.pct > lastPct) {
                lastPct = evt.pct;
              }
              if (onProgress) onProgress(lastPct, 0, 1, evt.phase || "Working...");
            }
          }
          if (streamError) break;
        }
      } catch (e) {
        // Network/browser stream error: the edge dropped the connection without
        // emitting a worker error event (e.g. during a long provider wait).
        streamError = (e as Error)?.message || "The connection to the transformation server was lost.";
      } finally {
        reader.releaseLock();
      }

      if (!data!) {
        throw new Error(streamError || "Stream ended without a final result from the worker.");
      }
    } else {
      // --- Legacy fallback: old worker returns plain JSON -------------------
      if (onProgress) onProgress(95, 0, 1, "Finalizing...");
      try {
        data = await response.json();
      } catch {
        throw new Error("Unexpected response format from the server (expected JSON but received NDJSON/stream). Please reload the page.");
      }
    }

    // The worker enforces the databases deterministically and reports
    // `databaseStats` ({ totalMatches, aiPhrases, idioms, lexical,
    // sentencesChanged }). Map it onto the canonical client shape, and only run
    // the client-side replacement passes when those stats are ABSENT (older
    // worker / direct invocation) so edits and counts are never applied twice.
    let serverStats: TransformationResult["databaseStats"] & { sentencesChanged?: number } | null = null;
    const rawStats: any = (data as any).databaseStats;
    if (rawStats && typeof rawStats.totalMatches === "number") {
      serverStats = {
        idiomReplacements: rawStats.idioms || 0,
        aiPhraseReplacements: rawStats.aiPhrases || 0,
        lexicalReplacements: rawStats.lexical || 0,
        totalReplacements: rawStats.totalMatches || 0,
        sentencesChanged: rawStats.sentencesChanged || 0,
      };
      data.databaseStats = serverStats;
    }

    let idiomReplacements = serverStats?.idiomReplacements || 0;
    let aiPhraseReplacements = serverStats?.aiPhraseReplacements || 0;
    let lexicalReplacements = serverStats?.lexicalReplacements || 0;

    if (!serverStats) {
      // Post-Worker replacements: idiom + AI phrases (applied to .revised only, .original untouched)
      if (databases?.idiomDatabase && databases.idiomDatabase.length > 0) {
        const unified = normalizeToUnified(databases.idiomDatabase);
        if (data.sentences && data.sentences.length > 0) {
          data.sentences = data.sentences.map(sentence => {
            if (sentence.isImmutableFootnote) return sentence;
            const result = applyReplacements(sentence.revised, unified);
            idiomReplacements += result.count;
            return { ...sentence, revised: result.text };
          });
        }
        const finalResult = applyReplacements(data.finalVersion, normalizeToUnified(databases.idiomDatabase));
        idiomReplacements += finalResult.count;
        data.finalVersion = finalResult.text;
      }

      if (databases?.aiPhraseMap && databases.aiPhraseMap.length > 0) {
        const unified = normalizeToUnified(databases.aiPhraseMap);
        if (data.sentences && data.sentences.length > 0) {
          data.sentences = data.sentences.map(sentence => {
            if (sentence.isImmutableFootnote) return sentence;
            const result = applyReplacements(sentence.revised, unified);
            aiPhraseReplacements += result.count;
            return { ...sentence, revised: result.text };
          });
        }
        const finalResult = applyReplacements(data.finalVersion, unified);
        aiPhraseReplacements += finalResult.count;
        data.finalVersion = finalResult.text;
      }

      // Activate lexical databases for the detected domain
      if (databases?.lexicalDatabases && databases.lexicalDatabases[domain] && databases.lexicalDatabases[domain].length > 0) {
        const unified = normalizeToUnified(databases.lexicalDatabases[domain]);
        if (data.sentences && data.sentences.length > 0) {
          data.sentences = data.sentences.map(sentence => {
            if (sentence.isImmutableFootnote) return sentence;
            const result = applyReplacements(sentence.revised, unified);
            lexicalReplacements += result.count;
            return { ...sentence, revised: result.text };
          });
        }
        const finalResult = applyReplacements(data.finalVersion, unified);
        lexicalReplacements += finalResult.count;
        data.finalVersion = finalResult.text;
      }
    }

    // Attach database stats
    const totalReplacements = idiomReplacements + aiPhraseReplacements + lexicalReplacements;
    data.databaseStats = { idiomReplacements, aiPhraseReplacements, lexicalReplacements, totalReplacements };

    // Add database stats to suggestions — always show checked vs applied for transparency
    const idiomTotal = databases?.idiomDatabase?.length || 0;
    const aiTotal = databases?.aiPhraseMap?.length || 0;
    const lexTotal = databases?.lexicalDatabases?.[domain]?.length || 0;
    const dbLine = serverStats
      ? `Nativization: ${aiTotal} AI-ese, ${idiomTotal} idiom(s), ${lexTotal} lexical (${domain}) phrase rules in the deterministic backstop, applied ${aiPhraseReplacements}/${idiomReplacements}/${lexicalReplacements} (grammar/spelling handled by the model).`
      : `Database: checked ${aiTotal} AI-ese, ${idiomTotal} idiom(s), ${lexTotal} lexical (${domain}) — applied ${aiPhraseReplacements}/${idiomReplacements}/${lexicalReplacements} (total ${totalReplacements}).`;
    data.databaseLine = dbLine;

    if (onProgress) onProgress(100, 1, 1, "Complete!");

    if (mode === "auto") {
      data.explanation = (data.explanation || "") + ` [Auto-Selected Mode: ${activeMode}] - ${autoReason}`;
      data.appliedMode = activeMode;
    }

    return data;
  } catch (error: any) {
    console.error("Worker request failed:", error);
    const finalError = new Error(`Transformation failed: ${error.message || "Server unavailable"}`);
    if (error && (error as any).limitReached) {
      (finalError as any).limitReached = true;
      (finalError as any).tier = (error as any).tier;
      (finalError as any).usage = (error as any).usage;
      (finalError as any).limit = (error as any).limit;
    }
    if (error && (error as any).wordLimitReached) {
      (finalError as any).wordLimitReached = true;
      (finalError as any).tier = (error as any).tier;
      (finalError as any).usage = (error as any).usage;
      (finalError as any).limit = (error as any).limit;
      (finalError as any).wordLimit = (error as any).wordLimit;
    }
    if (error && (error as any).notEnglish) {
      (finalError as any).notEnglish = true;
    }
    throw finalError;
  }
}
