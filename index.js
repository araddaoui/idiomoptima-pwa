const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cache-Control, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ─── Clerk JWT verification ───────────────────────────────────────────
let cachedJWKS = null;
let jwksExpiry = 0;

async function fetchJWKS(clerkDomain) {
  const now = Date.now();
  if (cachedJWKS && now < jwksExpiry) return cachedJWKS;
  const resp = await fetch("https://" + clerkDomain + "/.well-known/jwks.json");
  if (!resp.ok) throw new Error("Failed to fetch JWKS");
  const data = await resp.json();
  cachedJWKS = data;
  jwksExpiry = now + 3600000;
  return data;
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

async function verifyClerkToken(token, clerkDomain) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const jwks = await fetchJWKS(clerkDomain);
  const header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerB64)));
  const key = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!key) return null;

  const cryptoKey = await crypto.subtle.importKey(
    "jwk", key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["verify"]
  );
  const data = new TextEncoder().encode(headerB64 + "." + payloadB64);
  const sig = base64urlDecode(signatureB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sig, data);
  if (!valid) return null;

  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function getUserIdFromRequest(request, clerkDomain) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || !clerkDomain) return null;
  return verifyClerkToken(token, clerkDomain).then((p) => p?.sub || null).catch(() => null);
}

// ─── Supabase helpers ─────────────────────────────────────────────────
async function supabaseQuery(supabaseUrl, supabaseKey, table, params) {
  const url = supabaseUrl + "/rest/v1/" + table + "?" + params;
  const resp = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: "Bearer " + supabaseKey,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function supabaseRpc(supabaseUrl, supabaseKey, fn, body) {
  const resp = await fetch(supabaseUrl + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: "Bearer " + supabaseKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function getUserTier(supabaseUrl, supabaseKey, clerkId) {
  const rows = await supabaseQuery(
    supabaseUrl, supabaseKey, "users",
    "select=subscription_tier&clerk_id=eq." + encodeURIComponent(clerkId) + "&limit=1"
  );
  return rows && rows[0] ? rows[0].subscription_tier : "free";
}

async function getDailyUsage(supabaseUrl, supabaseKey, clerkId) {
  const today = new Date().toISOString().split("T")[0];
  const rows = await supabaseQuery(
    supabaseUrl, supabaseKey, "usage",
    "select=request_count&user_id=eq." + encodeURIComponent(clerkId) + "&date=eq." + today + "&limit=1"
  );
  return rows && rows[0] ? rows[0].request_count : 0;
}

async function incrementUsage(supabaseUrl, supabaseKey, clerkId) {
  const today = new Date().toISOString().split("T")[0];
  await supabaseRpc(supabaseUrl, supabaseKey, "increment_usage", {
    p_user_id: clerkId,
    p_date: today,
  });
}

async function upsertUser(supabaseUrl, supabaseKey, clerkId, email) {
  await supabaseQuery(supabaseUrl, supabaseKey, "users", "clerk_id=eq." + encodeURIComponent(clerkId));
  await fetch(supabaseUrl + "/rest/v1/users", {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: "Bearer " + supabaseKey,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ clerk_id: clerkId, email: email || "" }),
  });
}

// ─── Stripe helpers ───────────────────────────────────────────────────
async function createStripeCheckout(stripeKey, priceId, clerkId, email, supabaseUrl, supabaseKey) {
  const origin = "https://idiomoptima.com";
  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + stripeKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "mode": "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: origin + "/app?upgraded=1",
      cancel_url: origin + "/app?upgrade_cancelled=1",
      "metadata[clerk_id]": clerkId,
      "metadata[email]": email || "",
      customer_email: email || "",
    }).toString(),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("Stripe error: " + err.substring(0, 200));
  }
  return resp.json();
}

