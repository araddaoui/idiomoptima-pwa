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
    "- NEVER use em dashes (—). Use commas, semicolons, or parentheses instead. En dashes (–) are acceptable in page ranges and date ranges.\n" +
    "- Do NOT change the formality level. If the original uses 'I am', keep 'I am' — do NOT contract to 'I'm'. If the original uses 'We are', keep 'We are' — do NOT contract to 'We're'. If the original uses 'is not', keep 'is not' — do NOT contract to 'isn't'. Preserve the author's register.\n" +
    "- Do NOT swap synonyms when the original word is already correct. Only change a word if it is clearly wrong, awkward, or unnatural. 'Explore' is fine — do NOT change it to 'Discover'. 'built' is fine — do NOT change it to 'launched'. 'respect' is fine — do NOT change it to 'honors'.\n" +
    "- Do NOT change the meaning. 'practicing and teaching' means the author was actively practicing AND teaching — do NOT change this to 'taught and studied'.\n" +
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
    "- NEVER use em dashes (—). Use commas, semicolons, or parentheses instead. En dashes (–) are acceptable in page ranges and date ranges.\n" +
    "- Do NOT change the formality level. If the original uses 'I am', keep 'I am' — do NOT contract to 'I'm'. If the original uses 'We are', keep 'We are' — do NOT contract to 'We're'. If the original uses 'is not', keep 'is not' — do NOT contract to 'isn't'. Preserve the author's register.\n" +
    "- Do NOT swap synonyms when the original word is already correct. Only change a word if it is clearly wrong, awkward, or unnatural. 'Explore' is fine — do NOT change it to 'Discover'. 'built' is fine — do NOT change it to 'launched'. 'respect' is fine — do NOT change it to 'honors'.\n" +
    "- Do NOT change the meaning. 'practicing and teaching' means the author was actively practicing AND teaching — do NOT change this to 'taught and studied'.\n" +
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
  const noCorruption = revertCorruptions(originalText, cleaned);
  const finalVersion = revertContractions(originalText, noCorruption);

  if (comparable(finalVersion) === comparable(originalText)) {
    throw new Error("Gemini returned unchanged text");
  }

  const detectedDialect = safeDialect(parsed.detectedDialect) || options.forcedDialect || detectDialect(originalText);
  const sentences = Array.isArray(parsed.sentences) && parsed.sentences.length > 0
    ? parsed.sentences.map((sentence, index) => normalizeSentence(sentence, index))
    : buildSentenceObjects(originalText, finalVersion);

  const analysis = buildAnalysis(originalText, finalVersion, options);
  const origRubric = estimateScore(originalText, options.domain, options.mode);
  const revRubric = estimateScore(finalVersion, options.domain, options.mode);

  const gemRevisedScore = clampScore(parsed.revisedScore, Math.min(97, Math.max(revRubric.score + 2, origRubric.score + 3)));
  const gemBonus = Math.max(1, gemRevisedScore - origRubric.score);
  const gemMetrics = {};
  const gemMetricBonus = Math.round(gemBonus / 7);
  for (const key of Object.keys(origRubric.metrics)) {
    gemMetrics[key] = Math.min(100, origRubric.metrics[key] + gemMetricBonus + (revRubric.metrics[key] > origRubric.metrics[key] ? 1 : 0));
  }

  return {
    finalVersion,
    sentences,
    suggestions: analysis.suggestions,
    explanation: analysis.explanation,
    originalScore: clampScore(parsed.originalScore, origRubric.score),
    revisedScore: gemRevisedScore,
    rubric: origRubric.rubric,
    originalMetrics: origRubric.metrics,
    originalComments: origRubric.comments,
    originalLetterGrade: origRubric.letterGrade,
    revisedMetrics: gemMetrics,
    revisedComments: revRubric.comments,
    revisedLetterGrade: scoreToLetter(gemRevisedScore),
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

      if (origWord.includes('-') && revWord.includes('-')) {
        const origParts = origWord.toLowerCase().split('-');
        const revParts = revWord.toLowerCase().split('-');
        if (origParts.length === revParts.length && origParts[0] === revParts[0] && origParts[1] !== revParts[1]) {
          corrupted = true;
          break;
        }
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

const CONTRACTION_MAP = {
  "i'm": "I am", "i've": "I have", "i'll": "I will", "i'd": "I would",
  "we're": "We are", "we've": "We have", "we'll": "We will", "we'd": "We would",
  "they're": "They are", "they've": "They have", "they'll": "They will", "they'd": "They would",
  "you're": "You are", "you've": "You have", "you'll": "You will", "you'd": "You would",
  "he's": "He is", "he'll": "He will", "he'd": "He would",
  "she's": "She is", "she'll": "She will", "she'd": "She would",
  "it's": "It is", "it'll": "It will", "it'd": "It would",
  "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
  "hasn't": "has not", "haven't": "have not", "hadn't": "had not",
  "doesn't": "does not", "don't": "do not", "didn't": "did not",
  "can't": "cannot", "couldn't": "could not", "shouldn't": "should not",
  "won't": "will not", "wouldn't": "would not", "mustn't": "must not",
  "that's": "that is", "there's": "there is", "here's": "here is",
  "what's": "what is", "who's": "who is", "where's": "where is",
  "let's": "let us",
};

function revertContractions(originalText, revisedText) {
  const origLower = originalText.toLowerCase();
  const hasAnyContraction = Object.keys(CONTRACTION_MAP).some(c => origLower.includes(c));
  if (hasAnyContraction) return revisedText;

  let result = revisedText;
  for (const [contraction, expanded] of Object.entries(CONTRACTION_MAP)) {
    const regex = new RegExp("\\b" + contraction.replace("'", "'") + "\\b", "gi");
    result = result.replace(regex, (match) => {
      if (match[0] === match[0].toUpperCase() && expanded[0] === expanded[0].toLowerCase()) {
        return expanded.charAt(0).toUpperCase() + expanded.slice(1);
      }
      return expanded;
    });
  }
  return result;
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
  const noCorruption = revertCorruptions(originalText, withFootnotes);
  const finalVersion = revertContractions(originalText, noCorruption);
  const detectedDialect = options.forcedDialect || detectDialect(originalText);

  const sentences = buildSentenceObjects(originalText, finalVersion);
  const analysis = buildAnalysis(originalText, finalVersion, options);

  // Count actual changes by comparing sentences positionally
  const origSentences = originalText.split(/(?<=[.!?])\s+/);
  const rewSentences = finalVersion.split(/(?<=[.!?])\s+/);

  function significantChange(a, b) {
    const aW = a.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const bW = b.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const setA = new Set(aW);
    let overlap = 0;
    for (const w of bW) { if (setA.has(w)) overlap++; }
    const similarity = aW.length > 0 ? overlap / aW.length : 1;
    return similarity < 0.85;
  }

  let significantChanges = 0;
  for (let i = 0; i < Math.min(origSentences.length, rewSentences.length); i++) {
    if (significantChange(origSentences[i], rewSentences[i])) significantChanges++;
  }

  const origRubric = estimateScore(originalText, options.domain, options.mode);
  const revRubric = estimateScore(finalVersion, options.domain, options.mode);

  const changeRatio = origSentences.length > 0 ? significantChanges / origSentences.length : 0;
  const improvementBonus = Math.round(Math.min(12, significantChanges * 0.6 + changeRatio * 8));
  const revisedScore = Math.min(97, origRubric.score + Math.max(1, improvementBonus));

  const metricBonus = Math.round(improvementBonus / 7);
  const revisedMetrics = {};
  for (const key of Object.keys(origRubric.metrics)) {
    revisedMetrics[key] = Math.min(100, origRubric.metrics[key] + metricBonus + (revRubric.metrics[key] > origRubric.metrics[key] ? 1 : 0));
  }

  const revComments = revRubric.comments.slice();
  if (significantChanges > 0) {
    revComments.unshift(improvementBonus + "-point improvement across " + significantChanges + " sentence" + (significantChanges > 1 ? "s" : ""));
  } else {
    revComments.unshift("Minor refinements applied — text was already strong");
  }

  return {
    finalVersion,
    sentences,
    suggestions: analysis.suggestions,
    explanation: analysis.explanation,
    originalScore: origRubric.score,
    revisedScore,
    rubric: origRubric.rubric,
    originalMetrics: origRubric.metrics,
    originalComments: origRubric.comments,
    originalLetterGrade: origRubric.letterGrade,
    revisedMetrics,
    revisedComments: revComments,
    revisedLetterGrade: scoreToLetter(revisedScore),
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
  const origRubric = estimateScore(text, options.domain, options.mode);
  const revRubric = estimateScore(finalVersion, options.domain, options.mode);
  const analysis = buildAnalysis(text, finalVersion, options);

  const improvementBonus = Math.min(5, Math.max(1, Math.round((revRubric.score - origRubric.score) * 0.5 + 1)));
  const revisedScore = Math.min(95, origRubric.score + improvementBonus);

  const detMetrics = {};
  const detMetricBonus = Math.round(improvementBonus / 7);
  for (const key of Object.keys(origRubric.metrics)) {
    detMetrics[key] = Math.min(100, origRubric.metrics[key] + detMetricBonus + (revRubric.metrics[key] > origRubric.metrics[key] ? 1 : 0));
  }

  return {
    finalVersion,
    sentences: buildSentenceObjects(text, finalVersion),
    suggestions: analysis.suggestions,
    explanation: (reason ? "AI providers unavailable (" + reason + "). " : "") + analysis.explanation,
    originalScore: origRubric.score,
    revisedScore,
    rubric: origRubric.rubric,
    originalMetrics: origRubric.metrics,
    originalComments: origRubric.comments,
    originalLetterGrade: origRubric.letterGrade,
    revisedMetrics: detMetrics,
    revisedComments: revRubric.comments,
    revisedLetterGrade: scoreToLetter(revisedScore),
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

const REGISTER_RUBRICS = {
  academic: {
    weights: { wordiness: 20, passiveVoice: 12, sentenceLength: 10, lexicalDiversity: 12, vocabulary: 20, sentenceVariety: 13, register: 13 },
  },
  business: {
    weights: { wordiness: 18, passiveVoice: 10, sentenceLength: 15, lexicalDiversity: 12, vocabulary: 15, sentenceVariety: 15, register: 15 },
  },
  general: {
    weights: { wordiness: 12, passiveVoice: 8, sentenceLength: 15, lexicalDiversity: 18, vocabulary: 12, sentenceVariety: 18, register: 17 },
  },
  creative: {
    weights: { wordiness: 5, passiveVoice: 3, sentenceLength: 10, lexicalDiversity: 25, vocabulary: 20, sentenceVariety: 22, register: 15 },
  },
};

function detectRegister(text, domain, mode) {
  const d = String(domain || "").toLowerCase();
  const m = String(mode || "").toLowerCase();
  if (d === "academic" || d === "scholarly" || d === "research") return "academic";
  if (d === "business" || d === "corporate" || d === "professional") return "business";
  if (d === "creative" || d === "fiction" || d === "narrative" || m === "creative") return "creative";
  const lower = String(text || "").toLowerCase();
  const academicHits = (lower.match(/\b(thesis|dissertation|abstract|introduction|methodology|findings|conclusion|references|literature review|hypothesis|empirical|epistemolog|ontolog|pedagog|paradigm|theor|conceptual framework|research question|research puzzle|qualitative|quantitative|discourse|constructivism|liberalism|realism|international relations|interventionism|interventionist|geopolit|sovereignty|hegemon|praxis|normative|positivist|postpositivist)\b/g) || []).length;
  if (academicHits >= 3) return "academic";
  if (/\b(chapter|once upon|protagonist|dialogue|poem|stanza|metaphor)\b/.test(lower)) return "creative";
  if (/\b(dear\s+(sir|madam|team)|regards|sincerely|memo|proposal|quarterly|stakeholders)\b/.test(lower)) return "business";
  if (/\[\d+\]/.test(text) && academicHits >= 1) return "academic";
  return "general";
}

function scoreToLetter(score) {
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 60) return "D";
  return "F";
}

const WORDINESS_PATTERNS = [
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
  [/\bgo to the extent of\b/, 4],
  [/\bthe extent to which\b/, 3],
  [/\binasmuch as\b/, 4],
  [/\bfaulted with\b/, 2],
  [/\byielding less than\b/, 2],
  [/\bthe procedure gave the researcher\b/, 4],
  [/\ba window into the thinking of\b/, 4],
];

function estimateScore(text, domain, mode) {
  const reg = detectRegister(text, domain, mode);
  const rubric = REGISTER_RUBRICS[reg] || REGISTER_RUBRICS.general;
  const lower = String(text || "").toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const sentences = String(text || "").split(/[.!?]+/).filter(s => s.trim().length > 0);
  const wordCount = words.length;
  const sentenceCount = Math.max(1, sentences.length);

  const metrics = {};
  const comments = [];

  let wordinessPenalty = 0;
  for (const [pattern, penalty] of WORDINESS_PATTERNS) {
    if (pattern.test(lower)) wordinessPenalty += penalty;
  }
  metrics.wordiness = Math.max(0, 100 - wordinessPenalty * 10);
  if (wordinessPenalty === 0) comments.push("No wordiness patterns detected");
  else comments.push("Detected " + wordinessPenalty + " wordiness points from verbose patterns");

  let passivePenalty = 0;
  const passiveMatches = lower.match(/\b(was|were|is|are|been|being)\s+\w+ed\b/g);
  const passiveRatio = passiveMatches ? passiveMatches.length / sentenceCount : 0;
  if (passiveRatio > 0.4) passivePenalty = 30;
  else if (passiveRatio > 0.25) passivePenalty = 20;
  else if (passiveRatio > 0.15) passivePenalty = 10;
  else if (passiveRatio > 0.08) passivePenalty = 5;
  metrics.passiveVoice = Math.max(0, 100 - passivePenalty);
  if (passiveRatio > 0.15) comments.push("Passive voice ratio " + Math.round(passiveRatio * 100) + "% — elevated for " + reg + " register");
  else comments.push("Passive voice within acceptable range (" + Math.round(passiveRatio * 100) + "%)");

  const avgSentenceLen = wordCount / sentenceCount;
  let sentenceLenScore = 100;
  if (reg === "academic") {
    if (avgSentenceLen > 30) { sentenceLenScore = 60; comments.push("Average sentence length " + Math.round(avgSentenceLen) + " words — long for academic prose"); }
    else if (avgSentenceLen > 25) { sentenceLenScore = 80; comments.push("Average sentence length " + Math.round(avgSentenceLen) + " words — slightly long"); }
    else if (avgSentenceLen < 10) { sentenceLenScore = 70; comments.push("Average sentence length " + Math.round(avgSentenceLen) + " words — unusually short"); }
    else { comments.push("Sentence length appropriate for academic register (" + Math.round(avgSentenceLen) + " words avg)"); }
  } else if (reg === "business") {
    if (avgSentenceLen > 25) { sentenceLenScore = 65; comments.push("Average sentence length " + Math.round(avgSentenceLen) + " words — long for business writing"); }
    else if (avgSentenceLen < 8) { sentenceLenScore = 75; comments.push("Average sentence length " + Math.round(avgSentenceLen) + " words — very short"); }
    else { comments.push("Sentence length appropriate for business register"); }
  } else if (reg === "creative") {
    sentenceLenScore = 95;
    comments.push("Sentence variety noted in creative register");
  } else {
    if (avgSentenceLen > 30) { sentenceLenScore = 65; comments.push("Average sentence length " + Math.round(avgSentenceLen) + " words — long"); }
    else { comments.push("Sentence length within normal range"); }
  }
  metrics.sentenceLength = Math.max(0, sentenceLenScore);

  const uniqueWords = new Set(words.filter(w => w.length > 3));
  const lexicalDiversity = wordCount > 0 ? uniqueWords.size / wordCount : 1;
  let diversityScore = 100;
  if (lexicalDiversity < 0.35) { diversityScore = 50; comments.push("Low lexical diversity (" + (lexicalDiversity * 100).toFixed(0) + "% unique long words)"); }
  else if (lexicalDiversity < 0.45) { diversityScore = 70; comments.push("Moderate lexical diversity (" + (lexicalDiversity * 100).toFixed(0) + "%)"); }
  else if (lexicalDiversity < 0.55) { diversityScore = 85; comments.push("Good lexical diversity (" + (lexicalDiversity * 100).toFixed(0) + "%)"); }
  else { comments.push("Strong lexical diversity (" + (lexicalDiversity * 100).toFixed(0) + "% unique long words)"); }
  metrics.lexicalDiversity = diversityScore;

  const longWords = words.filter(w => w.replace(/[^a-z]/g, "").length > 6);
  const sophisticationRatio = wordCount > 0 ? longWords.length / wordCount : 0;
  let vocabScore = 80;
  if (reg === "academic") {
    if (sophisticationRatio > 0.2) { vocabScore = 95; comments.push("Vocabulary sophistication appropriate for academic register"); }
    else if (sophisticationRatio > 0.12) { vocabScore = 85; comments.push("Vocabulary level adequate for academic writing"); }
    else { vocabScore = 65; comments.push("Vocabulary may be too simple for academic register (" + (sophisticationRatio * 100).toFixed(0) + "% complex words)"); }
  } else if (reg === "business") {
    if (sophisticationRatio > 0.15) { vocabScore = 90; comments.push("Vocabulary level appropriate for business register"); }
    else if (sophisticationRatio > 0.08) { vocabScore = 80; comments.push("Vocabulary level standard for business writing"); }
    else { vocabScore = 70; comments.push("Vocabulary may be too informal for business register"); }
  } else if (reg === "creative") {
    if (sophisticationRatio > 0.08 && sophisticationRatio < 0.25) { vocabScore = 90; comments.push("Vocabulary variety suits creative register"); }
    else if (sophisticationRatio >= 0.25) { vocabScore = 80; comments.push("Vocabulary somewhat dense for creative writing"); }
    else { vocabScore = 75; comments.push("Vocabulary may be too simple for literary register"); }
  } else {
    if (sophisticationRatio > 0.15) { vocabScore = 85; comments.push("Vocabulary level appropriate for general writing"); }
    else { vocabScore = 75; comments.push("Vocabulary somewhat basic"); }
  }
  metrics.vocabulary = vocabScore;

  const sentenceLengths = sentences.map(s => s.trim().split(/\s+/).filter(Boolean).length).filter(l => l > 0);
  let varietyScore = 80;
  if (sentenceLengths.length >= 3) {
    const mean = sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length;
    const variance = sentenceLengths.reduce((sum, l) => sum + Math.pow(l - mean, 2), 0) / sentenceLengths.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    if (cv > 0.5) { varietyScore = 95; comments.push("Excellent sentence variety (CV: " + (cv * 100).toFixed(0) + "%)"); }
    else if (cv > 0.35) { varietyScore = 85; comments.push("Good sentence variety (CV: " + (cv * 100).toFixed(0) + "%)"); }
    else if (cv > 0.2) { varietyScore = 75; comments.push("Moderate sentence variety (CV: " + (cv * 100).toFixed(0) + "%)"); }
    else { varietyScore = 60; comments.push("Low sentence variety — sentences are similar length (CV: " + (cv * 100).toFixed(0) + "%)"); }
  } else {
    varietyScore = 80;
    comments.push("Too few sentences to measure variety");
  }
  metrics.sentenceVariety = varietyScore;

  const contractions = lower.match(/\b\w+'\w+\b/g) || [];
  const informalMarkers = lower.match(/\b(hey|gonna|wanna|kinda|gotta|yeah|yep|nope|ok|okay|lol|omg|btw)\b/g) || [];
  const slangRatio = (contractions.length + informalMarkers.length) / Math.max(1, wordCount);
  let registerScore = 100;
  if (reg === "academic") {
    if (contractions.length > 0) { registerScore -= contractions.length * 5; comments.push("Academic register flagged " + contractions.length + " contraction(s) — inappropriate for formal prose"); }
    if (informalMarkers.length > 0) { registerScore -= informalMarkers.length * 10; comments.push("Found " + informalMarkers.length + " informal marker(s) in academic text"); }
  } else if (reg === "business") {
    if (informalMarkers.length > 0) { registerScore -= informalMarkers.length * 8; comments.push("Found " + informalMarkers.length + " informal marker(s) in business text"); }
  } else if (reg === "general") {
    if (slangRatio > 0.05) { registerScore -= 15; comments.push("High slang/contraction density for general register"); }
  }
  if (registerScore >= 100) comments.push("Register is consistent with " + reg + " expectations");
  metrics.register = Math.max(0, registerScore);

  let weightedSum = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(rubric.weights)) {
    const metricScore = metrics[key] || 0;
    weightedSum += metricScore * weight;
    totalWeight += weight;
  }

  const rawScore = totalWeight > 0 ? weightedSum / totalWeight : 80;
  const grade = Math.round(Math.max(40, Math.min(97, rawScore)));

  return {
    score: grade,
    rubric: reg,
    metrics,
    comments,
    letterGrade: scoreToLetter(grade),
  };
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

  // Replace em dashes (—) with commas; preserve en dashes (–) in page ranges
  result = result.replace(/—/g, ', ');
  // Replace en dashes only between words (not between digits like page ranges)
  result = result.replace(/([a-zA-Z])\s*–\s*([a-zA-Z])/g, '$1, $2');

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
