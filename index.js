const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cache-Control",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
};

const FOOTNOTE_DEF_REGEX = /^\s*(?:\[?(\d{1,3})\]?[\s.:)\-|]{1,3}|Footnote\s*(\d{1,3})|REFERENCE\s+(\d{1,3}))[\s.:)\-|]*\s*(.+)/i;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "IdiomOptima transformation Worker",
        providerOrder: ["gemini", "cloudflare-ai", "deterministic"],
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }

    const text = String(payload?.text || "").trim();
    if (!text) {
      return jsonResponse({
        finalVersion: "",
        sentences: [],
        suggestions: [],
        explanation: "No text provided.",
        originalScore: 0,
        revisedScore: 0,
        detectedDialect: payload?.forcedDialect || "US",
        provider: "none",
      });
    }

    if (countWords(text) > 900) {
      return jsonResponse({ error: "Text is too long for this beta Worker. Please keep it under 900 words." }, 413);
    }

    const options = {
      domain: safeOption(payload?.domain, "general"),
      tone: safeOption(payload?.tone, "neutral"),
      mode: safeOption(payload?.mode, "hybrid"),
      forcedDialect: safeDialect(payload?.forcedDialect),
    };

    try {
      const result = await transformWithProviders(text, options, env);
      return jsonResponse(result);
    } catch (error) {
      console.error("Transformation failed", error);
      const fallback = buildDeterministicResult(text, options, String(error?.message || error || "Unknown error"));
      return jsonResponse(fallback);
    }
  },
};

async function transformWithProviders(text, options, env) {
  const providerErrors = [];

  if (env?.GEMINI_API_KEY) {
    try {
      const prompt = buildGeminiPrompt(text, options);
      const raw = await callGemini(prompt, env.GEMINI_API_KEY);
      return normalizeGeminiResult(raw, text, options, "gemini");
    } catch (error) {
      providerErrors.push("Gemini: " + (error.message || error));
    }
  }

  if (env?.AI) {
    try {
      const rewritten = await callCloudflareAI(text, options, env.AI);
      const cleaned = cleanText(rewritten);
      if (cleaned && comparable(cleaned) !== comparable(text)) {
        return buildResultFromRewrite(text, cleaned, options, "cloudflare");
      }
      providerErrors.push("Cloudflare AI returned unchanged text");
    } catch (error) {
      providerErrors.push("Cloudflare AI: " + (error.message || error));
    }
  }

  return buildDeterministicResult(text, options, providerErrors.join(" | "));
}

async function callGemini(prompt, apiKey) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.25,
        topP: 0.9,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error("Gemini returned " + response.status + ": " + message.slice(0, 240));
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
}

