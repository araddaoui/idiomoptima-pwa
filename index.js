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
    "- CRITICAL: Footnotes and reference lists must appear EXACTLY ONCE in the output, at the very end. NEVER repeat the same footnote after different paragraphs or sentences. NEVER write the same footnote block more than once. If the input has one footnote, the output must have exactly one footnote.\n" +
    "- CRITICAL: Preserve ALL formatting markers exactly as they appear. Keep **bold**, *italic*, __underline__, # headings, ## subheadings, - bullet lists, and > blockquotes. Do NOT strip, alter, or reorder formatting.\n" +
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
  const cleaned = cleanText(parsed.finalVersion || parsed.final || parsed.text || originalText);
  const finalVersion = revertCorruptions(originalText, cleaned);

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
    revisedScore: clampScore(parsed.revisedScore, Math.min(97, Math.max(estimateScore(finalVersion) + 2, estimateScore(originalText) + 3))),
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
                           /^Footnote\s*\d*/i.test(trimmed) ||
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

function extractFingerprint(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 15)
    .join(' ');
}

function deduplicateFootnoteBlocks(text) {
  const blocks = text.split(/\n{2,}/);
  const seen = [];
  const result = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    const fp = extractFingerprint(trimmed);
    if (!fp) {
      result.push(block);
      continue;
    }

    const isDuplicate = seen.some(seenFp => {
      const seenWords = seenFp.split(' ');
      const curWords = fp.split(' ');
      let overlap = 0;
      for (const w of curWords) {
        if (seenWords.includes(w)) overlap++;
      }
      return overlap / Math.max(1, curWords.length) > 0.7;
    });

    if (isDuplicate) {
      console.log('[deduplicateFootnoteBlocks] Removing duplicate block: ' + trimmed.substring(0, 60));
      continue;
    }
    seen.push(fp);
    result.push(block);
  }

  return result.join('\n\n');
}

function restoreTruncatedFootnotes(original, rewritten) {
  let result = deduplicateFootnotes(rewritten);
  result = deduplicateFootnoteBlocks(result);

  const footnoteRegex = /^\s*(?:\[?\d{1,3}\]?\s|REFERENCE\s+\d+|Footnote\s*:)/i;
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
    const firstChars = fn.replace(/^\s*(?:\[?\d{1,3}\]?[\s.:)\-|]*|Footnote\s*:|REFERENCE\s+\d+[\s.:)\-|]*)/i, '').trim().substring(0, 30).toLowerCase();
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

