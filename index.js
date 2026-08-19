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
  const prompt = buildPrompt(text, options);
  const providerErrors = [];

  if (env?.GEMINI_API_KEY) {
    try {
      const raw = await callGemini(prompt, env.GEMINI_API_KEY);
      return normalizeProviderResult(raw, text, options, "gemini");
    } catch (error) {
      providerErrors.push(`Gemini: ${error.message || error}`);
    }
  }

  if (env?.AI) {
    try {
      const raw = await callCloudflareAI(prompt, env.AI);
      return normalizeProviderResult(raw, text, options, "cloudflare");
    } catch (error) {
      providerErrors.push(`Cloudflare AI: ${error.message || error}`);
    }
  }

  return buildDeterministicResult(text, options, providerErrors.join(" | "));
}

async function callGemini(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
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
    throw new Error(`Gemini returned ${response.status}: ${message.slice(0, 240)}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
}

async function callCloudflareAI(prompt, ai) {
  const response = await ai.run("@cf/openai/gpt-oss-20b", {
    messages: [
      {
        role: "system",
        content: "You are IdiomOptima, an expert English editor. Return strict JSON only.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 2200,
  });

  if (typeof response === "string") return response;
  return response?.response
    || response?.result?.response
    || response?.choices?.[0]?.message?.content
    || response?.output_text
    || JSON.stringify(response);
}

function buildPrompt(text, options) {
  return `Rewrite the source text so it sounds natural, fluent, and native in ${options.forcedDialect || "the most likely"} English.

Domain: ${options.domain}
Tone: ${options.tone}
Mode: ${options.mode}

Rules:
- Preserve meaning, claims, citations, footnote markers, numbers, names, and paragraph boundaries.
- Do not invent facts, citations, quotations, sources, or references.
- Improve grammar, idiom, collocation, clarity, and native flow.
- Keep academic writing appropriately precise and not inflated.
- Keep business writing concise and professional.
- Keep creative writing expressive but faithful to the original.
- Treat footnote or reference definitions as immutable unless only tiny grammar cleanup is needed.
- Return only valid JSON. No Markdown fences.

The JSON shape must be:
{
  "finalVersion": "full transformed text",
  "sentences": [
    {
      "original": "source sentence or heading",
      "native": "transformed sentence or heading",
      "isNativeMatch": false,
      "isEndOfParagraph": true,
      "isHeading": false,
      "isImmutableFootnote": false
    }
  ],
  "suggestions": ["short improvement summary"],
  "explanation": "short stylistic note",
  "originalScore": 80,
  "revisedScore": 94,
  "detectedDialect": "US"
}

Source text:
${text}`;
}

function normalizeProviderResult(rawText, originalText, options, provider) {
  const parsed = parseJsonFromModel(rawText);
  const finalVersion = cleanText(parsed.finalVersion || parsed.final || parsed.text || originalText);
  const detectedDialect = safeDialect(parsed.detectedDialect) || options.forcedDialect || detectDialect(originalText);
  const sentences = Array.isArray(parsed.sentences) && parsed.sentences.length > 0
    ? parsed.sentences.map((sentence, index) => normalizeSentence(sentence, index))
    : buildSentenceObjects(originalText, finalVersion);

  return {
    finalVersion,
    sentences,
    suggestions: normalizeStringArray(parsed.suggestions, ["Refined wording while preserving the source meaning and structure."]),
    explanation: cleanText(parsed.explanation || `Refined for ${options.domain} ${options.tone} English while preserving meaning, structure, and protected details.`),
    originalScore: clampScore(parsed.originalScore, estimateScore(originalText)),
    revisedScore: clampScore(parsed.revisedScore, Math.max(estimateScore(finalVersion), estimateScore(originalText) + 4)),
    detectedDialect,
    provider,
  };
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
  const text = String(rawText || "").trim()
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

function buildDeterministicResult(text, options, reason = "") {
  const finalVersion = deterministicPolish(text);
  const originalScore = estimateScore(text);
  const revisedScore = Math.max(originalScore, estimateScore(finalVersion));

  return {
    finalVersion,
    sentences: buildSentenceObjects(text, finalVersion),
    suggestions: [
      "Applied local grammar, spacing, and punctuation cleanup.",
      "Preserved citations, footnotes, paragraph breaks, and source wording where uncertain.",
    ],
    explanation: reason
      ? `Provider fallback used after: ${reason}. Local cleanup was applied conservatively.`
      : "Local cleanup was applied conservatively.",
    originalScore,
    revisedScore,
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
    [/\bat this point in time\b/gi, "at this point"],
    [/\bmake a research\b/gi, "conduct research"],
    [/\bdo a decision\b/gi, "make a decision"],
    [/\bI go\b/g, "I went"],
    [/\bbuy some\b/gi, "bought some"],
    [/\bI forget\b/g, "I forgot"],
  ];

  let result = text.replace(/\r\n/g, "\n");
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }

  return result
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?])\s+([a-z])/g, (_match, punct, letter) => `${punct} ${letter.toUpperCase()}`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildSentenceObjects(originalText, finalText) {
  const originals = splitForDisplay(originalText);
  const natives = splitForDisplay(finalText);
  const max = Math.max(originals.length, natives.length);
  const sentences = [];

  for (let i = 0; i < max; i += 1) {
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
    /\bdemonstrates that there is\b/,
    /\bdiscuss about\b/,
    /\bin order to\b/,
    /\bdue to the fact that\b/,
    /\bat this point in time\b/,
    /\bi go\b/,
    /\bi forget\b/,
    /\s{2,}/,
  ];

  const issues = issuePatterns.reduce((count, pattern) => count + (pattern.test(lower) ? 1 : 0), 0);
  return Math.max(55, Math.min(97, 92 - issues * 5));
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
  return String(value || "").replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n").trim();
}

function comparable(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, " ");
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}
