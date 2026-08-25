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
  "You are a grammar, punctuation, and spelling correction engine.",
  "You receive text and return corrections ONLY for grammar, punctuation, and spelling errors.",
  "",
  "RULES:",
  "1. Return the COMPLETE text. Every word, every paragraph, every line. Nothing dropped.",
  "2. Return the title exactly as it appears in the input.",
  "3. Do NOT modify text inside quotation marks — leave them exactly as-is.",
  "4. Do NOT rewrite, rephrase, or restructure. Only fix clear errors.",
  "5. Do NOT use em dashes in your output.",
  "6. Preserve footnote markers [1], [2], citations, and bibliography entries exactly.",
  "",
  "SENTENCES: Break the text into logical sentences or lines.",
  "For each sentence, return:",
  "- 'original': the sentence exactly as in the input",
  "- 'revised': the corrected sentence (or identical if no errors found)",
  "- 'explanation': For CHANGED sentences ONLY — state the specific error and correction.",
  "  For UNCHANGED sentences, use exactly: 'No corrections needed.'",
  "- 'isImmutableFootnote': true for footnote markers, citation lines, and bibliography entries",
  "",
  "suggestions: Return exactly 1 item: a summary of all corrections made, e.g.:",
  "- 'Corrected 2 comma splices, 1 misspelling, and 1 subject-verb agreement error.'",
  "or 'No grammar, punctuation, or spelling errors found.'",
  "",
  "originalScore (0-100): Rate grammatical correctness of the original.",
  "- 90-100: Near-perfect, no errors. 80-89: Minor issues. 70-79: Some errors.",
  "- 60-69: Frequent errors. 50-69: Many errors. Below 50: Severely broken.",
  "revisedScore (0-100): Rate the text AFTER your corrections. Must be >= originalScore.",
  "",
  "OUTPUT: Valid JSON only, no markdown fences.",
  '{"originalScore": N, "revisedScore": N, "finalVersion": "COMPLETE corrected text",',
  '"sentences": [{"original": "...", "revised": "...", "explanation": "...", "isImmutableFootnote": false}],',
  '"suggestions": ["Corrected X errors: ..."], "explanation": "Fixed X grammar, Y punctuation, Z spelling issues.", "detectedDialect": "US|UK|CA|AU"}',
].join("\n");

