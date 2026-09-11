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
  databaseStats?: {
    idiomReplacements: number;
    aiPhraseReplacements: number;
    lexicalReplacements: number;
    totalReplacements: number;
    sentencesChanged?: number;
  };
}

const envAny = (import.meta as any).env || {};
const WORKER_URL = envAny.VITE_WORKER_URL || envAny.VITE_API_URL || "https://nativewrite-api.nativewrite-api.workers.dev";

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

  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let progressValue = 10;

  if (onProgress) {
    progressTimer = setInterval(() => {
      if (progressValue < 90) {
        progressValue += Math.random() * 4 + 1;
        if (progressValue > 90) progressValue = 90;
        onProgress(Math.round(progressValue), 0, 1, progressValue < 30 ? "Connecting to server..." : progressValue < 60 ? "Nativizing text..." : "Refining output...");
      }
    }, 800);
  }

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

    if (progressTimer) clearInterval(progressTimer);
    if (onProgress) onProgress(95, 0, 1, "Finalizing...");

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Server error: ${response.status}`);
    }

    const data: TransformationResult = await response.json();

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
      ? `Nativization: ${aiTotal} AI-ese, ${idiomTotal} idiom(s), ${lexTotal} lexical (${domain}) phrase rules sent to the model; deterministic backstop applied ${aiPhraseReplacements}/${idiomReplacements}/${lexicalReplacements} (model handled the rest).`
      : `Database: checked ${aiTotal} AI-ese, ${idiomTotal} idiom(s), ${lexTotal} lexical (${domain}) — applied ${aiPhraseReplacements}/${idiomReplacements}/${lexicalReplacements} (total ${totalReplacements}).`;
    data.suggestions = [...(data.suggestions || []), dbLine];

    if (onProgress) onProgress(100, 1, 1, "Complete!");

    if (mode === "auto") {
      data.explanation = (data.explanation || "") + ` [Auto-Selected Mode: ${activeMode}] - ${autoReason}`;
      data.appliedMode = activeMode;
    }

    return data;
  } catch (error: any) {
    if (progressTimer) clearInterval(progressTimer);
    console.error("Worker request failed:", error);
    throw new Error(`Transformation failed: ${error.message || "Server unavailable"}`);
  }
}