async function handleStripeWebhook(request, env) {
  const sig = request.headers.get("Stripe-Signature");
  const body = await request.text();

  let event;
  try {
    const payloadToVerify = new TextEncoder().encode(body);
    const parts = (sig || "").split(",").reduce((acc, part) => {
      const [k, v] = part.split("=");
      acc[k.trim()] = v;
      return acc;
    }, {});

    const signedPayload = new TextEncoder().encode(parts.t || "" + "." + body);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const expectedSig = await crypto.subtle.sign("HMAC", key, signedPayload);
    const expectedHex = [...new Uint8Array(expectedSig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (expectedHex !== parts.v1) {
      return jsonResponse({ error: "Invalid signature" }, 401);
    }
  } catch (e) {
    return jsonResponse({ error: "Signature verification failed" }, 401);
  }

  try {
    event = JSON.parse(body);
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const clerkId = session.metadata && session.metadata.clerk_id;
    const stripeCustomerId = session.customer;
    const stripeSubscriptionId = session.subscription;
    if (clerkId && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
      await fetch(env.SUPABASE_URL + "/rest/v1/users?clerk_id=eq." + encodeURIComponent(clerkId), {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subscription_tier: "pro",
          stripe_customer_id: stripeCustomerId,
          stripe_subscription_id: stripeSubscriptionId,
        }),
      });
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
      await fetch(env.SUPABASE_URL + "/rest/v1/users?stripe_subscription_id=eq." + encodeURIComponent(sub.id), {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ subscription_tier: "free" }),
      });
    }
  }

  return jsonResponse({ received: true });
}

// ─── Main fetch handler ──────────────────────────────────────────────
const SYSTEM_PROMPT = [
  "You are IdiomOptima, a voice-preserving linguistic stabilizer.",
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
  "AI-ESE DETECTION AND REMOVAL (CRITICAL):",
  "Scan the text for unnatural, formulaic, or AI-generated phrasing patterns and replace them with natural alternatives.",
  "Common AI-ese patterns to detect and fix:",
  "- 'It is important to note that' -> delete or rephrase",
  "- 'In today's fast-paced world' -> delete or rephrase",
  "- 'Furthermore', 'Moreover', 'Additionally' used excessively -> vary or reduce",
  "- 'A comprehensive understanding of' -> simplify",
  "- 'It goes without saying that' -> delete or rephrase",
  "- 'The purpose of this [paper/text] is to' -> rephrase naturally",
  "- 'In conclusion, it can be said that' -> state the conclusion directly",
  "- Unnecessary hedging: 'It appears that', 'It seems as though' -> be direct",
  "- Redundant intensifiers: 'very big', 'extremely crucial' -> use precise words",
  "- Filler phrases: 'basically', 'essentially', 'literally' (when not literal) -> delete",
  "If you detect AI-ese, list each instance in the suggestions array with what was removed and why.",
  "",
  "EXPLANATION RULES (CRITICAL):",
  "For each sentence, the explanation field MUST:",
  "- State SPECIFICALLY what was changed (e.g. 'Subject-verb agreement fixed: they was -> they were').",
  "- Explain WHY the revision is linguistically superior (e.g. 'Standard English requires plural verb agreement with plural subject').",
  "- If the sentence was unchanged, explain why (e.g. 'No grammatical errors detected; voice preserved as-is').",
  "- Never use vague phrases like 'Grammar corrected' or 'Voice preserved'. Be precise.",
  "- Reference the specific rule broken (e.g. 'dangling modifier', 'comma splice', 'misspelling', 'wrong homophone').",
  "",
  "TOP-LEVEL EXPLANATION RULES:",
  "The top-level 'explanation' field MUST summarize the main categories of changes made across all sentences.",
  "Example: 'Fixed 3 spelling errors, 2 subject-verb agreement issues, and 1 comma splice. Removed 2 instances of AI-ese phrasing. All paragraph structure and citations preserved.'",
  "",
  "SUGGESTIONS ARRAY (REQUIRED - CRITICAL):",
  "The top-level 'suggestions' array MUST contain categorized diagnostic notes about what was improved.",
  "Each suggestion should be a concise, specific statement like:",
  "- 'Grammar: Fixed subject-verb agreement in 3 sentences (e.g., \"they was\" -> \"they were\")'",
  "- 'Spelling: Corrected 2 misspellings (e.g., \"recieve\" -> \"receive\")'",
  "- 'AI-ese Removed: Eliminated \"It is important to note that\" filler phrase'",
  "- 'Punctuation: Added missing Oxford comma in compound list'",
  "- 'Dialect: Applied US conventions (e.g., \"colour\" -> \"color\")'",
  "- 'Clarity: Simplified run-on sentence into two clear statements'",
  "- 'Voice Preserved: Author's informal tone and personal perspective maintained throughout'",
  "NEVER return an empty suggestions array. Always populate it with at least the categories above.",
  "Aim for 4-8 diagnostic notes covering grammar, spelling, punctuation, AI-ese, dialect, clarity, and voice preservation.",
  "",
  "SCORING RULES (CRITICAL):",
  "The scores represent the QUALITY of the text, not a comparison.",
  "",
  "originalScore: Rate the ORIGINAL text's grammatical correctness, fluency, and native-level expression on 0-100.",
  "  - 90-100: Near-perfect native English, no issues",
  "  - 80-89: Minor issues, mostly fluent",
  "  - 70-79: Some noticeable errors but readable",
  "  - 50-69: Frequent errors that affect clarity",
  "  - 30-49: Many errors, reads awkwardly",
  "  - 0-29: Severely broken English",
  "",
  "revisedScore: Rate the REVISED text's quality AFTER all corrections are applied.",
  "  This is the quality score of the OUTPUT, not a delta from the original.",
  "  If you have successfully fixed grammar, removed AI-ese, applied dialect, and preserved voice,",
  "  the revised text IS high-quality native English. Score it accordingly.",
  "  - 92-98: After corrections, text reads as polished native English with voice intact",
  "  - 85-91: After corrections, text is fluent with minor remaining rough edges",
  "  - 75-84: Some issues remain that you could not fix without altering voice",
  "",
  "  RULES FOR revisedScore:",
  "  - If the original was 50 and you fixed 5 errors + removed AI-ese, revised should be 90-95.",
  "  - If the original was 70 and you fixed 2 minor issues, revised should be 88-93.",
  "  - If the original was 90 and you made 1 tiny fix, revised should be 93-97.",
  "  - The revised score MUST be higher than original if any improvements were made.",
  "  - After IdiomOptima processing, most texts SHOULD score 88-96 because the engine corrects problems.",
  "",
  "OUTPUT: Return ONLY valid JSON, no markdown fences.",
  '{"originalScore": (0-100), "revisedScore": (0-100), "finalVersion": "Full text",',
  '"sentences": [{"original": "...", "revised": "...", "explanation": "Specific change and why it is superior", "isImmutableFootnote": false}],',
  '"suggestions": ["Grammar: ...", "Spelling: ...", "AI-ese: ...", ...], "explanation": "Summary of all changes", "detectedDialect": "US|UK|CA|AU"}',
].join("\n");

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

  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
  var response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
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

