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

export interface PhrasePair {
  ai: string;
  natural: string;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function naturalizeAIPhrases(text: string, phraseMap: PhrasePair[]): string {
  if (!phraseMap || phraseMap.length === 0) return text;
  
  let result = text;
  
  // Sort by length (longest first) to avoid partial replacements
  const sortedPhrases = [...phraseMap].sort((a, b) => b.ai.length - a.ai.length);
  
  for (const { ai, natural } of sortedPhrases) {
    // Case-insensitive replacement with word boundaries
    const regex = new RegExp(`\\b${escapeRegex(ai)}\\b`, 'gi');
    const replacement = natural || '';
    result = result.replace(regex, replacement);
  }
  
  // Clean up artifacts
  result = result.replace(/\s+/g, ' ').replace(/ ,/g, ',').replace(/ \./g, '.');
  
  return result;
}

function describeAcceptedChange(original: string, revised: string): string {
  const left = original.trim();
  const right = revised.trim();
  if (left === right) return "";
  const oldWords = left.split(/\s+/);
  const newWords = right.split(/\s+/);
  let start = 0;
  while (start < oldWords.length && start < newWords.length && oldWords[start] === newWords[start]) start++;
  let oldEnd = oldWords.length - 1;
  let newEnd = newWords.length - 1;
  while (oldEnd >= start && newEnd >= start && oldWords[oldEnd] === newWords[newEnd]) { oldEnd--; newEnd--; }
  const removed = oldWords.slice(start, oldEnd + 1).join(" ");
  const added = newWords.slice(start, newEnd + 1).join(" ");
  if (removed && added) return `replaced “${removed}” with “${added}”`;
  if (removed) return `removed “${removed}”`;
  if (added) return `added “${added}”`;
  return "refined punctuation or spacing";
}

function applyConcreteExplanation(data: TransformationResult): void {
  const changes = (data.sentences || [])
    .filter(sentence => !sentence.isImmutableFootnote && !sentence.isHeading && sentence.original.trim() !== sentence.native.trim())
    .map(sentence => describeAcceptedChange(sentence.original, sentence.native))
    .filter(Boolean)
    .slice(0, 4);
  if (changes.length === 0) return;

  const current = (data.explanation || "").toLowerCase();
  const generic = current.includes("generic") || current.includes("preserving the author's meaning") || current.includes("provider response could not be parsed") || current.includes("source text was preserved") || current.includes("no substantive changes were necessary");
  if (generic || !data.explanation?.trim()) {
    data.explanation = `Concrete refinements accepted: ${changes.join("; ")}. Meaning, citations, URLs, paragraph structure, and immutable footnotes were preserved.`;
  }

  const genericSuggestion = !data.suggestions?.length || data.suggestions.some(s => {
    const value = s.toLowerCase();
    return value.includes("refined wording while preserving") || value.includes("provider response could not be parsed") || value.includes("no substantive changes");
  });
  if (genericSuggestion) data.suggestions = changes.map(change => `Accepted change: ${change}.`);
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
  idiomDatabase?: any[],
  phraseMap?: PhrasePair[]
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

  // Real API call via serverless function
  if (onProgress) {
    onProgress(10, 0, 1, "Connecting to server...");
  }
 let simulatedProgress = 10;
const ticker = setInterval(() => {
  if (simulatedProgress < 85) {
    simulatedProgress += Math.random() * 8;
    const messages = [
      "Analysing your text...",
      "Detecting dialect and domain...",
      "Applying nativization rules...",
      "Checking collocations...",
      "Preserving your voice...",
      "Polishing the output...",
    ];
    const msgIndex = Math.min(
      Math.floor((simulatedProgress / 85) * messages.length),
      messages.length - 1
    );
    if (onProgress) {
      onProgress(Math.min(Math.round(simulatedProgress), 85), 0, 1, messages[msgIndex]);
    }
  }
}, 1500); 

  try {
    const requestBody: any = { text, domain, tone, forcedDialect, mode: activeMode };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    let response;
    try {
      response = await fetch('https://nativewrite-api.nativewrite-api.workers.dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        throw new Error('Request timeout after 90 seconds. The server is taking too long to respond.');
      }
      throw fetchError;
    }

    if (!response.ok) {
      const errorText = await response.text();
      
      if (response.status === 429 || errorText.includes('429') || errorText.includes('quota exceeded')) {
        throw new Error('Daily transformation limit reached. Please try again tomorrow or upgrade for higher limits.');
      }
      
      throw new Error(`Server error (${response.status}): ${errorText.substring(0, 100)}`);
    }

    const data: TransformationResult = await response.json();

    // Apply AI phrase filter only to mutable narrative content. The Worker’s
    // immutable bibliography records and finalVersion remain byte-preserved.
    if (phraseMap && phraseMap.length > 0) {
      const hasImmutableRecords = !!data.sentences?.some(sentence => sentence.isImmutableFootnote);
      if (data.finalVersion && !hasImmutableRecords) {
        data.finalVersion = naturalizeAIPhrases(data.finalVersion, phraseMap);
      }
      
      if (data.sentences && data.sentences.length > 0) {
        data.sentences = data.sentences.map(sentence => sentence.isImmutableFootnote
          ? sentence
          : {
              ...sentence,
              native: naturalizeAIPhrases(sentence.native, phraseMap)
            });
      }
    }

clearInterval(ticker);
if (onProgress) {
  onProgress(100, 1, 1, "Complete!");
}

    applyConcreteExplanation(data);

    if (mode === "auto") {
      data.explanation = (data.explanation || "") + ` \n[Auto-Selected Mode: ${activeMode}] - ${autoReason}`;
      data.appliedMode = activeMode;
    }

    return data;
} catch (error: any) {
  clearInterval(ticker);
  console.error("Transformation failed:", error);
  throw new Error(`Transformation failed: ${error.message}`);
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