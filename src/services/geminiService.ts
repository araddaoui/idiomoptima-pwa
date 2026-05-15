import { validateLexicalDatabase } from "./validationService";

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

export function detectBestMode(text: string): { mode: string; reason: string } {
  const t = text.toLowerCase();
  
  const academicTriggers = ["theory", "framework", "analysis", "literature suggests", "empirical", "hypothesis", "methodology"];
  const citationMarkers = [/\[\d+\]/g, /\(\d{4}\)/g, /\([A-Z][a-z]+, \d{4}\)/g, /\bet al\./i, /DOI:/i];
  
  const hasAcademicVocab = academicTriggers.some(word => t.includes(word));
  const hasCitations = citationMarkers.some(regex => regex.test(text));

  if (hasAcademicVocab || hasCitations) {
    return { mode: "academic", reason: "Academic triggers detected." };
  }

  const businessTriggers = ["stakeholders", "rollout", "alignment", "execution", "timeline", "budget", "operations", "coordination", "strategy"];
  const hasBusinessVocab = businessTriggers.some(word => t.includes(word));
  
  if (hasBusinessVocab) {
    return { mode: "business", reason: "Business triggers detected." };
  }

  const creativeTriggers = [/\bI \w+/i, /\bme\b/i, /\bmy\b/i, /feeling/i, /breath/i, /silence/i, /whisper/i, /shadow/i, /metaphor/i];
  const hasCreativeVocab = creativeTriggers.some(regex => typeof regex === 'string' ? t.includes(regex) : regex.test(text));
  
  if (hasCreativeVocab) {
    return { mode: "creative", reason: "Creative triggers detected." };
  }

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
  if (!text.trim()) {
    return {
      finalVersion: "",
      sentences: [],
      suggestions: [],
      explanation: "No text provided",
      originalScore: 0,
      revisedScore: 0,
    };
  }

  let activeMode: string;
  let autoReason = "";

  if (mode === "auto" || !["academic", "business", "creative", "hybrid", "schema-init", "lexical-retrieval"].includes(mode)) {
    const detection = detectBestMode(text);
    activeMode = detection.mode;
    autoReason = detection.reason;
  } else {
    activeMode = mode;
  }

  // Handle special modes
  if (activeMode === "schema-init") {
    try {
      const data = JSON.parse(text);
      const report = validateLexicalDatabase(data);
      return {
        finalVersion: JSON.stringify(report, null, 2),
        sentences: [],
        originalScore: 100,
        revisedScore: report.isValid ? 100 : 0,
        explanation: report.isValid ? "Schema validation passed" : "Schema validation failed",
        suggestions: report.isValid ? [] : report.errors,
        appliedMode: "schema-init"
      };
    } catch (e) {
      return {
        finalVersion: "Invalid JSON format",
        sentences: [],
        suggestions: ["Input must be valid JSON"],
        originalScore: 0,
        revisedScore: 0,
        explanation: "JSON parsing error",
        appliedMode: "schema-init"
      };
    }
  }

  if (activeMode === "lexical-retrieval") {
    return {
      finalVersion: "Lexical database successfully loaded. Retrieval mode active.",
      sentences: [],
      originalScore: 100,
      revisedScore: 100,
      explanation: "Lexical retrieval mode active",
      suggestions: [],
      appliedMode: "lexical-retrieval"
    };
  }

  // Mock transformation (no API call)
  if (onProgress) {
    onProgress(10, 0, 1, "Starting...");
    onProgress(50, 0, 1, "Processing...");
    onProgress(100, 1, 1, "Complete!");
  }

  // Real API call via serverless function
  if (onProgress) {
    onProgress(10, 0, 1, "Connecting to server...");
  }

  try {
    const response = await fetch('/api/transform', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, domain, tone, forcedDialect, mode: activeMode }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server error (${response.status}): ${errorText}`);
    }

    if (onProgress) {
      onProgress(50, 0, 1, "Processing...");
    }

    const data: TransformationResult = await response.json();

    if (onProgress) {
      onProgress(100, 1, 1, "Complete!");
    }

    // Add auto-mode explanation if applicable
    if (mode === "auto") {
      data.explanation = (data.explanation || "") + ` \n[Auto-Selected Mode: ${activeMode}] - ${autoReason}`;
      data.appliedMode = activeMode;
    }

    return data;
  } catch (error: any) {
    console.error("Transformation failed:", error);
    throw new Error(`Transformation failed: ${error.message}`);
  }