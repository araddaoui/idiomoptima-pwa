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

export interface LexicalEntry {
  clunky: string;
  native: string;
  type?: string;
}

export interface UnifiedPhrase {
  source: string;
  target: string;
}

export interface PipelineStats {
  idiomReplacements: number;
  lexicalPreReplacements: number;
  aiPhraseReplacements: number;
  lexicalPostReplacements: number;
  totalReplacements: number;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeToUnified(data: any[]): UnifiedPhrase[] {
  if (!data || !Array.isArray(data)) return [];
  return data
    .filter((e: any) => (e.ai || e.clunky) && (e.natural || e.native))
    .map((e: any) => ({
      source: (e.ai || e.clunky || '').trim(),
      target: (e.natural || e.native || '').trim(),
    }))
    .filter((e: UnifiedPhrase) => e.source.length > 0 && e.target.length > 0);
}

function applyUnifiedReplacements(text: string, phrases: UnifiedPhrase[], label: string): { text: string; count: number } {
  if (!phrases || phrases.length === 0) return { text, count: 0 };

  let result = text;
  let count = 0;

  const sorted = [...phrases].sort((a, b) => b.source.length - a.source.length);

  for (const { source, target } of sorted) {
    try {
      const regex = new RegExp(`\\b${escapeRegex(source)}\\b`, 'gi');
      if (regex.test(result)) {
        result = result.replace(regex, target);
        count++;
      }
    } catch {
      // Skip invalid regex
    }
  }

  result = result.replace(/\s+/g, ' ').replace(/ ,/g, ',').replace(/ \./g, '.');

  if (count > 0) {
    console.log(`[${label}] Applied ${count} replacements`);
  }

  return { text: result, count };
}

function fixGrammar(text: string): string {
  let result = text;

  // Fix double spaces
  result = result.replace(/\s{2,}/g, ' ');

  // Fix space before punctuation
  result = result.replace(/ ([,;:!?.])/g, '$1');

  // Fix space after opening parenthesis
  result = result.replace(/\(\s+/g, '(');

  // Fix space before closing parenthesis
  result = result.replace(/\s+\)/g, ')');

  // Fix double commas
  result = result.replace(/,,+/g, ',');

  // Fix sentence spacing (period + space + capital)
  result = result.replace(/([.!?])\s*([A-Z])/g, '$1 $2');

  // Fix "a" vs "an" before vowel sounds
  result = result.replace(/\ba ([aeiou])/gi, (match, letter) => {
    return 'an ' + letter;
  });
  result = result.replace(/\ban ([^aeiou\s])/gi, (match, letter) => {
    return 'a ' + letter;
  });

  // Fix common doubled words
  result = result.replace(/\b(the|a|an|is|are|was|were|has|have|had|will|would|could|should|can|may|might|shall|must)\s+\1\b/gi, '$1');

  // Fix "a" before consonant sounds that start with vowel letters
  result = result.replace(/\b(a)\s+(un)/gi, 'an $2');

  // Fix corrupted Unicode characters (e.g., "War?II" from non-breaking space)
  result = result.replace(/([a-zA-Z])[\?\u00A0\u2007\u202F\uFEFF]+([A-Z])/g, '$1 $2');

  return result;
}

function applyIdiomReplacementsLocal(text: string, idiomDatabase?: any[]): { text: string; count: number } {
  if (!idiomDatabase || idiomDatabase.length === 0) return { text, count: 0 };

  let result = text;
  let count = 0;

  idiomDatabase.forEach((entry: any) => {
    if (entry.clunky && result.toLowerCase().includes(entry.clunky.toLowerCase())) {
      try {
        const regex = new RegExp(entry.clunky, 'gi');
        if (regex.test(result)) {
          result = result.replace(regex, entry.native);
          count++;
        }
      } catch {
        // Skip invalid regex
      }
    }
  });

  return { text: result, count };
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

  const stats: PipelineStats = {
    idiomReplacements: 0,
    lexicalPreReplacements: 0,
    aiPhraseReplacements: 0,
    lexicalPostReplacements: 0,
    totalReplacements: 0,
  };

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
    // Layer 1: Apply idiom replacements (pre-processing)
    const idiomResult = applyIdiomReplacementsLocal(text, idiomDatabase);
    stats.idiomReplacements = idiomResult.count;
    let processedText = idiomResult.text;

    // Layer 2: Apply domain-specific lexical replacements (pre-processing)
    const lexicalDomainEntries = lexicalDatabases?.[domain] || [];
    const lexicalGeneralEntries = lexicalDatabases?.['general'] || [];
    const allLexicalEntries = [...lexicalDomainEntries, ...lexicalGeneralEntries];
    const lexicalResult = applyUnifiedReplacements(processedText, normalizeToUnified(allLexicalEntries), `lexical-${domain}+general`);
    stats.lexicalPreReplacements = lexicalResult.count;
    processedText = lexicalResult.text;

    console.log(`[Pipeline] Layer 1-2 (pre-processing): ${stats.idiomReplacements} idiom + ${stats.lexicalPreReplacements} lexical replacements`);

    if (onProgress) {
      onProgress(25, 0, 1, `Applied ${stats.idiomReplacements + stats.lexicalPreReplacements} pre-processing replacements...`);
    }

    // Layer 3: AI transformation via Worker
    const requestBody: any = { text: processedText, domain, tone, forcedDialect, mode: activeMode };
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

    // Layer 4: Apply AI phrase filter (post-processing)
    if (phraseMap && phraseMap.length > 0) {
      const aiPhrases = normalizeToUnified(phraseMap);
      const aiResult = applyUnifiedReplacements(data.finalVersion, aiPhrases, 'ai-natural');
      stats.aiPhraseReplacements = aiResult.count;
      data.finalVersion = aiResult.text;

      if (data.sentences && data.sentences.length > 0) {
        data.sentences = data.sentences.map(sentence => {
          const sentenceResult = applyUnifiedReplacements(sentence.native, aiPhrases, 'ai-natural-sentence');
          return { ...sentence, native: sentenceResult.text };
        });
      }
    }

    // Layer 5: Apply domain-specific lexical replacements (post-processing)
    if (lexicalDatabases && allLexicalEntries.length > 0) {
      const lexicalUnified = normalizeToUnified(allLexicalEntries);
      const lexicalPostResult = applyUnifiedReplacements(data.finalVersion, lexicalUnified, `lexical-post-${domain}`);
      stats.lexicalPostReplacements = lexicalPostResult.count;
      data.finalVersion = lexicalPostResult.text;

      if (data.sentences && data.sentences.length > 0) {
        data.sentences = data.sentences.map(sentence => {
          const sentenceResult = applyUnifiedReplacements(sentence.native, lexicalUnified, 'lexical-post-sentence');
          return { ...sentence, native: sentenceResult.text };
        });
      }
    }

    // Layer 6: Grammar correction
    data.finalVersion = fixGrammar(data.finalVersion);
    if (data.sentences && data.sentences.length > 0) {
      data.sentences = data.sentences.map(sentence => ({
        ...sentence,
        native: fixGrammar(sentence.native)
      }));
    }

    stats.totalReplacements = stats.idiomReplacements + stats.lexicalPreReplacements + stats.aiPhraseReplacements + stats.lexicalPostReplacements;
    console.log(`[Pipeline] Layer 3-6 (post-processing): AI rewrite + ${stats.aiPhraseReplacements} AI phrase + ${stats.lexicalPostReplacements} lexical post + grammar fix`);
    console.log(`[Pipeline] TOTAL: ${stats.totalReplacements} database-driven replacements applied`);

    clearInterval(ticker);
    if (onProgress) {
      onProgress(100, 1, 1, `Complete! ${stats.totalReplacements} improvements applied.`);
    }

    if (mode === "auto") {
      data.explanation = (data.explanation || "") + ` \n[Auto-Selected Mode: ${activeMode}] - ${autoReason}`;
      data.appliedMode = activeMode;
    }

    // Add pipeline stats to explanation
    data.explanation = (data.explanation || "") + ` \n[Databases: ${stats.totalReplacements} rule-based improvements applied across 6 layers]`;

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