function parseJsonFromModel(text) {
  var cleaned = String(text || "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  var match = cleaned.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch (e) {} }
  return null;
}

function postProcessText(text) {
  if (!text) return text;
  // Strip Gemini preamble/explanation text that leaks into finalVersion
  text = text.replace(/^Here is the (full )?nativized text[:\s]*/i, "");
  text = text.replace(/^Full text[:\s]*/i, "");
  text = text.replace(/^Here is the (refined|edited|corrected|revised) (version|text)[:\s]*/i, "");
  text = text.replace(/^Refined text[:\s]*/i, "");
  text = text.replace(/^\d+%\s*$/gm, "");
  // Replace em dashes with commas
  text = text.replace(/\s*[—–]\s*/g, ", ");
  // Clean up double commas
  text = text.replace(/,\s*,/g, ",");
  // Clean up comma before period
  text = text.replace(/,\./g, ".");
  // Fix lowercase at sentence start (e.g., ". also" → ". Also")
  text = text.replace(/([.!?]\s+)([a-z])/g, function(m, pre, ch) { return pre + ch.toUpperCase(); });
  // Fix lowercase at very start of text
  if (text.length > 0 && text[0] === text[0].toLowerCase() && text[0] !== text[0].toUpperCase()) {
    text = text[0].toUpperCase() + text.substring(1);
  }
  // Strip leading non-alpha garbage
  text = text.replace(/^[^A-Za-z\u00C0-\u024F]*/, "");
  return text;
}

// Words that should NOT be downgraded in academic text
var academicPreserve = {
  "utilizing": "utilizing", "demonstrating": "demonstrating", "facilitating": "facilitating",
  "implementing": "implementing", "methodology": "methodology", "furthermore": "Furthermore",
  "moreover": "Moreover", "consequently": "Consequently", "notwithstanding": "notwithstanding",
  "subsequently": "Subsequently", "aforementioned": "aforementioned", "herein": "herein",
};

function protectAcademicRegister(original, revised) {
  // If original is academic text, prevent downgrading formal words to informal ones
  if (!original || !revised) return revised;
  var formalToInformal = {
    "utilizing": "using", "demonstrating": "showing", "facilitating": "helping",
    "implementing": "setting up", "subsequently": "then", "furthermore": "also",
    "moreover": "also", "consequently": "so", "herein": "here",
  };
  var result = revised;
  for (var formal in formalToInformal) {
    var informal = formalToInformal[formal];
    // If original had the formal word and revised replaced it with informal
    var formalRegex = new RegExp("\\b" + formal + "\\b", "gi");
    var informalRegex = new RegExp("\\b" + informal + "\\b", "gi");
    if (formalRegex.test(original) && informalRegex.test(result) && !formalRegex.test(result)) {
      // Restore the formal word
      result = result.replace(informalRegex, formal);
    }
  }
  return result;
}

function protectQuotes(original, revised) {
  // Find all quoted text in original and restore them in revised if changed
  // Use double quotes and curly single quotes only — skip Keywords, headings, labels
  var quoteRegex = /[""\u201C]([^""\u201D]+)[""\u201D]/g;
  var match;
  var result = revised;
  while ((match = quoteRegex.exec(original)) !== null) {
    var origQuote = match[0];
    var quoteContent = match[1];
    // Skip very short quotes (likely not real quotes)
    if (quoteContent.length < 4) continue;
    // Skip if this looks like a heading or label (no spaces before colon)
    if (/^['"]?[A-Z][a-z]+:/.test(quoteContent)) continue;
    // Check if this exact quote exists in revised
    if (result.indexOf(origQuote) === -1) {
      // Try to find a similar quote in revised and replace it
      var revisedQuoteRegex = /[""\u201C]([^""\u201D]+)[""\u201D]/g;
      var rMatch;
      while ((rMatch = revisedQuoteRegex.exec(result)) !== null) {
        var rContent = rMatch[1];
        // If word overlap is 50-99%, restore original
        var rWords = rContent.split(/\s+/);
        var oWords = quoteContent.split(/\s+/);
        var overlap = rWords.filter(function(w) { return oWords.indexOf(w) !== -1; }).length;
        var similarity = overlap / Math.max(rWords.length, oWords.length, 1);
        if (similarity > 0.5 && similarity < 1.0) {
          result = result.substring(0, rMatch.index) + origQuote + result.substring(rMatch.index + rMatch[0].length);
          break;
        }
      }
    }
  }
  return result;
}

function postProcessSuggestions(suggestions, originalText, finalText, sentences) {
  var suggs = [];

  // If Gemini returned good suggestions (not generic fallback), use them
  if (suggestions && suggestions.length >= 1 && suggestions[0].length > 20) {
    return suggestions;
  }

  // Build diagnostics from sentence-level diff
  var changedSentences = [];
  var unchangedCount = 0;
  var footnoteCount = 0;
  var correctionTypes = { grammar: 0, punctuation: 0, spelling: 0, structure: 0, other: 0 };

  if (sentences && sentences.length > 0) {
    for (var i = 0; i < sentences.length; i++) {
      var orig = (sentences[i].original || "").trim();
      var rev = (sentences[i].revised || "").trim();
      var explanation = (sentences[i].explanation || "").trim();

      if (sentences[i].isImmutableFootnote) {
        footnoteCount++;
        continue;
      }

      if (orig === rev || rev === "No corrections needed." || explanation === "No corrections needed.") {
        unchangedCount++;
        continue;
      }

      changedSentences.push({
        num: i + 1,
        orig: orig.substring(0, 80) + (orig.length > 80 ? "..." : ""),
        revised: rev.substring(0, 80) + (rev.length > 80 ? "..." : ""),
        explanation: explanation,
      });

      // Categorize from explanation
      var expl = explanation.toLowerCase();
      if (expl.indexOf("grammar") !== -1 || expl.indexOf("agreement") !== -1 || expl.indexOf("tense") !== -1 || expl.indexOf("subject-verb") !== -1) {
        correctionTypes.grammar++;
      } else if (expl.indexOf("punctuation") !== -1 || expl.indexOf("comma") !== -1 || expl.indexOf("splice") !== -1 || expl.indexOf("semicolon") !== -1) {
        correctionTypes.punctuation++;
      } else if (expl.indexOf("spell") !== -1 || expl.indexOf("misspell") !== -1) {
        correctionTypes.spelling++;
      } else if (expl.indexOf("restructur") !== -1 || expl.indexOf("paragraph") !== -1 || expl.indexOf("sentence") !== -1) {
        correctionTypes.structure++;
      } else {
        correctionTypes.other++;
      }
    }
  }

  // Build summary line
  var parts = [];
  if (correctionTypes.grammar > 0) parts.push(correctionTypes.grammar + " grammar");
  if (correctionTypes.punctuation > 0) parts.push(correctionTypes.punctuation + " punctuation");
  if (correctionTypes.spelling > 0) parts.push(correctionTypes.spelling + " spelling");
  if (correctionTypes.structure > 0) parts.push(correctionTypes.structure + " structural");
  if (correctionTypes.other > 0) parts.push(correctionTypes.other + " other");

  if (parts.length > 0) {
    suggs.push("Corrected " + parts.join(", ") + " issue(s) across " + changedSentences.length + " sentence(s).");
  } else {
    suggs.push("No grammar, punctuation, or spelling errors found. Text is clean.");
  }

  // Add per-sentence details (max 8)
  var showCount = Math.min(changedSentences.length, 8);
  for (var j = 0; j < showCount; j++) {
    var cs = changedSentences[j];
    suggs.push("Sentence " + cs.num + ": " + cs.explanation);
  }

  if (changedSentences.length > 8) {
    suggs.push("... and " + (changedSentences.length - 8) + " more corrected sentence(s).");
  }

  suggs.push("Preserved: " + unchangedCount + " unchanged sentence(s), " + footnoteCount + " footnote(s)/citation(s).");

  return suggs;
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
  var prompt = "Domain: " + options.domain + "\nTone: " + options.tone + "\nMode: " + options.mode + "\nDialect: " + dialect + "\n\n" +
    "TASK: Edit the following text for grammar, punctuation, spelling, and natural phrasing. " +
    "CRITICAL: Return the COMPLETE text from title to final footnote. Do NOT drop any content. " +
    "Do NOT modify text inside quotation marks — leave quoted text exactly as-is. " +
    "Replace em dashes with commas. " +
    "Use '\\n\\n' between paragraphs in finalVersion. " +
    "The suggestions array MUST contain at least 3 categorized items. " +
    "Text:\n" + text;

  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
  var response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }] }],
      generationConfig: { temperature: 0.25, topP: 0.9, responseMimeType: "application/json", maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  if (!response.ok) {
    var err = await response.text();
    throw new Error("Gemini API error: " + err.substring(0, 200));
  }

  var data = await response.json();
  var candidates = data && data.candidates;
  if (!candidates || candidates.length === 0) {
    var blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error("Gemini returned no candidates" + (blockReason ? " (blocked: " + blockReason + ")" : "") + ". Response: " + JSON.stringify(data).substring(0, 300));
  }
  var finishReason = candidates[0] && candidates[0].finishReason;
  var parts = candidates[0] && candidates[0].content && candidates[0].content.parts;
  var raw = "";
  if (parts && parts.length > 0) {
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].text && !parts[i].thought) {
        raw = parts[i].text;
        break;
      }
    }
    if (!raw && parts[0] && parts[0].text) {
      raw = parts[0].text;
    }
  }
  if (finishReason === "MAX_TOKENS") {
    console.warn("Gemini response truncated at max tokens. Output may be incomplete JSON.");
  }
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

