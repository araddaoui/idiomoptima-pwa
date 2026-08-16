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
  databaseUsage?: {
    corpusCounts: Record<string, number>;
    matchedSources: string[];
    exactMatches: Array<{ source: string; clunky: string; native: string }>;
    promptExamples: Array<{ source: string; clunky: string; native: string }>;
  };
}

function clampScore(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(0, Math.min(97, numeric));
}

function surfaceQualityScore(text: string): number {
  let score = 100;
  const penalties = [
    /\bexplained me\b/i,
    /\bvery clear\b/i,
    /\bdiscuss about\b/i,
    /\b(?:did not|didn't)\s+\w+ed\b/i,
    /\b(memory)\s+\1\b/i,
    /\b(?:suggests?|seems?)\s+to\s+\w+\s+have\b/i,
  ];
  for (const pattern of penalties) if (pattern.test(text)) score -= 10;
  return Math.max(0, Math.min(100, score));
}

function protectedMarkers(text: string): string[] {
  return text.match(/\[\d+\]|\(\d{4}\)|\b(?:Ibid|ibid)\.?\b/g) || [];
}

function normalizeClientResult(data: TransformationResult, sourceText: string): TransformationResult {
  const source = sourceText.trim();
  const candidate = typeof data.finalVersion === "string" && data.finalVersion.trim() ? data.finalVersion.trim() : source;
  const firstWords = source.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase();
  const candidatePlain = candidate.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().toLowerCase();
  const firstWordsPosition = firstWords ? candidatePlain.indexOf(firstWords) : 0;
  const stalePrefix = firstWords && firstWordsPosition > 120;
  const missingMarker = protectedMarkers(source).some((marker) => !candidate.includes(marker));
  const safeFinalVersion = stalePrefix || missingMarker ? source : candidate;
  const sourcePreserved = safeFinalVersion.trim() === source.trim();
  const originalScore = sourcePreserved
    ? clampScore(surfaceQualityScore(source), surfaceQualityScore(source))
    : clampScore(data.originalScore, surfaceQualityScore(source));
  const revisedScore = sourcePreserved
    ? originalScore
    : clampScore(data.revisedScore, surfaceQualityScore(safeFinalVersion));
  const suggestions = Array.isArray(data.suggestions) ? data.suggestions.filter((item) => typeof item === "string" && item.trim()).slice(0, 5) : [];
  if (!suggestions.length) {
    if (sourcePreserved) suggestions.push("No substantive changes were retained; the source structure and protected markers were preserved.");
    else suggestions.push("Refined grammar and collocation while preserving the source meaning and structure.");
  }
  const rawExplanation = typeof data.explanation === "string" ? data.explanation.trim() : "";
  const genericExplanation = /^(?:the text is written in|refined wording while preserving|grammar and collocation were refined|stylistic note)/i.test(rawExplanation);
  const explanation = sourcePreserved
    ? "The source was preserved because the returned transformation was incomplete or unsafe."
    : (rawExplanation && !genericExplanation
      ? rawExplanation
      : "The accepted result differs from the source; wording was refined while preserving the author’s meaning, structure, and protected details.");
  return { ...data, finalVersion: safeFinalVersion, originalScore, revisedScore, suggestions, explanation };
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
  mode: string = "auto",
  idiomDatabase?: Array<{ clunky: string; native: string }>
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

  // The endpoint is configurable so production can use a healthy Worker/API
  // without requiring a new frontend build whenever the provider changes.
  const workerUrl = process.env.WORKER_URL || "https://nativewrite-api.nativewrite-api.workers.dev";

  if (onProgress) {
    onProgress(10, 0, 1, "Connecting to server...");
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 90_000);

  try {
    const requestBody: Record<string, unknown> = { text, domain, tone, forcedDialect, mode: activeMode, requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
    if (idiomDatabase && idiomDatabase.length > 0) {
      // Preserve the historical request contract while keeping the payload bounded.
      requestBody.idioms = idiomDatabase.slice(0, 100);
    }
    const response = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const responseText = await response.text();
    if (!response.ok) {
      let providerError: { error?: string; message?: string; quotaExceeded?: boolean } = {};
      try {
        providerError = JSON.parse(responseText);
      } catch {
        // Keep the raw response for non-JSON Worker errors.
      }

      const errorMessage = providerError.message || providerError.error || responseText;
      const normalizedError = errorMessage.toLowerCase();
      // Only a real 429 or an explicit structured quota flag is authoritative.
      // Do not infer quota exhaustion from arbitrary text returned with a 4xx/5xx,
      // because invalid/expired provider keys are commonly reported that way.
      const isExplicitQuotaError = providerError.quotaExceeded === true;

      if (isExplicitQuotaError) {
        throw new Error("The transformation provider has reached its configured quota. This is separate from your IdiomOptima browser limit.");
      }

      if (response.status === 429) {
        throw new Error(`The transformation provider is temporarily rate-limited or unavailable. ${errorMessage.slice(0, 180)}`);
      }

      if (response.status === 401 || response.status === 403
        || normalizedError.includes("api key")
        || normalizedError.includes("api_key")
        || normalizedError.includes("unauthorized")) {
        throw new Error("The transformation API is not authorized. The server API key may be missing, expired, or invalid.");
      }

      throw new Error(`Server error (${response.status}): ${errorMessage.slice(0, 200)}`);
    }

    if (onProgress) {
      onProgress(50, 0, 1, "Processing...");
    }

    const data: TransformationResult = normalizeClientResult(JSON.parse(responseText) as TransformationResult, text);

    if (onProgress) {
      onProgress(100, 1, 1, "Complete!");
    }

    if (mode === "auto") {
      data.explanation = (data.explanation || "") + ` \n[Auto-Selected Mode: ${activeMode}] - ${autoReason}`;
      data.appliedMode = activeMode;
    }

    return data;
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error("The transformation server timed out. Please try again.");
    }
    console.error("Transformation failed:", error);
    throw new Error(`Transformation failed: ${error?.message || "Unknown server error"}`);
  } finally {
    window.clearTimeout(timeoutId);
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