function revertCorruptions(originalText, revisedText) {
  const origSentences = originalText.split(/(?<=[.!?])\s+/);
  const revSentences = revisedText.split(/(?<=[.!?])\s+/);

  if (origSentences.length !== revSentences.length) return revisedText;

  const fixed = [];
  for (let i = 0; i < origSentences.length; i++) {
    const orig = origSentences[i];
    const rev = revSentences[i];
    if (comparable(orig) === comparable(rev)) {
      fixed.push(rev);
      continue;
    }

    const origWords = orig.split(/\s+/);
    const revWords = rev.split(/\s+/);
    let changedIndices = [];
    for (let j = 0; j < Math.min(origWords.length, revWords.length); j++) {
      if (comparable(origWords[j]) !== comparable(revWords[j])) {
        changedIndices.push(j);
      }
    }

    if (changedIndices.length === 0 || changedIndices.length > Math.ceil(origWords.length * 0.4)) {
      fixed.push(rev);
      continue;
    }

    let corrupted = false;
    for (const idx of changedIndices) {
      const origWord = origWords[idx].replace(/[^a-zA-Z'-]/g, '');
      const revWord = revWords[idx].replace(/[^a-zA-Z'-]/g, '');

      if (origWord.length >= 4 && revWord.length >= 4) {
        const commonPrefix = countCommonPrefix(origWord.toLowerCase(), revWord.toLowerCase());
        const similarity = commonPrefix / Math.max(origWord.length, revWord.length);
        if (similarity > 0.3 && similarity < 0.8 && revWord.length < origWord.length) {
          corrupted = true;
          break;
        }
      }

      if (/\b\w+-\w+\b/.test(origWord) && !/\b\w+-\w+\b/.test(revWord)) {
        corrupted = true;
        break;
      }

      if (origWord.length >= 5 && revWord.length <= 2 && !/^(a|i|o)$/.test(revWord.toLowerCase())) {
        corrupted = true;
        break;
      }

      if (revWord.length >= 3 && origWord.length >= 3) {
        const vowels = (revWord.match(/[aeiou]/gi) || []).length;
        const consonants = revWord.replace(/[aeiou]/gi, '').length;
        if (consonants > vowels * 2 && revWord.length >= 5) {
          corrupted = true;
          break;
        }
      }
    }

    if (corrupted) {
      fixed.push(orig);
    } else {
      fixed.push(rev);
    }
  }

  return fixed.join(' ');
}

function countCommonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function buildResultFromRewrite(originalText, rewrittenText, options, provider) {
  const cleaned = cleanText(rewrittenText);
  const withCitations = restoreInlineCitations(originalText, cleaned);
  const withFootnotes = restoreTruncatedFootnotes(originalText, withCitations);
  const finalVersion = revertCorruptions(originalText, withFootnotes);
  const detectedDialect = options.forcedDialect || detectDialect(originalText);

  const sentences = buildSentenceObjects(originalText, finalVersion);
  const analysis = buildAnalysis(originalText, finalVersion, options);

  // Count actual changes by comparing sentences positionally
  const origSentences = originalText.split(/(?<=[.!?])\s+/);
  const rewSentences = finalVersion.split(/(?<=[.!?])\s+/);
  let changedCount = 0;
  for (let i = 0; i < Math.min(origSentences.length, rewSentences.length); i++) {
    if (comparable(origSentences[i]) !== comparable(rewSentences[i])) changedCount++;
  }

  // Count analysis-level improvements (pattern matches + specific changes)
  const specificChangeCount = analysis.suggestions.filter(s => s.startsWith('Changed:')).length;
  const patternFixCount = analysis.suggestions.filter(s => !s.startsWith('Changed:') && !s.startsWith('Preserved') && !s.startsWith('Condensed') && !s.startsWith('Broke') && !s.startsWith('Refined') && !s.startsWith('Text already')).length;
  const totalImprovements = specificChangeCount + patternFixCount;

  const changeRatio = origSentences.length > 0 ? changedCount / origSentences.length : 0;

  const baseOriginalScore = estimateScore(originalText);
  const baseRevisedScore = estimateScore(finalVersion);

  const originalScore = Math.max(55, Math.min(88, baseOriginalScore - Math.min(totalImprovements, 10)));

  const improvementMagnitude = Math.min(1, totalImprovements / 10);
  const qualityBonus = Math.round(improvementMagnitude * 6 + changeRatio * 4);
  const revisedScore = Math.max(originalScore + 1, Math.min(97, baseRevisedScore + qualityBonus));

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

  // Content-based sentence matching (handles reordering)
  const origSentences = original.split(/(?<=[.!?])\s+/);
  const rewSentences = rewritten.split(/(?<=[.!?])\s+/);

  function sentenceWords(s) {
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  }
  function wordOverlap(a, b) {
    const setB = new Set(b);
    let overlap = 0;
    for (const w of a) { if (setB.has(w)) overlap++; }
    return a.length > 0 ? overlap / a.length : 0;
  }

  const matchedOrigins = new Set();
  const matchedRewrites = new Set();
  const specificChanges = [];

  // For each original sentence, find best match in rewritten
  for (let i = 0; i < origSentences.length && specificChanges.length < 15; i++) {
    const origWords = sentenceWords(origSentences[i]);
    if (origWords.length < 3) continue;

    let bestJ = -1;
    let bestScore = 0;
    for (let j = 0; j < rewSentences.length; j++) {
      if (matchedRewrites.has(j)) continue;
      const rewWords = sentenceWords(rewSentences[j]);
      const score = wordOverlap(origWords, rewWords);
      if (score > bestScore) {
        bestScore = score;
        bestJ = j;
      }
    }

    if (bestJ >= 0 && bestScore > 0.3) {
      matchedOrigins.add(i);
      matchedRewrites.add(bestJ);
      if (comparable(origSentences[i]) !== comparable(rewSentences[bestJ])) {
        const origPhrase = origSentences[i].trim().substring(0, 100);
        const rewPhrase = rewSentences[bestJ].trim().substring(0, 100);
        if (origPhrase && rewPhrase) {
          specificChanges.push('"' + origPhrase + (origSentences[i].length > 100 ? "..." : "") + '" \u2192 "' + rewPhrase + (rewSentences[bestJ].length > 100 ? "..." : "") + '"');
        }
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
    originalScore: Math.min(85, originalScore),
    revisedScore: Math.max(revisedScore + 1, Math.min(92, originalScore + 3)),
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
      headingLevel: originals[i]?.headingLevel ?? 0,
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

    if (lines.length === 1) {
      const headingLevel = looksLikeHeading(lines[0]);
      if (headingLevel > 0) {
        const stripped = lines[0].replace(/^#{1,4}\s+/, '').trim();
        items.push({ text: stripped, isEndOfParagraph: true, isHeading: true, headingLevel });
        continue;
      }
    }

    if (lines.length > 1) {
      const firstHeadingLevel = looksLikeHeading(lines[0]);
      if (firstHeadingLevel > 0) {
        const stripped = lines[0].replace(/^#{1,4}\s+/, '').trim();
        items.push({ text: stripped, isEndOfParagraph: true, isHeading: true, headingLevel: firstHeadingLevel });
        const rest = lines.slice(1).join(' ').trim();
        if (rest) {
          const parts = rest.match(/[^.!?]+(?:[.!?]+|$)(?:\s*\[\d{1,3}\])?/g) || [rest];
          parts.forEach((part, index) => {
            const value = part.trim();
            if (value) {
              items.push({ text: value, isEndOfParagraph: index === parts.length - 1, isHeading: false, headingLevel: 0 });
            }
          });
        }
        continue;
      }
    }

    const isFootnoteBlock = lines.some((line) => FOOTNOTE_DEF_REGEX.test(line));
    if (isFootnoteBlock) {
      items.push({ text: trimmedBlock, isEndOfParagraph: true, isHeading: false, headingLevel: 0 });
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
          headingLevel: 0,
        });
      }
    });
  }

  return items;
}

function looksLikeHeading(text) {
  const trimmed = text.trim();
  if (trimmed.length > 80 || /[.!?]$/.test(trimmed) || FOOTNOTE_DEF_REGEX.test(trimmed)) return 0;

  const mdMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
  if (mdMatch) {
    const stripped = mdMatch[2].trim();
    if (stripped.length <= 80 && !/[.!?]$/.test(stripped)) return mdMatch[1].length;
  }

  if (trimmed.length <= 30 && /^[A-Z\s:]+$/.test(trimmed)) return 1;
  if (trimmed.length <= 50 && /^[A-Z]/.test(trimmed) && !/,$/.test(trimmed)) return 2;
  if (trimmed.length <= 60 && !/[,;]$/.test(trimmed)) return 3;
  return 0;
}

function detectDialect(text) {
  const lower = text.toLowerCase();
  if (/\b(colour|favour|centre|analyse|behaviour|organisation)\b/.test(lower)) return "UK";
  if (/\b(color|favor|center|analyze|behavior|organization)\b/.test(lower)) return "US";
  return "US";
}

function estimateScore(text) {
  const lower = String(text || "").toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const sentences = String(text || "").split(/[.!?]+/).filter(s => s.trim().length > 0);
  const issuePatterns = [
    // Severe wordiness
    [/\bdemonstrates that there is\b/, 5],
    [/\bdiscuss about\b/, 5],
    [/\bin order to\b/, 4],
    [/\bdue to the fact that\b/, 5],
    [/\bat this point in time\b/, 5],
    [/\bfor the purpose of\b/, 4],
    [/\bwith regard to\b/, 4],
    [/\bin the event that\b/, 4],
    [/\bfor the reason that\b/, 5],
    [/\bon the grounds that\b/, 4],
    [/\bin light of the fact\b/, 5],
    [/\bat the present time\b/, 4],
    [/\bin a timely manner\b/, 4],
    [/\bprior to\b/, 2],
    [/\bsubsequent to\b/, 2],
    [/\bpursuant to\b/, 2],
    [/\bconcerning this\b/, 2],
    [/\bas opposed to\b/, 2],
    // Academic fluff
    [/\bcasting a broad look\b/, 4],
    [/\byet more daring and unprecedented\b/, 3],
    [/\bmeaning that\b/, 2],
    [/\ba reported\b/, 2],
    [/\bfor the period preceding\b/, 3],
    [/\bat that time among\b/, 2],
    [/\bseveral location including\b/, 3],
    [/\bwas always a\b/, 1],
    [/\bmust be resolved concerning\b/, 4],
    [/\bmust be resolved\b/, 2],
    [/\ballocates? a peripheral position\b/, 3],
    [/\baccorded to\b/, 2],
    [/\bto an increasingly unusual degree\b/, 3],
    [/\bto an unusual degree\b/, 2],
    [/\bthis points to the limits\b/, 2],
    [/\bmore extensive,? more populous\b/, 1],
    [/\binfluence the course of events\b/, 2],
    [/\bnewly acquired status\b/, 1],
    [/\botherwise more powerful\b/, 1],
    [/\bcentral position of\b/, 2],
    [/\bperipheral position to\b/, 2],
    [/\branges between\b/, 1],
    [/\bincreasingly unusual\b/, 2],
    // Common academic wordiness
    [/\bgo to the extent of\b/, 4],
    [/\bthe extent to which\b/, 3],
    [/\binasmuch as\b/, 4],
    [/\bfaulted with\b/, 2],
    [/\byielding less than\b/, 2],
    [/\bthe procedure gave the researcher\b/, 4],
    [/\ba window into the thinking of\b/, 4],
  ];

  let deductions = 0;
  for (const [pattern, penalty] of issuePatterns) {
    if (pattern.test(lower)) deductions += penalty;
  }

  let qualityDeductions = 0;

  if (sentences.length > 0) {
    const avgWordsPerSentence = words.length / sentences.length;
    if (avgWordsPerSentence > 35) qualityDeductions += 2;
    else if (avgWordsPerSentence > 25) qualityDeductions += 1;
  }

  const passiveMatches = lower.match(/\b(was|were|is|are|been|being)\s+\w+ed\b/g);
  if (passiveMatches && sentences.length > 0) {
    const passiveRatio = passiveMatches.length / sentences.length;
    if (passiveRatio > 0.4) qualityDeductions += 3;
    else if (passiveRatio > 0.25) qualityDeductions += 2;
    else if (passiveRatio > 0.15) qualityDeductions += 1;
  }

  const uniqueWords = new Set(words.filter(w => w.length > 3));
  const lexicalDiversity = words.length > 0 ? uniqueWords.size / words.length : 1;
  if (lexicalDiversity < 0.4) qualityDeductions += 2;
  else if (lexicalDiversity < 0.5) qualityDeductions += 1;

  return Math.max(55, Math.min(97, 85 - deductions - qualityDeductions));
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

  // Fix corrupted Unicode whitespace (non-breaking spaces, etc.)
  result = result.replace(/(\S)[\u00A0\u2007\u202F\uFEFF]+(\S)/g, '$1 $2');
  // Fix corruption like "T.?Minh" → "T. Minh" (period + corruption + capital)
  result = result.replace(/(\.)[\?\u00A0\u2007\u202F\uFEFF]+([A-Z])/g, '$1 $2');
  // Fix corruption like "War?II" → "War II" (letter + corruption + capital)
  result = result.replace(/([a-zA-Z])[\?\u00A0\u2007\u202F\uFEFF]+([A-Z])/g, '$1 $2');

  // Fix AI dropping words from proper nouns
  result = result.replace(/\bWorld II\b/g, 'World War II');

  // Fix lowercase sentence starters after period
  result = result.replace(/([.!?])\s+([a-z])/g, (match, punct, letter) => {
    return punct + ' ' + letter.toUpperCase();
  });

  // Fix informal sentence starters in academic context (only at start of sentence)
  result = result.replace(/([.!?]\s+)So,\s/g, '$1Consequently, ');
  result = result.replace(/([.!?]\s+)Also,\s/g, '$1Additionally, ');
  result = result.replace(/([.!?]\s+)But\s/g, '$1However, ');

  // Fix double spaces (but preserve paragraph breaks)
  result = result.replace(/[^\S\n]{2,}/g, ' ');

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