async function callOpenRouter(text, options, apiKey) {
  var dialect = options.forcedDialect || "the most likely";
  var prompt = "Domain: " + options.domain + "\nTone: " + options.tone + "\nMode: " + options.mode + "\nDialect: " + dialect + "\n\nRewrite the following text with minimal intervention. Preserve voice, headings, citations, paragraph structure. Return ONLY valid JSON.\n\nText:\n" + text;

  var response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: "nvidia/nemotron-3-nano-30b-a3b:free",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.25,
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    var err = await response.text();
    throw new Error("OpenRouter error: " + err.substring(0, 200));
  }

  var data = await response.json();
  return String((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "");
}

async function callDeepSeek(text, options, apiKey) {
  var dialect = options.forcedDialect || "the most likely";
  var prompt = "Domain: " + options.domain + "\nTone: " + options.tone + "\nMode: " + options.mode + "\nDialect: " + dialect + "\n\nRewrite the following text with minimal intervention. Preserve voice, headings, citations, paragraph structure. Return ONLY valid JSON.\n\nText:\n" + text;

  var response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.25,
      max_tokens: 16384,
    }),
  });

  if (!response.ok) {
    var err = await response.text();
    throw new Error("DeepSeek error: " + err.substring(0, 200));
  }

  var data = await response.json();
  return String((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "");
}

