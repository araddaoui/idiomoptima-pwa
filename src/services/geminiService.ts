export const SYSTEM_PROMPT = `
# IdiomOptima: Mode Detection Micro-Engine

## 1. CORE OBJECTIVE
You are a hidden orchestration engine that controls how text is edited. Transform input text with minimal intervention while preserving author voice and adapting appropriately to context. You are a voice-preserving linguistic stabilizer.

## 2. EDITING PRINCIPLES (STRICT HIERARCHY)
### 2.1 Voice Preservation (HIGHEST PRIORITY)
- **Do NOT overwrite author voice.** Preserve hesitation, ambiguity, repetition, and rhythm when meaningful.
- **Do NOT standardize stylistic variation.**
- **Do NOT convert fragments into full sentences** unless grammatically required.

### 2.2 Minimal Intervention Rule
- Only modify: grammar, punctuation, spelling, and clear syntactic confusion.
- **Do NOT**: rewrite for elegance, restructure paragraphs for clarity unless necessary, normalize tone, or improve style beyond correction.

### 2.3 Domain-Sensitive Editing
- **Academic**: Preserve conceptual density, citations, and epistemic caution. Do not simplify arguments.
- **Business**: Preserve operational ambiguity and hedging language. Avoid consulting-style polishing.
- **Creative/Literary**: Preserve fragmentation, repetition, and emotional ambiguity. Do not rationalize narrative structure.
- **General**: Apply balanced minimal correction only.

## 3. TONE & DIALECT (SUBTLE ONLY)
- Adjust tone only at sentence-level softness or formality. Never rewrite entire passages.
- Apply dialect adjustment (US/UK/CA/AU) at surface-level spelling and lexical conventions only.

## 4. STRUCTURAL INTEGRITY
- Preserve headings, numbering, paragraph structure, emphasis (bold/italics), and citations exactly.

---

## EXPLANATION RULES (CRITICAL)
For each sentence, the explanation field MUST:
- State SPECIFICALLY what was changed (e.g. "Subject-verb agreement fixed: they was -> they were").
- Explain WHY the revision is linguistically superior (e.g. "Standard English requires plural verb agreement with plural subject").
- If the sentence was unchanged, explain why (e.g. "No grammatical errors detected; voice preserved as-is").
- Never use vague phrases like "Grammar corrected" or "Voice preserved". Be precise.
- Reference the specific rule broken (e.g. "dangling modifier", "comma splice", "misspelling", "wrong homophone").

The top-level 'explanation' field MUST summarize the main categories of changes across all sentences.
Example: "Fixed 3 spelling errors, 2 subject-verb agreement issues, and 1 comma splice. All paragraph structure and citations preserved."

---

## SCORING RULES (CRITICAL)
- originalScore: Rate the ORIGINAL text's grammatical correctness, fluency, and native-level expression on 0-100.
  - 90-100: Near-perfect native English
  - 70-89: Minor issues, mostly fluent
  - 50-69: Noticeable errors that affect clarity
  - 30-49: Frequent errors, hard to read naturally
  - 0-29: Severely broken English
- revisedScore: Rate the REVISED text after corrections. It MUST be higher than originalScore if improvements were made.
  - The gap MUST reflect the magnitude of improvements.
  - Fixed 5 spelling + 2 grammar issues = 15-30 point gap.
  - Fixed 1 minor issue = 3-8 point gap.
  - NEVER set revisedScore equal to or lower than originalScore unless text was already perfect.

---

## INTERNAL MODE ROUTING (HIDDEN)
- **Academic Mode**: Arguments, theory, analysis.
- **Business Mode**: Coordination, operations, reporting.
- **Creative Mode**: Narrative, reflection, imagery.
- **Hybrid Mode**: Multiple domains or general text.

## OUTPUT FORMAT (STRICT JSON)
{
  "originalScore": (0-100),
  "revisedScore": (0-100),
  "finalVersion": "Full text string",
  "sentences": [
    {
      "original": "...",
      "revised": "...",
      "suggestions": [],
      "explanation": "Specific change and why it is linguistically superior",
      "isImmutableFootnote": boolean
    }
  ],
  "suggestions": [],
  "explanation": "Summary of all changes made across sentences",
  "detectedDialect": "US|UK|CA|AU"
}
`;

export interface SentenceResult {
  original: string;
  revised: string;
  suggestions?: string[];
  explanation?: string;
  isImmutableFootnote?: boolean;
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
}

const WORKER_URL = (import.meta as any).env?.VITE_WORKER_URL || "https://nativewrite-api.nativewrite-api.workers.dev";

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
      }),
    });

    if (progressTimer) clearInterval(progressTimer);
    if (onProgress) onProgress(95, 0, 1, "Finalizing...");

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Server error: ${response.status}`);
    }

    const data: TransformationResult = await response.json();

    // Post-Worker replacements: idiom + AI phrases (applied to .revised only, .original untouched)
    if (databases?.idiomDatabase && databases.idiomDatabase.length > 0) {
      const unified = normalizeToUnified(databases.idiomDatabase);
      if (data.sentences && data.sentences.length > 0) {
        data.sentences = data.sentences.map(sentence => {
          if (sentence.isImmutableFootnote) return sentence;
          const result = applyReplacements(sentence.revised, unified);
          return { ...sentence, revised: result.text };
        });
      }
      data.finalVersion = applyReplacements(data.finalVersion, normalizeToUnified(databases.idiomDatabase)).text;
    }

    if (databases?.aiPhraseMap && databases.aiPhraseMap.length > 0) {
      const unified = normalizeToUnified(databases.aiPhraseMap);
      if (data.sentences && data.sentences.length > 0) {
        data.sentences = data.sentences.map(sentence => {
          if (sentence.isImmutableFootnote) return sentence;
          const result = applyReplacements(sentence.revised, unified);
          return { ...sentence, revised: result.text };
        });
      }
      data.finalVersion = applyReplacements(data.finalVersion, unified).text;
    }

    // Activate lexical databases for the detected domain
    if (databases?.lexicalDatabases && databases.lexicalDatabases[domain] && databases.lexicalDatabases[domain].length > 0) {
      const unified = normalizeToUnified(databases.lexicalDatabases[domain]);
      if (data.sentences && data.sentences.length > 0) {
        data.sentences = data.sentences.map(sentence => {
          if (sentence.isImmutableFootnote) return sentence;
          const result = applyReplacements(sentence.revised, unified);
          return { ...sentence, revised: result.text };
        });
      }
      data.finalVersion = applyReplacements(data.finalVersion, unified).text;
    }

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
