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

function applyLexicalReplacements(text: string, domain: string, lexicalDatabases?: Record<string, LexicalEntry[]>): string {
  if (!lexicalDatabases) return text;
  
  const domainEntries = lexicalDatabases[domain] || [];
  const generalEntries = lexicalDatabases['general'] || [];
  const allEntries = [...domainEntries, ...generalEntries];
  
  if (allEntries.length === 0) return text;
  
  let result = text;
  
  // Sort by length (longest first) to avoid partial replacements
  const sorted = [...allEntries].sort((a, b) => b.clunky.length - a.clunky.length);
  
  for (const entry of sorted) {
    if (!entry.clunky || !entry.native) continue;
    try {
      const regex = new RegExp(escapeRegex(entry.clunky), 'gi');
      if (regex.test(result)) {
        result = result.replace(regex, entry.native);
      }
    } catch {
      // Skip invalid regex
    }
  }
  
  // Clean up artifacts
  result = result.replace(/\s+/g, ' ').replace(/ ,/g, ',').replace(/ \./g, '.');
  
  return result;
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

export interface LexicalEntry {
  clunky: string;
  native: string;
  type?: string;
}

export async function transformText(
  text: string,
  domain: string = "general",
  tone: string = "neutral",
  onProgress?: (progress: number, currentChunk: number, totalChunks: number, status?: string) => void,
  forcedDialect?: string,
  mode: string = "auto",
  idiomDatabase?: any[],
  phraseMap?: PhrasePair[],
  lexicalDatabases?: Record<string, LexicalEntry[]>
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
    // Apply domain-specific lexical replacements as pre-processing
    const lexicalProcessedText = applyLexicalReplacements(text, domain, lexicalDatabases);
    
    const requestBody: any = { text: lexicalProcessedText, domain, tone, forcedDialect, mode: activeMode };
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

    // Apply AI phrase filter to the response
    if (phraseMap && phraseMap.length > 0) {
      if (data.finalVersion) {
        data.finalVersion = naturalizeAIPhrases(data.finalVersion, phraseMap);
      }
      
      if (data.sentences && data.sentences.length > 0) {
        data.sentences = data.sentences.map(sentence => ({
          ...sentence,
          native: naturalizeAIPhrases(sentence.native, phraseMap)
        }));
      }
    }

    // Apply domain-specific lexical replacements as post-processing
    if (lexicalDatabases) {
      if (data.finalVersion) {
        data.finalVersion = applyLexicalReplacements(data.finalVersion, domain, lexicalDatabases);
      }
      if (data.sentences && data.sentences.length > 0) {
        data.sentences = data.sentences.map(sentence => ({
          ...sentence,
          native: applyLexicalReplacements(sentence.native, domain, lexicalDatabases)
        }));
      }
    }

clearInterval(ticker);
if (onProgress) {
  onProgress(100, 1, 1, "Complete!");
}

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