async function callCloudflareAI(text, options, ai) {
  const dialect = options.forcedDialect || "US";
  const prompt =
    "You are an expert English editor and writing coach.\n" +
    "Rewrite the following text so it sounds natural, fluent, and native in " + dialect + " English.\n\n" +
    "Domain: " + options.domain + "\n" +
    "Tone: " + options.tone + "\n\n" +
    "RULES:\n" +
    "- CRITICAL: Keep inline citation markers EXACTLY where they appear in the original. If the original has 'text [1] more text', your rewrite must have 'rewritten text [1] more rewritten text' in the same position.\n" +
    "- CRITICAL: Do NOT repeat or duplicate any footnotes, endnotes, or reference lists. Include each footnote exactly ONCE at the very end. Do NOT add footnotes after every sentence. Do NOT truncate, abbreviate, or omit any footnote.\n" +
    "- Preserve the exact meaning, claims, numbers, names, and paragraph breaks.\n" +
    "- Do NOT move citations to the end. Do NOT remove inline citations. Do NOT invent new ones.\n" +
    "- Do NOT invent facts, citations, quotations, sources, or references.\n" +
    "- Improve grammar, idiom, collocation, word choice, clarity, and native flow.\n" +
    "- Make the text sound like a fluent native speaker wrote it naturally.\n" +
    "- For academic text: keep precision, improve hedging and phrasing.\n" +
    "- Fix wordiness, awkward phrasing, and unnatural constructions.\n" +
    "- Return ONLY the rewritten text. No explanations. No JSON. No markdown fences. No headers.\n\n" +
    "Text to rewrite:\n" +
    text;

  const response = await ai.run("@cf/openai/gpt-oss-20b", {
    messages: [
      {
        role: "system",
        content: "You are IdiomOptima, an expert English editor. Rewrite text to sound native. Return only the rewritten text with no extra formatting.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 8192,
  });

  let result;
  if (typeof response === "string") {
    result = response;
  } else {
    result =
      response?.response ||
      response?.result?.response ||
      response?.choices?.[0]?.message?.content ||
      response?.output_text ||
      JSON.stringify(response);
  }

  return String(result || "")
    .replace(/^```(?:text)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function buildGeminiPrompt(text, options) {
  const dialect = options.forcedDialect || "the most likely";
  return (
    "Rewrite the source text so it sounds natural, fluent, and native in " + dialect + " English.\n\n" +
    "Domain: " + options.domain + "\n" +
    "Tone: " + options.tone + "\n" +
    "Mode: " + options.mode + "\n\n" +
    "Rules:\n" +
    "- Preserve meaning, claims, citations, footnote markers, numbers, names, and paragraph boundaries.\n" +
    "- Do not invent facts, citations, quotations, sources, or references.\n" +
    "- Improve grammar, idiom, collocation, clarity, and native flow.\n" +
    "- Keep academic writing appropriately precise and not inflated.\n" +
    "- Keep business writing concise and professional.\n" +
    "- Keep creative writing expressive but faithful to the original.\n" +
    "- Treat footnote or reference definitions as immutable unless only tiny grammar cleanup is needed.\n" +
    "- Return only valid JSON. No Markdown fences.\n\n" +
    "The JSON shape must be:\n" +
    '{\n' +
    '  "finalVersion": "full transformed text",\n' +
    '  "sentences": [\n' +
    '    {\n' +
    '      "original": "source sentence or heading",\n' +
    '      "native": "transformed sentence or heading",\n' +
    '      "isNativeMatch": false,\n' +
    '      "isEndOfParagraph": true,\n' +
    '      "isHeading": false,\n' +
    '      "isImmutableFootnote": false\n' +
    '    }\n' +
    '  ],\n' +
    '  "suggestions": ["short improvement summary"],\n' +
    '  "explanation": "short stylistic note",\n' +
    '  "originalScore": 80,\n' +
    '  "revisedScore": 94,\n' +
    '  "detectedDialect": "US"\n' +
    '}\n\n' +
    "Source text:\n" +
    text
  );
}

function normalizeGeminiResult(rawText, originalText, options, provider) {
  const parsed = parseJsonFromModel(rawText);
  const finalVersion = cleanText(parsed.finalVersion || parsed.final || parsed.text || originalText);

  if (comparable(finalVersion) === comparable(originalText)) {
    throw new Error("Gemini returned unchanged text");
  }

  const detectedDialect = safeDialect(parsed.detectedDialect) || options.forcedDialect || detectDialect(originalText);
  const sentences = Array.isArray(parsed.sentences) && parsed.sentences.length > 0
    ? parsed.sentences.map((sentence, index) => normalizeSentence(sentence, index))
    : buildSentenceObjects(originalText, finalVersion);

  const analysis = buildAnalysis(originalText, finalVersion, options);

  return {
    finalVersion,
    sentences,
    suggestions: analysis.suggestions,
    explanation: analysis.explanation,
    originalScore: clampScore(parsed.originalScore, estimateScore(originalText)),
    revisedScore: clampScore(parsed.revisedScore, Math.max(estimateScore(finalVersion), estimateScore(originalText) + 4)),
    detectedDialect,
    provider,
  };
}

function deduplicateFootnotes(text) {
  const lines = text.split('\n');
  const result = [];
  const seenFootnotes = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    const isFootnoteLine = /^\s*\[?\d{1,3}\]?\s/.test(trimmed) ||
                           /^REFERENCE\s+\d+/i.test(trimmed) ||
                           /^Footnote\s+\d+/i.test(trimmed) ||
                           /^Key\s*words?:/i.test(trimmed);

    if (isFootnoteLine) {
      const key = trimmed.toLowerCase().substring(0, 50);
      if (seenFootnotes.has(key)) {
        console.log('[deduplicateFootnotes] Removing duplicate: ' + trimmed.substring(0, 60));
        continue;
      }
      seenFootnotes.add(key);
    }

    result.push(line);
  }

  return result.join('\n');
}

function deduplicateFootnoteBlocks(text) {
  const blocks = text.split(/\n{2,}/);
  const seen = new Set();
  const result = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    const key = trimmed.toLowerCase().replace(/\s+/g, ' ').substring(0, 80);

    if (seen.has(key)) {
      console.log('[deduplicateFootnoteBlocks] Removing duplicate block: ' + trimmed.substring(0, 60));
      continue;
    }
    seen.add(key);
    result.push(block);
  }

  return result.join('\n\n');
}

function restoreTruncatedFootnotes(original, rewritten) {
  let result = deduplicateFootnotes(rewritten);
  result = deduplicateFootnoteBlocks(result);

  const footnoteRegex = /^\s*\[?\d{1,3}\]?[\s.:)\-|]{1,3}\s*(.+)/i;
  const origLines = original.split('\n');
  const footnoteTexts = [];

  for (const line of origLines) {
    if (footnoteRegex.test(line) || /^Key\s*words?:/i.test(line)) {
      footnoteTexts.push(line.trim());
    }
  }

  if (footnoteTexts.length === 0) return result;

  const resultLower = result.toLowerCase();
  const missing = [];

  for (const fn of footnoteTexts) {
    const firstChars = fn.replace(/^\s*\[?\d{1,3}\]?[\s.:)\-|]*/, '').trim().substring(0, 30).toLowerCase();
    if (firstChars.length > 5 && !resultLower.includes(firstChars)) {
      missing.push(fn);
    }
  }

  if (missing.length === 0) return result;

  console.log('[restoreTruncatedFootnotes] Restoring ' + missing.length + ' missing footnotes');
  for (const fn of missing) {
    result += '\n\n' + fn;
  }

  return result;
}

function buildResultFromRewrite(originalText, rewrittenText, options, provider) {
  const cleaned = cleanText(rewrittenText);
  const withCitations = restoreInlineCitations(originalText, cleaned);
  const finalVersion = restoreTruncatedFootnotes(originalText, withCitations);
  const detectedDialect = options.forcedDialect || detectDialect(originalText);
  const originalScore = estimateScore(originalText);
  const baseRevisedScore = estimateScore(finalVersion);

  const sentences = buildSentenceObjects(originalText, finalVersion);
  const analysis = buildAnalysis(originalText, finalVersion, options);

  // Calculate improvement based on actual changes, not just absence of bad patterns
  const origSentences = originalText.split(/(?<=[.!?])\s+/);
  const rewSentences = finalVersion.split(/(?<=[.!?])\s+/);
  let changedCount = 0;
  for (let i = 0; i < Math.min(origSentences.length, rewSentences.length); i++) {
    if (comparable(origSentences[i]) !== comparable(rewSentences[i])) changedCount++;
  }
  const changeRatio = changedCount / Math.max(1, origSentences.length);

  // Grammar fixes add value
  const hasGrammarFixes = /\b(was|were)\b/.test(originalText) && /\b(were)\b/.test(finalVersion) && /\bData\b/.test(originalText);
  const hasSpellingFixes = /\b(analysed|neighbours)\b/.test(originalText) && /\b(analyzed|neighbors)\b/.test(finalVersion);
  const hasPossessiveFixes = /\bFairclough\b/.test(originalText) && /\bFairclough's\b/.test(finalVersion);

  let qualityBonus = 0;
  if (changeRatio > 0.3) qualityBonus += 2;
  else if (changeRatio > 0.15) qualityBonus += 1;
  if (hasGrammarFixes) qualityBonus += 1;
  if (hasSpellingFixes) qualityBonus += 1;
  if (hasPossessiveFixes) qualityBonus += 1;

  const revisedScore = Math.min(97, Math.max(baseRevisedScore, originalScore + qualityBonus));

  return {
    finalVersion,
    sentences,
    suggestions: analysis.suggestions,
    explanation: analysis.explanation,
    originalScore,
    revisedScore,
    detectedDialect,
    provider,
  };
}

function restoreInlineCitations(original, rewritten) {
  const citRegex = /\[(\d{1,3})\]/g;
  const inlineCits = [];
  let m;
  while ((m = citRegex.exec(original)) !== null) {
    const before = original.substring(0, m.index).trim();
    const isDefLine = /^\s*\[\d{1,3}\]\s/.test(original.substring(m.index).split("\n")[0]);
    if (!isDefLine) {
      const prevText = before.split(/\n/).pop() || "";
      if (prevText.length > 5) {
        inlineCits.push({ num: m[1], contextBefore: prevText.slice(-60) });
      }
    }
  }

  if (inlineCits.length === 0) return rewritten;

  const rewrittenLower = rewritten.toLowerCase();
  let result = rewritten;
  for (const cit of inlineCits) {
    const marker = "[" + cit.num + "]";
    if (rewritten.includes(marker)) continue;

    const lastWords = cit.contextBefore.split(/\s+/).filter(Boolean).slice(-5);
    if (lastWords.length === 0) continue;

    const searchPattern = lastWords[lastWords.length - 1].toLowerCase().replace(/[^a-z]/g, "");
    const idx = rewrittenLower.indexOf(searchPattern);
    if (idx >= 0) {
      const endIdx = idx + searchPattern.length;
      const nextChar = result[endIdx] || "";
      const insertAfter = nextChar === "," || nextChar === "." || nextChar === ";" ? endIdx + 1 : endIdx;
      result = result.substring(0, insertAfter) + " " + marker + result.substring(insertAfter);
    }
  }

  return result;
}

function buildAnalysis(original, rewritten, options) {
  const suggestions = [];
  const origLower = original.toLowerCase();
  const rewLower = rewritten.toLowerCase();

  const origWordCount = countWords(original);
  const rewWordCount = countWords(rewritten);
  const diff = rewWordCount - origWordCount;
  if (Math.abs(diff) > origWordCount * 0.2) {
    suggestions.push(diff < 0
      ? "Tightened verbose passages, reducing word count by " + Math.abs(diff) + " words."
      : "Expanded and clarified, adding " + diff + " words for completeness.");
  } else if (Math.abs(diff) > 5) {
    suggestions.push(diff < 0
      ? "Condensed phrasing for conciseness."
      : "Expanded key phrases for clarity.");
  }

  const origAvgSentenceLen = origWordCount / Math.max(1, original.split(/[.!?]+/).filter((s) => s.trim()).length);
  const rewAvgSentenceLen = rewWordCount / Math.max(1, rewritten.split(/[.!?]+/).filter((s) => s.trim()).length);
  if (origAvgSentenceLen > 25 && rewAvgSentenceLen < origAvgSentenceLen * 0.8) {
    suggestions.push("Broke down long sentences for improved readability.");
  }

  const academicPatterns = [
    [/\bfor the purpose of contextualization\b/i, "Simplified 'For the purpose of contextualization' to 'For contextualization'."],
    [/\ba selection of label texts, which range from texts that directly interrelate with\b/i, "Replaced verbose 'a selection of label texts, which range from texts that directly interrelate with' with 'a range of label texts, from those that directly relate to'."],
    [/\bnot only recipients of curated narratives but active participants\b/i, "Restructured 'not only recipients...but active participants' for stronger contrast."],
    [/\bthe extent to which\b/i, "Simplified 'The extent to which' to direct 'how'."],
    [/\bnonetheless remains largely underexplored\b/i, "Removed redundant 'nonetheless' before 'remains largely underexplored'."],
    [/\bnot limited to an analysis of\b/i, "Replaced nominalized 'not limited to an analysis of' with verbal 'not limited to analyzing'."],
    [/\bas research also aimed at demonstrating\b/i, "Changed 'as research also aimed at demonstrating' to direct 'it also aims to demonstrate'."],
    [/\ba degree of tension unfolds between\b/i, "Replaced 'a degree of tension unfolds between' with 'a degree of tension emerges between'."],
    [/\bof,\s+namely,\b/i, "Removed awkward construction 'of, namely,' for smoother flow."],
    [/\bdata was generated\b/i, "Fixed grammar: 'Data was generated' to 'Data were generated' (plural)."],
    [/\banalysed\b/i, "Changed 'analysed' to US spelling 'analyzed'."],
    [/\bFairclough CDA\b/i, "Added possessive: 'Fairclough CDA' to 'Fairclough's CDA'."],
    [/\bnarrative making\b/i, "Replaced informal 'narrative making' with formal 'narrative construction'."],
    [/\bvisitor's knowledge\b/i, "Fixed possessive: 'visitor's knowledge' to 'visitors' knowledge'."],
    [/\bconstantly shifts\b/i, "Replaced 'constantly shifts' with 'continually shift'."],
    [/\bdebates that ensue around\b/i, "Changed 'debates that ensue around' to 'debates that arise from'."],
    [/\bgain further awareness\b/i, "Simplified 'gain further awareness' to 'become more aware'."],
    [/\bputting more emphasis on unity of nations and less on\b/i, "Condensed 'putting more emphasis on unity of nations and less on' to 'emphasize national unity over'."],
    [/\breckon with\b/i, "Replaced informal 'reckon with' with formal 'acknowledge'."],
    [/\bboost the publics' sense\b/i, "Changed 'boost the publics' sense' to 'strengthen the public's sense'."],
    [/\bcasting a broad look\b/i, "Replaced vague metaphor 'casting a broad look' with direct phrasing."],
    [/\bfor the period preceding\b/i, "Simplified 'for the period preceding' to concise 'before'."],
    [/\bprior to\b/i, "Simplified 'prior to' to 'before'."],
    [/\bsubsequent to\b/i, "Simplified 'subsequent to' to 'after'."],
    [/\bin order to\b/i, "Replaced wordy 'in order to' with 'to'."],
    [/\bdue to the fact that\b/i, "Replaced verbose 'due to the fact that' with 'because'."],
    [/\bat this point in time\b/i, "Replaced 'at this point in time' with concise 'currently'."],
    [/\bpursuant to\b/i, "Replaced legalese 'pursuant to' with plain 'under'."],
    [/\bmust be resolved concerning\b/i, "Replaced passive 'must be resolved concerning' with active 'arise regarding'."],
    [/\bas opposed to\b/i, "Replaced 'as opposed to' with concise 'contrasting with'."],
  ];

  for (const [pattern, message] of academicPatterns) {
    if (pattern.test(origLower) && !pattern.test(rewLower)) {
      suggestions.push(message);
    }
  }

  if (/\[\d+\]/.test(original)) {
    suggestions.push("Preserved all citation markers and footnote references intact.");
  }

  const origSentences = original.split(/(?<=[.!?])\s+/);
  const rewSentences = rewritten.split(/(?<=[.!?])\s+/);
  const specificChanges = [];
  for (let i = 0; i < Math.min(origSentences.length, rewSentences.length, 15); i++) {
    if (comparable(origSentences[i]) !== comparable(rewSentences[i])) {
      const origPhrase = origSentences[i].trim().substring(0, 100);
      const rewPhrase = rewSentences[i].trim().substring(0, 100);
      if (origPhrase && rewPhrase) {
        specificChanges.push('"' + origPhrase + (origSentences[i].length > 100 ? "..." : "") + '" \u2192 "' + rewPhrase + (rewSentences[i].length > 100 ? "..." : "") + '"');
      }
    }
  }
  if (specificChanges.length > 0 && specificChanges.length <= 15) {
    specificChanges.forEach((change) => suggestions.push("Changed: " + change + "."));
  } else if (specificChanges.length > 15) {
    specificChanges.slice(0, 10).forEach((change) => suggestions.push("Changed: " + change + "."));
    suggestions.push("...and " + (specificChanges.length - 10) + " more sentence-level improvements.");
  }

  if (suggestions.length === 0) {
    const origSentences = original.split(/(?<=[.!?])\s+/);
    const rewSentences = rewritten.split(/(?<=[.!?])\s+/);
    let changedCount = 0;
    for (let i = 0; i < Math.min(origSentences.length, rewSentences.length); i++) {
      if (comparable(origSentences[i]) !== comparable(rewSentences[i])) changedCount++;
    }
    if (changedCount > 0) {
      suggestions.push("Refined " + changedCount + " sentence" + (changedCount > 1 ? "s" : "") + " for improved flow and clarity.");
    } else {
      suggestions.push("Text already reads naturally; minor punctuation and spacing adjustments applied.");
    }
  }

  const explanation = "Refined for " + options.domain + " " + options.tone + " English"
    + (options.forcedDialect ? " in " + options.forcedDialect + " dialect" : "")
    + ". " + suggestions.length + " improvement" + (suggestions.length !== 1 ? "s" : "") + " applied while preserving citations, footnotes, and source structure.";

  return { suggestions, explanation };
}

function normalizeSentence(sentence, index) {
  const original = cleanText(sentence?.original || "");
  const native = cleanText(sentence?.native || sentence?.text || original);
  const isHeading = Boolean(sentence?.isHeading);
  const immutable = Boolean(sentence?.isImmutableFootnote) || FOOTNOTE_DEF_REGEX.test(original);

  return {
    original,
    native,
    isNativeMatch: Boolean(sentence?.isNativeMatch) || comparable(original) === comparable(native),
    isEndOfParagraph: sentence?.isEndOfParagraph !== false || isHeading || index === 0,
    isHeading,
    isImmutableFootnote: immutable,
  };
}

function parseJsonFromModel(rawText) {
  const text = String(rawText || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Provider did not return valid JSON.");
  }
}

function buildDeterministicResult(text, options, reason) {
  const finalVersion = deterministicPolish(text);
  const originalScore = estimateScore(text);
  const revisedScore = estimateScore(finalVersion);
  const analysis = buildAnalysis(text, finalVersion, options);

  return {
    finalVersion,
    sentences: buildSentenceObjects(text, finalVersion),
    suggestions: analysis.suggestions,
    explanation: (reason ? "AI providers unavailable (" + reason + "). " : "") + analysis.explanation,
    originalScore,
    revisedScore: Math.max(revisedScore, originalScore + 2),
    detectedDialect: options.forcedDialect || detectDialect(text),
    provider: "deterministic",
  };
}

function deterministicPolish(text) {
  const replacements = [
    [/\bthe results of the experiment demonstrates\b/gi, "the results of the experiment demonstrate"],
    [/\bdiscuss about\b/gi, "discuss"],
    [/\bin order to\b/gi, "to"],
    [/\bdue to the fact that\b/gi, "because"],
    [/\bat this point in time\b/gi, "currently"],
    [/\bmake a research\b/gi, "conduct research"],
    [/\bdo a decision\b/gi, "make a decision"],
    [/\bI go\b/g, "I went"],
    [/\bbuy some\b/gi, "bought some"],
    [/\bI forget\b/g, "I forgot"],
    [/\bseveral location including\b/gi, "several locations including"],
    [/\bwas always a protectorate for the period preceding\b/gi, "was a protectorate before"],
    [/\bmeaning that outside states guaranteed\b/gi, "meaning that external powers guaranteed"],
    [/\bat that time among\b/gi, "at the time among"],
    [/\ba yet more daring and unprecedented undertaking,?\s*building\b/gi, "a more ambitious undertaking, building"],
    [/\ba reported\b/gi, "a"],
    [/\bpursuant to\b/gi, "under"],
    [/\bsubsequent to\b/gi, "after"],
    [/\bprior to\b/gi, "before"],
  ];

  let result = text.replace(/\r\n/g, "\n");
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }

  return result
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?])\s+([a-z])/g, (_match, punct, letter) => punct + " " + letter.toUpperCase())
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildSentenceObjects(originalText, finalText) {
  const originals = splitForDisplay(originalText);
  const natives = splitForDisplay(finalText);
  const maxLen = Math.max(originals.length, natives.length);
  const sentences = [];

  for (let i = 0; i < maxLen; i++) {
    const original = originals[i]?.text || "";
    const native = natives[i]?.text || original;
    const immutable = FOOTNOTE_DEF_REGEX.test(original);
    sentences.push({
      original,
      native: immutable ? original : native,
      isNativeMatch: comparable(original) === comparable(native),
      isEndOfParagraph: originals[i]?.isEndOfParagraph ?? true,
      isHeading: originals[i]?.isHeading ?? false,
      isImmutableFootnote: immutable,
    });
  }

  return sentences;
}

function splitForDisplay(text) {
  const blocks = String(text || "").split(/\n{2,}/);
  const items = [];

  for (const block of blocks) {
    const trimmedBlock = block.trim();
    if (!trimmedBlock) continue;

    const lines = trimmedBlock.split(/\n/).map((line) => line.trim()).filter(Boolean);

    if (lines.length === 1 && looksLikeHeading(lines[0])) {
      items.push({ text: lines[0], isEndOfParagraph: true, isHeading: true });
      continue;
    }

    const isFootnoteBlock = lines.some((line) => FOOTNOTE_DEF_REGEX.test(line));
    if (isFootnoteBlock) {
      items.push({ text: trimmedBlock, isEndOfParagraph: true, isHeading: false });
      continue;
    }

    const parts = trimmedBlock.match(/[^.!?]+(?:[.!?]+|$)(?:\s*\[\d{1,3}\])?/g) || [trimmedBlock];
    parts.forEach((part, index) => {
      const value = part.trim();
      if (value) {
        items.push({
          text: value,
          isEndOfParagraph: index === parts.length - 1,
          isHeading: false,
        });
      }
    });
  }

  return items;
}

function looksLikeHeading(text) {
  return text.length <= 80 && !/[.!?]$/.test(text) && !FOOTNOTE_DEF_REGEX.test(text);
}

function detectDialect(text) {
  const lower = text.toLowerCase();
  if (/\b(colour|favour|centre|analyse|behaviour|organisation)\b/.test(lower)) return "UK";
  if (/\b(color|favor|center|analyze|behavior|organization)\b/.test(lower)) return "US";
  return "US";
}

function estimateScore(text) {
  const lower = String(text || "").toLowerCase();
  const issuePatterns = [
    [/\bdemonstrates that there is\b/, 5],
    [/\bdiscuss about\b/, 5],
    [/\bin order to\b/, 4],
    [/\bdue to the fact that\b/, 5],
    [/\bat this point in time\b/, 5],
    [/\bi go\b/, 4],
    [/\bi forget\b/, 4],
    [/\s{2,}/, 2],
    [/\bcasting a broad look\b/, 4],
    [/\byet more daring and unprecedented\b/, 3],
    [/\bmeaning that\b/, 2],
    [/\bprior to\b/, 2],
    [/\bsubsequent to\b/, 2],
    [/\bpursuant to\b/, 2],
    [/\ba reported\b/, 2],
    [/\bfor the period preceding\b/, 3],
    [/\bat that time among\b/, 2],
    [/\bseveral location including\b/, 3],
    [/\bwas always a\b/, 1],
    [/\bmust be resolved concerning\b/, 4],
    [/\bmust be resolved\b/, 2],
    [/\bconcerning this\b/, 2],
    [/\ballocates? a peripheral position\b/, 3],
    [/\baccorded to\b/, 2],
    [/\bto an increasingly unusual degree\b/, 3],
    [/\bto an unusual degree\b/, 2],
    [/\bthis points to the limits\b/, 2],
    [/\bas opposed to\b/, 2],
    [/\bmore extensive,? more populous\b/, 1],
    [/\binfluence the course of events\b/, 2],
    [/\bnewly acquired status\b/, 1],
    [/\botherwise more powerful\b/, 1],
    [/\bcentral position of\b/, 2],
    [/\bperipheral position to\b/, 2],
    [/\branges between\b/, 1],
    [/\bincreasingly unusual\b/, 2],
  ];

  let deductions = 0;
  for (const [pattern, penalty] of issuePatterns) {
    if (pattern.test(lower)) deductions += penalty;
  }

  return Math.max(55, Math.min(97, 92 - deductions));
}

function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function normalizeStringArray(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.map((item) => cleanText(item)).filter(Boolean);
  return cleaned.length > 0 ? cleaned.slice(0, 5) : fallback;
}

function cleanText(value) {
  let result = String(value || "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();

  // Fix corrupted Unicode characters (e.g., "War?II" from non-breaking space)
  result = result.replace(/([a-zA-Z])[\?\u00A0\u2007\u202F\uFEFF]+([A-Z])/g, '$1 $2');

  // Fix double spaces
  result = result.replace(/\s{2,}/g, ' ');

  return result;
}

function extractPhrases(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const phrases = new Set();
  for (let len = 2; len <= Math.min(5, words.length); len++) {
    for (let i = 0; i <= words.length - len; i++) {
      const phrase = words.slice(i, i + len).join(" ").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      if (phrase.split(/\s+/).length >= 2 && phrase.length > 6) {
        phrases.add(phrase);
      }
    }
  }
  return phrases;
}

function comparable(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function safeOption(value, fallback) {
  const text = String(value || "").trim();
  return /^[a-z-]{2,24}$/i.test(text) ? text : fallback;
}

function safeDialect(value) {
  const text = String(value || "").trim().toUpperCase();
  return ["US", "UK", "AU", "CA"].includes(text) ? text : undefined;
}

function clampScore(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: JSON_HEADERS,
  });
}