async function callCloudflareAI(text, options, ai) {
  var dialect = options.forcedDialect || "US";
  var prompt =
    "You are IdiomOptima, a voice-preserving editor.\n" +
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
      { role: "system", content: "You are IdiomOptima. Return only valid JSON." },
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

    var url = new URL(request.url);
    var path = url.pathname;

    // ── Health ──────────────────────────────────────────────────────
    if (request.method === "GET" && path === "/health") {
      return jsonResponse({ status: "ok", timestamp: Date.now() });
    }

    // ── Stripe webhook ─────────────────────────────────────────────
    if (request.method === "POST" && path === "/stripe-webhook") {
      return handleStripeWebhook(request, env);
    }

    // ── Create Stripe Checkout session ─────────────────────────────
    if (request.method === "POST" && path === "/create-checkout") {
      try {
        var body = await request.json();
        var clerkId = body.clerk_id;
        var email = body.email;
        if (!clerkId || !env.STRIPE_SECRET_KEY) {
          return jsonResponse({ error: "Missing clerk_id or Stripe key" }, 400);
        }
        var checkout = await createStripeCheckout(
          env.STRIPE_SECRET_KEY,
          env.STRIPE_PRICE_ID || "price_placeholder",
          clerkId,
          email,
          env.SUPABASE_URL,
          env.SUPABASE_SERVICE_KEY
        );
        return jsonResponse({ url: checkout.url });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── Get user tier + usage ──────────────────────────────────────
    if (request.method === "GET" && path === "/user-tier") {
      var clerkDomain = env.CLERK_DOMAIN || "";
      var userId = await getUserIdFromRequest(request, clerkDomain);
      if (!userId) return jsonResponse({ tier: "free", usage: 0, limit: 50 });

      var tier = "free";
      var usage = 0;
      if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
        tier = await getUserTier(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, userId);
        usage = await getDailyUsage(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, userId);
      }
      var limit = tier === "pro" || tier === "enterprise" ? 9999 : 50;
      return jsonResponse({ tier: tier, usage: usage, limit: limit });
    }

    // ── Main transformation (POST) ─────────────────────────────────
    if (request.method !== "POST" || path !== "/") {
      return jsonResponse({ error: "Not found" }, 404);
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

      // ── Auth + tier check ────────────────────────────────────────
      var clerkDomain = env.CLERK_DOMAIN || "";
      var userId = await getUserIdFromRequest(request, clerkDomain);
      var tier = "free";
      var usage = 0;

      if (userId && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
        tier = await getUserTier(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, userId);
        usage = await getDailyUsage(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, userId);

        var limit = tier === "pro" || tier === "enterprise" ? 9999 : 50;
        if (usage >= limit) {
          return jsonResponse({
            error: "Daily limit reached (" + limit + " requests). " +
              (tier === "free" ? "Upgrade to Pro for unlimited." : "Try again tomorrow."),
            limitReached: true,
            tier: tier,
            usage: usage,
            limit: limit,
          }, 429);
        }
      }

      // ── Provider routing based on tier ───────────────────────────
      var parsed = null;
      var provider = "none";

      if (tier === "pro" || tier === "enterprise") {
        // Pro: Gemini first (best quality + long docs)
        if (env.GEMINI_API_KEY) {
          try {
            var raw = await callGemini(text, options, env.GEMINI_API_KEY);
            parsed = parseJsonFromModel(raw);
            provider = "gemini";
          } catch (e) { console.error("Gemini failed:", e.message); }
        }
        if (!parsed && env.OPENROUTER_API_KEY) {
          try {
            var raw3 = await callOpenRouter(text, options, env.OPENROUTER_API_KEY);
            parsed = parseJsonFromModel(raw3);
            provider = "openrouter";
          } catch (e) { console.error("OpenRouter failed:", e.message); }
        }
      } else {
        // Free: OpenRouter first (cheapest), then Cloudflare fallback
        if (env.OPENROUTER_API_KEY) {
          try {
            var raw3 = await callOpenRouter(text, options, env.OPENROUTER_API_KEY);
            parsed = parseJsonFromModel(raw3);
            provider = "openrouter";
          } catch (e) { console.error("OpenRouter failed:", e.message); }
        }
        if (!parsed && env.AI) {
          try {
            var raw4 = await callCloudflareAI(text, options, env.AI);
            parsed = parseJsonFromModel(raw4);
            provider = "cloudflare";
          } catch (e) { console.error("Cloudflare AI failed:", e.message); }
        }
        // Fallback: try Gemini even for free if OpenRouter/CF failed
        if (!parsed && env.GEMINI_API_KEY) {
          try {
            var raw = await callGemini(text, options, env.GEMINI_API_KEY);
            parsed = parseJsonFromModel(raw);
            provider = "gemini";
          } catch (e) { console.error("Gemini fallback failed:", e.message); }
        }
      }

      if (!parsed) {
        return jsonResponse({ error: "All providers failed. Please retry." }, 502);
      }

      var result = ensureValidResult(parsed, text, options);
      if (!result) {
        return jsonResponse({ error: "Invalid response from AI model" }, 502);
      }

      // ── Increment usage ──────────────────────────────────────────
      if (userId && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
        await incrementUsage(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, userId);
        usage += 1;
      }

      result.provider = provider;
      result.tier = tier;
      result.usage = usage;
      return jsonResponse(result);

    } catch (error) {
      console.error("Worker error:", error);
      return jsonResponse({ error: String(error.message || error || "Unknown error") }, 500);
    }
  },
};
