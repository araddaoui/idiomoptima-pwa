const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cache-Control",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SYSTEM_PROMPT = [
  "You are NativeWrite, a voice-preserving linguistic stabilizer.",
  "Transform input text with minimal intervention while preserving author voice.",
  "",
  "EDITING PRINCIPLES (STRICT HIERARCHY):",
  "1. Voice Preservation (HIGHEST PRIORITY): Do NOT overwrite author voice.",
  "   Preserve hesitation, ambiguity, repetition, and rhythm when meaningful.",
  "   Do NOT standardize stylistic variation.",
  "   Do NOT convert fragments into full sentences unless grammatically required.",
  "2. Minimal Intervention Rule: Only modify grammar, punctuation, spelling, and clear syntactic confusion.",
  "   Do NOT rewrite for elegance, restructure paragraphs, normalize tone, or improve style beyond correction.",
  "3. Domain-Sensitive Editing:",
  "   - Academic: Preserve conceptual density, citations, epistemic caution. Do not simplify arguments.",
  "   - Business: Preserve operational ambiguity and hedging language.",
  "   - Creative: Preserve fragmentation, repetition, emotional ambiguity.",
  "   - General: Balanced minimal correction only.",
  "4. Structural Integrity: Preserve headings, numbering, paragraph structure, emphasis, citations exactly.",
  "5. Tone and Dialect: Adjust tone only at sentence-level softness or formality.",
  "   Dialect adjustment at surface-level spelling and lexical conventions only.",
  "6. NEVER use em dashes (—). Use commas, semicolons, or periods instead.",
  "",
  "OUTPUT: Return ONLY valid JSON, no markdown fences.",
  '{"originalScore": (0-100), "revisedScore": (0-100), "finalVersion": "Full text",',
  '"sentences": [{"original": "...", "revised": "...", "suggestions": [], "explanation": "Brief note", "isImmutableFootnote": false}],',
  '"suggestions": [], "explanation": "Diagnostic note", "detectedDialect": "US|UK|CA|AU"}',
].join("\n");

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

function parseJsonFromModel(text) {
  var cleaned = String(text || "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  var match = cleaned.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch (e) {} }
  return null;
}

function detectDialect(text) {
  var lower = (text || "").toLowerCase();
  if (/\bcolour\b|\borganise\b|\brecognise\b|\banalysed\b|\bdefence\b/.test(lower)) return "UK";
  if (/\bcanada\b|\bcanadian\b/.test(lower)) return "CA";
  if (/\baustralia\b|\baustralian\b/.test(lower)) return "AU";
  return "US";
}

async function callGemini(text, options, apiKey) {
  var dialect = options.forcedDialect || "the most likely";
  var prompt = "Domain: " + options.domain + "\nTone: " + options.tone + "\nMode: " + options.mode + "\nDialect: " + dialect + "\n\nRewrite the following text with minimal intervention. Preserve voice, headings, citations, paragraph structure. Return ONLY valid JSON.\n\nText:\n" + text;

  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey;
  var response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }] }],
      generationConfig: { temperature: 0.25, topP: 0.9, responseMimeType: "application/json" },
    }),
  });

  if (!response.ok) {
    var err = await response.text();
    throw new Error("Gemini API error: " + err.substring(0, 200));
  }

  var data = await response.json();
  var raw = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  return String(raw || "");
}

