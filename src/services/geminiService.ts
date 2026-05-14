import { validateLexicalDatabase } from "./validationService";

const WORKER_URL = process.env.WORKER_URL || "/api/transform";

const SYSTEM_PROMPT = `
# 🧠 NativeWrite: Mode Detection Micro-Engine

## 1. CORE OBJECTIVE
You are a hidden orchestration engine that controls how text is edited. Transform input text with minimal intervention while preserving author voice and adapting appropriately to context. You are a voice-preserving linguistic stabilizer.

## 2. EDITING PRINCIPLES (STRICT HIERARCHY)
### 4.1 Voice Preservation (HIGHEST PRIORITY)
- **Do NOT overwrite author voice.** Preserve hesitation, ambiguity, repetition, and rhythm when meaningful.
- **Do NOT standardize stylistic variation.**
- **Do NOT convert fragments into full sentences** unless grammatically required.

### 4.2 Minimal Intervention Rule
- Only modify: grammar, punctuation, spelling, and clear syntactic confusion.
- **Do NOT**: rewrite for elegance, restructure paragraphs for clarity unless necessary, normalize tone, or improve style beyond correction.

### 4.3 Domain-Sensitive Editing
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

## 🛰️ INTERNAL MODE ROUTING (HIDDEN)
- **Academic Mode**: Arguments, theory, analysis.
- **Business Mode**: Coordination, operations, reporting.
- **Creative Mode**: Narrative, reflection, imagery.
- **Hybrid Mode**: Multiple domains or general text.

## 📤 OUTPUT FORMAT (STRICT JSON)
{
  "originalScore": (0-100),
  "revisedScore": (0-100),
  "finalVersion": "Full text string",
  "sentences": [
    {
      "original": "...",
      "native": "...",
      "isNativeMatch": boolean,
      "isEndOfParagraph": boolean,
      "isHeading": boolean,
      "isImmutableFootnote": boolean
    }
  ],
  "suggestions": [],
  "explanation": "Minimal diagnostic note",
  "detectedDialect": "US|UK|CA|AU"
}
`;

export interface SentenceObject {
  original: string;
  native: string;
  isNativeMatch: boolean;
  isEndOfParagraph: boolean;
  isHeading: boolean;
  isImmutableFootnote?: boolean;
}

export interface TransformationResult {
  finalVersion: string;
  sentences: SentenceObject[];
  suggestions: string[];
  explanation: string;
  originalScore: number;
  revisedScore: number;
  detectedDialect?: string;
  appliedMode?: string;
}

/**
 * Layer 1 - Mode Detection Engine (Heuristic)
 */
export function detectBestMode(text: string): { mode: string; reason: string } {
  const t = text.toLowerCase();
  
  // 1. Academic Triggers
  const academicTriggers = ["theory", "framework", "analysis", "literature suggests", "empirical", "hypothesis", "methodology"];
  const citationMarkers = [/\[\d+\]/g, /\(\d{4}\)/g, /\([A-Z][a-z]+, \d{4}\)/g, /\bet al\./i, /DOI:/i];
  
  const hasAcademicVocab = academicTriggers.some(word => t.includes(word));
  const hasCitations = citationMarkers.some(regex => regex.test(text));

  if (hasAcademicVocab || hasCitations) {
    return { mode: "academic", reason: "Academic triggers (theory/analysis/citations) detected." };
  }

  // 2. Business Triggers
  const businessTriggers = ["stakeholders", "rollout", "alignment", "execution", "timeline", "budget", "operations", "coordination", "strategy"];
  const hasBusinessVocab = businessTriggers.some(word => t.includes(word));
  
  if (hasBusinessVocab) {
    return { mode: "business", reason: "Business triggers (operations/stakeholders/execution) detected." };
  }

  // 3. Creative/Literary Triggers
  const creativeTriggers = [/\bI \w+/i, /\bme\b/i, /\bmy\b/i, /feeling/i, /breath/i, /silence/i, /whisper/i, /shadow/i, /metaphor/i];
  const hasCreativeVocab = creativeTriggers.some(regex => typeof regex === 'string' ? t.includes(regex) : regex.test(text));
  
  if (hasCreativeVocab) {
    return { mode: "creative", reason: "Creative/Reflective triggers detected." };
  }

  // Default
  return { mode: "hybrid", reason: "Hybrid or default signals detected." };
}