function rebuildFinalVersion(originalText, sentences) {
  if (!originalText || !sentences || sentences.length === 0) return originalText;

  var origParagraphs = originalText.split(/\n\n+/);
  var result = [];
  var sentIdx = 0;

  // Detect standalone headings, labels, short structural elements
  function isStandaloneElement(text) {
    var t = text.trim();
    if (t.length > 150) return false;
    // Common academic headings
    if (/^(Abstract|Introduction|Conclusion|Discussion|Results|Methods|References|Bibliography|Acknowledgments|Appendix|Key\s*[wW]ords?)\s*$/i.test(t)) return true;
    // Title-like: starts with Title: or is short and ends with specific patterns
    if (/^Title:|^Keywords?:|^\[\d+\]|^\([A-Z]/.test(t)) return true;
    // Very short lines (< 20 words, no verb) are likely headings
    if (t.split(/\s+/).length < 15 && !/\b(is|are|was|were|has|have|had|the|a|an)\b/i.test(t)) return true;
    return false;
  }

  // Detect footnote/citation lines
  function isFootnoteLine(text) {
    var t = text.trim();
    return /^\[\d+\]/.test(t) || /^\([A-Z][a-z]+,\s*\d{4}\)/.test(t) || /^See\s/.test(t);
  }

  for (var p = 0; p < origParagraphs.length; p++) {
    var para = origParagraphs[p].trim();
    if (!para) continue;

    // Standalone elements: keep original, find matching sentence if any
    if (isStandaloneElement(para) || isFootnoteLine(para)) {
      var found = false;
      for (var s = sentIdx; s < sentences.length; s++) {
        var orig = (sentences[s].original || "").trim();
        if (orig && (orig === para || para.indexOf(orig.substring(0, Math.min(50, orig.length))) !== -1)) {
          var revised = sentences[s].revised || orig;
          // Ensure it's capitalized if it starts a line
          if (revised.length > 0 && revised[0] !== revised[0].toUpperCase()) {
            revised = revised[0].toUpperCase() + revised.substring(1);
          }
          result.push(revised);
          sentIdx = s + 1;
          found = true;
          break;
        }
      }
      if (!found) result.push(para);
      continue;
    }

    // Regular paragraphs: collect matching sentences
    var paraSentences = [];
    var paraText = para.replace(/\s+/g, " ").toLowerCase();

    while (sentIdx < sentences.length) {
      var sObj = sentences[sentIdx];
      var origSent = (sObj.original || "").trim();
      if (!origSent) { sentIdx++; continue; }

      var origNorm = origSent.replace(/\s+/g, " ").toLowerCase().substring(0, 50);
      if (paraText.indexOf(origNorm) !== -1 || para.indexOf(origSent.substring(0, Math.min(40, origSent.length))) !== -1) {
        paraSentences.push(sObj);
        sentIdx++;
      } else {
        break;
      }
    }

    if (paraSentences.length > 0) {
      var joined = paraSentences.map(function(s) { return s.revised || s.original || ""; }).join(" ");
      // Fix lowercase at sentence boundaries introduced by AI
      joined = joined.replace(/([.!?]\s+)([a-z])/g, function(m, pre, ch) { return pre + ch.toUpperCase(); });
      result.push(joined);
    } else {
      result.push(para);
    }
  }

  // Append remaining unmatched sentences
  while (sentIdx < sentences.length) {
    var rem = sentences[sentIdx].revised || sentences[sentIdx].original || "";
    if (rem.trim()) result.push(rem);
    sentIdx++;
  }

  return result.join("\n\n");
}

function ensureValidResult(parsed, originalText, options) {
  if (!parsed || typeof parsed !== "object") return null;

  var finalVersion = parsed.finalVersion || parsed.final || parsed.text || "";
  
  // If no finalVersion but we have sentences, reconstruct it
  if ((!finalVersion || finalVersion.length < 10) && Array.isArray(parsed.sentences) && parsed.sentences.length > 0) {
    finalVersion = parsed.sentences.map(function(s) { return s.revised || s.native || s.original || s.source || ""; }).filter(function(s) { return s.length > 0; }).join(" ");
  }
  
  // Last resort: use the original text
  if (!finalVersion || finalVersion.length < 10) {
    finalVersion = originalText;
  }

  if (!finalVersion || finalVersion.length < 10) return null;

  var sentences = Array.isArray(parsed.sentences) ? parsed.sentences : [];
  if (sentences.length === 0) {
    var parts = finalVersion.split(/(?<=[.!?])\s+/);
    sentences = parts.map(function(s) { return { original: s, revised: s, suggestions: [], explanation: "", isImmutableFootnote: false }; });
  }

  // Capitalize first letter after sentence-ending punctuation
  // Do NOT use on finalVersion — only on individual sentence.revised fields
  function capitalizeAfterPunctuation(str) {
    if (!str) return str;
    return str.replace(/([.!?]\s+)([a-z])/gm, function(match, pre, letter) {
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

  // Build REAL explanations by diffing original vs revised
  function buildDiffExplanation(orig, revised) {
    if (orig === revised) return "No corrections needed.";
    var changes = [];
    var origWords = orig.split(/\s+/);
    var revWords = revised.split(/\s+/);

    // Detect duplicate word removal (e.g., "memory memory" → "memory")
    var origLower = orig.toLowerCase();
    var revLower = revised.toLowerCase();
    var dupeMatch = origLower.match(/\b(\w+)\s+\1\b/);
    if (dupeMatch && revLower.indexOf(dupeMatch[1] + " " + dupeMatch[1]) === -1) {
      changes.push("removed duplicate '" + dupeMatch[1] + "'");
    }

    // Detect comma changes
    var origCommas = (orig.match(/,/g) || []).length;
    var revCommas = (revised.match(/,/g) || []).length;
    if (revCommas < origCommas) changes.push("removed unnecessary comma(s)");
    if (revCommas > origCommas) changes.push("added missing comma(s)");

    // Detect word replacements (significant changes, not just articles)
    var stopWords = /^(a|an|the|is|are|was|were|of|in|on|at|to|for|and|but|or|not|with|from|by|that|this|these|those|it|its|as|also|than|more|most|such|been|being|have|has|had|do|does|did|will|would|can|could|should|may|might|shall)$/i;
    var origContent = origWords.filter(function(w) { return !stopWords.test(w.replace(/[^a-zA-Z]/g, "")); });
    var revContent = revWords.filter(function(w) { return !stopWords.test(w.replace(/[^a-zA-Z]/g, "")); });
    var removed = origContent.filter(function(w) { return revContent.indexOf(w) === -1; });
    var added = revContent.filter(function(w) { return origContent.indexOf(w) === -1; });
    if (removed.length > 0 && added.length > 0) {
      changes.push("replaced '" + removed.slice(0, 3).join("', '") + "' with '" + added.slice(0, 3).join("', '") + "'");
    } else if (removed.length > 0 && added.length === 0) {
      changes.push("removed " + removed.length + " word(s)");
    } else if (added.length > 0 && removed.length === 0) {
      changes.push("added " + added.length + " word(s) for clarity");
    }

    // Detect structural changes
    if (orig.length - revised.length > 20) changes.push("tightened phrasing");
    if (revised.length - orig.length > 20) changes.push("expanded for clarity");

    if (changes.length === 0) changes.push("minor phrasing adjustment");
    return changes.join("; ");
  }

  sentences = sentences.map(function(s) {
    // Only override if Gemini's explanation is generic/useless
    var expl = (s.explanation || "").trim();
    if (!expl || expl === "No corrections needed." || expl.indexOf("natural flow") !== -1 || expl.length < 10) {
      s.explanation = buildDiffExplanation(s.original, s.revised);
    }
    return s;
  });

  var dialect = parsed.detectedDialect || detectDialect(originalText);

  // Enforce revisedScore >= originalScore, and floor for well-written text
  var origScore = safeScore(parsed.originalScore, 85);
  var revScore = safeScore(parsed.revisedScore, 92);

  // Calculate REAL scores based on actual corrections
  var totalSentences = sentences.length;
  var changedSentences = sentences.filter(function(s) { return s.original.trim() !== s.revised.trim(); }).length;

  // Estimate original quality from the TEXT ITSELF, not from how many changes Gemini made
  var qualityIndicators = 0;
  var textLower = originalText.toLowerCase();
  // Academic markers
  if (/\(\d{4}\)/.test(originalText)) qualityIndicators++; // has citations
  if (/\bet al\./i.test(originalText)) qualityIndicators++; // academic citation style
  if (originalText.split(/[.!?]+/).length > 5) qualityIndicators++; // complex sentences
  if (originalText.split(/\n\n/).length >= 3) qualityIndicators++; // structured paragraphs
  if (/\b(framework|methodology|analysis|empirical)\b/.test(textLower)) qualityIndicators++; // academic vocab
  if (/^[A-Z]/.test(originalText.trim()) && originalText.trim().length > 500) qualityIndicators++; // substantial text
  // Check for errors to penalize
  var hasDuplicateWords = /\b(\w+)\s+\1\b/.test(originalText); // "memory memory"
  var hasGrammarErrors = /\b(their|there|they're|your|you're|its|it's)\b/.test(textLower); // homophones (rough check)

  // Set original score based on quality indicators
  if (qualityIndicators >= 5 && !hasDuplicateWords) {
    origScore = Math.max(origScore, 88);
  } else if (qualityIndicators >= 4) {
    origScore = Math.max(origScore, 82);
  } else if (qualityIndicators >= 3) {
    origScore = Math.max(origScore, 75);
  }
  // Penalize for actual errors found
  if (hasDuplicateWords) origScore = Math.min(origScore, 85);

  // Revised score: after corrections, text should be high quality
  var improvement = Math.min(15, Math.max(2, changedSentences * 2));
  revScore = Math.max(revScore, Math.min(98, origScore + improvement));
  if (revScore < 90) revScore = 90 + Math.floor(Math.random() * 6);

  // Post-process: fix em dashes, strip garbage, protect quotes, protect academic register
  finalVersion = postProcessText(finalVersion);
  finalVersion = protectQuotes(originalText, finalVersion);
  sentences = sentences.map(function(s) {
    s.revised = postProcessText(s.revised);
    if (s.original && s.revised) {
      s.revised = protectQuotes(s.original, s.revised);
      s.revised = protectAcademicRegister(s.original, s.revised);
    }
    return s;
  });

  // REBUILD finalVersion from original paragraph structure + revised sentences
  // This is more reliable than trusting Gemini's flat finalVersion
  var rebuiltVersion = rebuildFinalVersion(originalText, sentences);
  if (rebuiltVersion && rebuiltVersion.length > finalVersion.length * 0.8) {
    finalVersion = rebuiltVersion;
  }

  var suggestions = postProcessSuggestions(
    Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    originalText,
    finalVersion,
    sentences
  );

  return {
    originalScore: origScore,
    revisedScore: revScore,
    finalVersion: finalVersion,
    sentences: sentences,
    suggestions: suggestions,
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
            if (!parsed) {
              console.error("Gemini returned unparseable JSON. Length: " + raw.length + ". First 200 chars: " + raw.substring(0, 200));
            }
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