async function callCloudflareAI(text, options, ai) {
  var dialect = options.forcedDialect || "US";
  var prompt =
    "You are NativeWrite, a voice-preserving editor.\n" +
    "Rewrite the text so it sounds natural and native in " + dialect + " English.\n" +
    "Domain: " + options.domain + "\nTone: " + options.tone + "\n\n" +
    "RULES:\n" +
    "- Preserve citations, footnote markers, numbers, names, paragraph boundaries exactly.\n" +
    "- Do NOT change formality level. Keep contractions as-is from original.\n" +
    "- Do NOT swap correct words for synonyms.\n" +
    "- Do NOT change meaning.\n" +
    "- Do NOT invent facts, citations, or references.\n" +
    "- Improve grammar, idiom, collocation, clarity, and native flow.\n" +
    "- Return ONLY valid JSON. No markdown fences.\n\n" +
    "JSON shape: {\"originalScore\":0-100,\"revisedScore\":0-100,\"finalVersion\":\"full text\",\"sentences\":[{\"original\":\"...\",\"revised\":\"...\",\"suggestions\":[],\"explanation\":\"note\",\"isImmutableFootnote\":false}],\"suggestions\":[],\"explanation\":\"note\",\"detectedDialect\":\"US|UK|CA|AU\"}\n\n" +
    "Text to rewrite:\n" + text;

  var response = await ai.run("@cf/openai/gpt-oss-20b", {
    messages: [
      { role: "system", content: "You are NativeWrite. Return only valid JSON." },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 8192,
  });

  var result;
  if (typeof response === "string") {
    result = response;
  } else {
    result = response && (response.response || (response.result && response.result.response) || (response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content) || JSON.stringify(response));
  }
  return String(result || "");
}

function safeScore(val, fallback) {
  var n = parseInt(val, 10);
  if (isNaN(n) || n < 0 || n > 100) return fallback;
  return n;
}

function ensureValidResult(parsed, originalText, options) {
  if (!parsed || typeof parsed !== "object") return null;

  var finalVersion = parsed.finalVersion || parsed.final || parsed.text || "";
  if (!finalVersion || finalVersion.length < 10) return null;

  var sentences = Array.isArray(parsed.sentences) ? parsed.sentences : [];
  if (sentences.length === 0) {
    var parts = finalVersion.split(/(?<=[.!?])\s+/);
    sentences = parts.map(function(s) { return { original: s, revised: s, suggestions: [], explanation: "", isImmutableFootnote: false }; });
  }

  // Capitalize first letter after sentence-ending punctuation
  function capitalizeAfterPunctuation(str) {
    return str.replace(/([.!?]\s+|^)([a-z])/gm, function(match, pre, letter) {
      return pre + letter.toUpperCase();
    });
  }

  sentences = sentences.map(function(s) {
    return {
      original: String(s.original || s.source || ""),
      revised: capitalizeAfterPunctuation(String(s.revised || s.native || s.final || s.original || s.source || "")),
      suggestions: Array.isArray(s.suggestions) ? s.suggestions : [],
      explanation: String(s.explanation || ""),
      isImmutableFootnote: Boolean(s.isImmutableFootnote),
    };
  });

  var dialect = parsed.detectedDialect || detectDialect(originalText);

  return {
    originalScore: safeScore(parsed.originalScore, Math.min(97, 70 + Math.floor(Math.random() * 15))),
    revisedScore: safeScore(parsed.revisedScore, Math.min(97, 75 + Math.floor(Math.random() * 15))),
    finalVersion: capitalizeAfterPunctuation(finalVersion),
    sentences: sentences,
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    explanation: String(parsed.explanation || "Text refined with minimal intervention."),
    detectedDialect: dialect,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return jsonResponse({ status: "ok", timestamp: Date.now() });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    try {
      var payload = await request.json();
      var text = String(payload.text || "").trim();
      var options = {
        domain: String(payload.domain || "general"),
        tone: String(payload.tone || "neutral"),
        forcedDialect: String(payload.forcedDialect || ""),
        mode: String(payload.mode || "hybrid"),
      };

      if (!text) {
        return jsonResponse({ error: "No text provided" }, 400);
      }

      var parsed = null;
      var provider = "none";

      if (env.GEMINI_API_KEY) {
        try {
          var raw = await callGemini(text, options, env.GEMINI_API_KEY);
          parsed = parseJsonFromModel(raw);
          provider = "gemini";
        } catch (e) {
          console.error("Gemini failed:", e.message);
        }
      }

      if (!parsed && env.AI) {
        try {
          var raw2 = await callCloudflareAI(text, options, env.AI);
          parsed = parseJsonFromModel(raw2);
          provider = "cloudflare";
        } catch (e) {
          console.error("Cloudflare AI failed:", e.message);
        }
      }

      if (!parsed) {
        return jsonResponse({ error: "All providers failed. Please retry." }, 502);
      }

      var result = ensureValidResult(parsed, text, options);
      if (!result) {
        return jsonResponse({ error: "Invalid response from AI model" }, 502);
      }

      result.provider = provider;
      return jsonResponse(result);

    } catch (error) {
      console.error("Worker error:", error);
      return jsonResponse({ error: String(error.message || error || "Unknown error") }, 500);
    }
  },
};
