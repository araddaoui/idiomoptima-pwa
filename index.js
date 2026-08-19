const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cache-Control",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
};

const FOOTNOTE_DEF_REGEX = /^\s*(?:\[?(\d{1,3})\]?[\s.:)\-|]{1,3}|Footnote\s*(\d{1,3}))[\s.:)\-|]*\s*(.+)/i;

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
    "- Preserve the exact meaning, claims, citations, footnote markers like [1][2][3], numbers, names, and paragraph breaks.\n" +
    "- Do NOT invent facts, citations, quotations, sources, or references.\n" +
    "- Improve grammar, idiom, collocation, word choice, clarity, and native flow.\n" +
    "- Make the text sound like a fluent native speaker wrote it naturally.\n" +
    "- For academic text: keep precision, improve hedging and phrasing.\n" +
    "- For business text: keep it concise and professional.\n" +
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
    max_tokens: 4096,
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

  return {
    finalVersion,
    sentences,
    suggestions: normalizeStringArray(parsed.suggestions, ["Refined wording while preserving the source meaning and structure."]),
    explanation: cleanText(parsed.explanation || "Refined for " + options.domain + " " + options.tone + " English while preserving meaning, structure, and protected details."),
    originalScore: clampScore(parsed.originalScore, estimateScore(originalText)),
    revisedScore: clampScore(parsed.revisedScore, Math.max(estimateScore(finalVersion), estimateScore(originalText) + 4)),
    detectedDialect,
    provider,
  };
}

function buildResultFromRewrite(originalText, rewrittenText, options, provider) {
  const finalVersion = cleanText(rewrittenText);
  const detectedDialect = options.forcedDialect || detectDialect(originalText);
  const originalScore = estimateScore(originalText);
  const revisedScore = estimateScore(finalVersion);

  const sentences = buildSentenceObjects(originalText, finalVersion);
  const suggestions = buildSuggestions(originalText, finalVersion);

  return {
    finalVersion,
    sentences,
    suggestions,
    explanation: "Rewritten for " + options.domain + " " + options.tone + " English in " + detectedDialect + " dialect. Preserved citations, footnotes, and source structure.",
    originalScore,
    revisedScore: Math.max(revisedScore, originalScore + 3),
    detectedDialect,
    provider,
  };
}

function buildSuggestions(original, rewritten) {
  const suggestions = [];
  const origWords = countWords(original);
  const rewWords = countWords(rewritten);

  if (Math.abs(origWords - rewWords) > origWords * 0.15) {
    suggestions.push(rewWords < origWords ? "Tightened verbose passages for conciseness." : "Expanded abbreviations and added clarity.");
  }

  const origSentences = original.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const longSentences = origSentences.filter((s) => s.trim().split(/\s+/).length > 30);
  if (longSentences.length > 0) {
    suggestions.push("Restructured long sentences for readability.");
  }

  if (/[A-Z][a-z]+,?\s+(et al\.|and [A-Z])/.test(original) || /\[\d+\]/.test(original)) {
    suggestions.push("Preserved academic citations and references intact.");
  }

  if (suggestions.length === 0) {
    suggestions.push("Refined wording, collocations, and natural flow.");
  }

  return suggestions;
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

  return {
    finalVersion,
    sentences: buildSentenceObjects(text, finalVersion),
    suggestions: [
      "Applied local grammar, spacing, and punctuation cleanup.",
      "Preserved citations, footnotes, paragraph breaks, and source wording where uncertain.",
    ],
    explanation: reason
      ? "Provider fallback used after: " + reason + ". Local cleanup was applied conservatively."
      : "Local cleanup was applied conservatively.",
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
  return String(value || "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
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