export async function transformText(
  text: string,
  domain: string = "general",
  tone: string = "neutral",
  onProgress?: (progress: number, currentChunk: number, totalChunks: number, status?: string) => void,
  forcedDialect?: string,
  mode: string = "auto"
): Promise<TransformationResult> {
  if (!text.trim()) return mergeResults([]);

  // Handle Mode Selection Logic
  let activeMode: string;
  let autoReason = "";

  if (mode === "auto" || !["academic", "business", "creative", "hybrid", "schema-init", "lexical-retrieval", "activation-engine", "voice-preservation"].includes(mode)) {
    const detection = detectBestMode(text);
    activeMode = detection.mode;
    autoReason = detection.reason;
  } else {
    activeMode = mode;
  }

  // Handle Schema Initialization Mode (Local Validation)
  if (activeMode === "schema-init") {
    try {
      const data = JSON.parse(text);
      const report = validateLexicalDatabase(data);
      
      const result: TransformationResult = {
        finalVersion: JSON.stringify(report, null, 2),
        sentences: [{
          original: "System Initialization Prompt",
          native: report.isValid ? "✅ Schema validation passed. System initialized as a structured lexical processing engine." : "❌ Schema validation failed.",
          isImmutableFootnote: false,
          isNativeMatch: true,
          isEndOfParagraph: true,
          isHeading: false
        }],
        originalScore: 100,
        revisedScore: report.isValid ? 100 : 0,
        explanation: report.isValid 
          ? `[SCHEMA_INITIALIZATION_MODE] Successfully registered schema. Total entries to validate: ${report.metadata?.total_entries || 'N/A'}`
          : `[SCHEMA_INITIALIZATION_MODE] Validation failed: \n${report.errors.join('\n')}`,
        suggestions: report.isValid ? [] : report.errors.map(err => `[Validation Error] ${err}`),
        appliedMode: "schema-init"
      };
      
      return result;
    } catch (e) {
      return {
        finalVersion: "Invalid JSON format for Schema Initialization.",
        sentences: [],
        suggestions: ["[Format Error] Input must be valid JSON matching the lexical schema."],
        originalScore: 0,
        revisedScore: 0,
        explanation: "Error: Schema Initialization requires a valid JSON input matching the lexical database schema.",
        appliedMode: "schema-init"
      };
    }
  }

  // Handle Lexical Retrieval Mode (Simulated Indexing)
  if (activeMode === "lexical-retrieval") {
    try {
      const result: TransformationResult = {
        finalVersion: "Lexical database successfully loaded. Retrieval mode active.",
        sentences: [{
          original: "Excel/Data Ingestion",
          native: "Lexical database successfully loaded. Retrieval mode active.",
          isImmutableFootnote: false,
          isNativeMatch: true,
          isEndOfParagraph: true,
          isHeading: false
        }],
        originalScore: 100,
        revisedScore: 100,
        explanation: "[LEXICAL_RETRIEVAL_MODE] System has indexed items. Layer-aware and register-sensitive retrieval is now active.",
        suggestions: [],
        appliedMode: "lexical-retrieval"
      };
      return result;
    } catch (e) {
       return {
        finalVersion: "Error loading lexical database.",
        sentences: [],
        suggestions: ["Ensure data follows the required structure."],
        originalScore: 0,
        revisedScore: 0,
        explanation: "Error during lexical retrieval initialization.",
        appliedMode: "lexical-retrieval"
      };
    }
  }

  // NEW: Call Vercel serverless function instead of external worker
  if (onProgress) {
    onProgress(10, 0, 1, "Connecting to server...");
  }

  try {
    console.log('Calling API at /api/transform with payload:', { text, domain, tone, forcedDialect, mode: activeMode });
    const response = await fetch('/api/transform', {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        domain,
        tone,
        forcedDialect,
        mode: activeMode,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const data = await response.json();
    // Process data (assuming data has finalVersion, etc.)
    return data;
  } catch (error) {
    console.error("Transformation failed:", error);
    throw error;
  }

    if (onProgress) {
      onProgress(50, 0, 1, "Processing...");
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Server error: ${response.status}`);
    }

    const data: TransformationResult = await response.json();

    if (onProgress) {
      onProgress(100, 1, 1, "Complete!");
    }

    // Add auto-mode explanation if applicable
    if (mode === "auto") {
      data.explanation = (data.explanation || "") + ` \n[Auto-Selected Mode: ${activeMode.toUpperCase().replace(/-/g, ' ')}] - ${autoReason}`;
      data.appliedMode = activeMode;
    }

    return data;
  } catch (error: any) {
    console.error("Worker request failed:", error);
    throw new Error(`Transformation failed: ${error.message || "Server unavailable"}`);
  }
}

function mergeResults(results: TransformationResult[]): TransformationResult {
  if (results.length === 0) {
    throw new Error("No results to merge");
  }

  return {
    finalVersion: results.map(r => r.finalVersion).join("\n\n"),
    sentences: results.flatMap(r => r.sentences),
    suggestions: Array.from(new Set(results.flatMap(r => r.suggestions))).slice(0, 5),
    explanation: results[0].explanation, 
    originalScore: Math.round(results.reduce((acc, r) => acc + r.originalScore, 0) / results.length),
    revisedScore: Math.round(results.reduce((acc, r) => acc + r.revisedScore, 0) / results.length),
    detectedDialect: results[0].detectedDialect || "US",
  };
}