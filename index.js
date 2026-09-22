const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cache-Control, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "X-Transform-Stream",
};

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

// --- English-only guard (mirrored verbatim in src/lib/language.ts) --------
// Keep both copies in sync: same constants, same logic, same thresholds.
var ENGLISH_ONLY_MESSAGE =
  "IdiomOptima only transforms English texts. Write or paste your text in English and try again.";

var ENGLISH_FUNCTION_WORDS = [
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "as", "is", "are", "was", "were", "be", "been", "it",
  "this", "that", "his", "her", "its", "you", "your", "we", "they", "have",
  "has", "had", "will", "would", "can", "not", "no", "there", "their",
];

function looksNonEnglish(text) {
  if (!text) return false;
  var cleaned = text
    .replace(/\*\*/g, " ")
    .split(/\r?\n/)
    .filter(function (line) {
      return line.trim() && !/^\s*(\[\d+\]|Ibid\.?)(?:\s|$)/i.test(line);
    })
    .join(" ");
  var tokens = cleaned.trim().split(/\s+/).filter(Boolean);

  var allLetters = (cleaned.match(/\p{L}/gu) || []).length;
  if (allLetters === 0) return false;
  var latin = (cleaned.match(/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/g) || []).length;
  var foreign = allLetters - latin;

  // Non-Latin script (Arabic, Cyrillic, CJK, Hangul, Kana, ...) is a decisive
  // signal, checked before the word-count guard because CJK has no separators.
  if (foreign / allLetters > 0.25) return true;

  // Too short (and word-separable) for a reliable verdict.
  if (tokens.length < 15) return false;

  var diacritics = (cleaned.match(/[\u00C0-\u00FF\u0100-\u017F\u1E00-\u1EFF]/g) || []).length;
  var stopHits = 0;
  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i].replace(/[^A-Za-z\u00C0-\u024F\u1E00-\u1EFF']/g, "").toLowerCase();
    if (tok && ENGLISH_FUNCTION_WORDS.indexOf(tok) !== -1) stopHits++;
  }
  var stopRate = stopHits / tokens.length;
  var diacriticRate = diacritics / allLetters;

  // German-style low accent density is caught by its umlauts (ä ö ü ß);
  // French/Spanish density clears the rate threshold.
  return (diacriticRate > 0.015 || /[äöüß]/i.test(cleaned)) && stopRate < 0.12;
}

// --- Clerk JWT verification -------------------------------------------
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

// --- Supabase helpers -------------------------------------------------
async function supabaseQuery(supabaseUrl, supabaseKey, table, params) {
  const url = supabaseUrl + "/rest/v1/" + table + "?" + params;
  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        apikey: supabaseKey,
        Authorization: "Bearer " + supabaseKey,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return null;
  }
  if (!resp.ok) return null;
  return resp.json();
}

async function supabaseRpc(supabaseUrl, supabaseKey, fn, body) {
  let resp;
  try {
    resp = await fetch(supabaseUrl + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: "Bearer " + supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return null;
  }
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

// --- Stripe helpers ---------------------------------------------------
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

async function createStripePortal(stripeKey, customerId) {
  const origin = "https://idiomoptima.com";
  const resp = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + stripeKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      customer: customerId,
      return_url: origin + "/app?manage=1",
    }).toString(),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error("Stripe portal error: " + err.substring(0, 200));
  }
  const session = await resp.json();
  return session.url;
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

    const signedPayload = new TextEncoder().encode((parts.t || "") + "." + body);
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
      try {
        const customerEmail = session.customer_details && session.customer_details.email
          ? session.customer_details.email
          : (session.metadata && session.metadata.email) || "";
        await supabaseRpc(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, "upsert_user", {
          p_clerk_id: clerkId,
          p_email: customerEmail,
        });
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
      } catch (e) {
        console.error("stripe-webhook: checkout completed role-upgrade failed: " + String((e && e.message) || e).substring(0, 200));
      }
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
      try {
        await fetch(env.SUPABASE_URL + "/rest/v1/users?stripe_subscription_id=eq." + encodeURIComponent(sub.id), {
          method: "PATCH",
          headers: {
            apikey: env.SUPABASE_SERVICE_KEY,
            Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ subscription_tier: "free" }),
        });
      } catch (e) {
        console.error("stripe-webhook: subscription-deleted downgrade failed: " + String((e && e.message) || e).substring(0, 200));
      }
    }
  }

  return jsonResponse({ received: true });
}

// --- Main fetch handler ----------------------------------------------
const SYSTEM_PROMPT = [
  "You are a grammar and spelling correction engine. Your ONLY job is to fix clear",
  "grammar errors and spelling mistakes.",
  "",
  "STRICT RULES:",
  "1. Return the COMPLETE text — every word, every paragraph, every footnote, every",
  "   heading. Nothing dropped.",
  "2. Fix ONLY: subject-verb agreement errors, wrong verb tenses, misspelled words,",
  "   wrong articles (a/an/the), wrong prepositions when clearly incorrect.",
  "3. Do NOT: add commas, remove commas, restructure sentences, change word choice,",
  "   rewrite phrases, simplify vocabulary, change formal words to informal ones,",
  "   nativize or 'fix' style. Leave sentence structure and wording alone.",
  "4. Do NOT touch: footnote markers [1] or [[1]](#_ftn1), citation text, bibliography",
  "   entries, URLs, DOIs.",
  "5. Preserve ALL paragraph breaks exactly as in the input — do NOT merge or split",
  "   paragraphs.",
  "6. Preserve ALL headings exactly as in the input.",
  "7. Detect the dialect (US/UK/CA/AU) from the spelling in the input and preserve it.",
  "   Do NOT convert UK spelling to US or vice versa.",
  "8. Never alter dates, years, numbers, names, or figures anywhere in the text — both",
  "   inside and outside quoted material.",
  "9. Return ONLY valid JSON. No markdown fences.",
  "",
  "SENTENCES: Break the text into logical sentences or lines.",
  "For each sentence, return:",
  "- 'original': the sentence exactly as in the input",
  "- 'revised': the corrected sentence, or identical when no grammar/spelling error",
  "  was found. Structural and stylistic changes are FORBIDDEN in 'revised'.",
  "- 'explanation': For CHANGED sentences ONLY — state the specific error fixed",
  "  (e.g. 'Fixed subject-verb agreement', 'Spelling: underlaying -> underlying').",
  "  For UNCHANGED sentences, use exactly: 'No corrections needed.'",
  "- 'isImmutableFootnote': true for footnote markers, citation lines, and bibliography entries",
  "",
  "suggestions: Return exactly 1 item: a summary of all corrections made, e.g.:",
  "- 'Corrected 1 spelling error, 1 subject-verb agreement error.'",
  "or 'No corrections needed.'",
  "",
  "originalScore (0-100): Rate grammatical correctness of the ORIGINAL.",
  "- 88-95: well-written with few or no issues. 70-87: some clear errors.",
  "- Below 70: frequent errors. Never above 95 unless genuinely flawless.",
  "revisedScore (0-100): Rate the text AFTER your corrections. Must be >= originalScore,",
  "  and equal when no corrections were made.",
  "",
  "OUTPUT: Valid JSON only, no markdown fences.",
  '{"originalScore": N, "revisedScore": N, "finalVersion": "COMPLETE corrected text",',
  '"sentences": [{"original": "...", "revised": "...", "explanation": "...", "isImmutableFootnote": false}],',
  '"suggestions": ["Corrected X errors: ..."], "explanation": "Fixed X grammar and Y spelling issues.", "detectedDialect": "US|UK|CA|AU"}',
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
  text = text.replace(/^Here is the (full )?nativized text[:\s]*/i, "");
  text = text.replace(/^Full text[:\s]*/i, "");
  text = text.replace(/^Here is the (refined|edited|corrected|revised) (version|text)[:\s]*/i, "");
  text = text.replace(/^Refined text[:\s]*/i, "");
  text = text.replace(/^\d+%\s*$/gm, "");
  text = text.replace(/\s*[—–]\s*/g, ", ");
  text = text.replace(/,\s*,/g, ",");
  text = text.replace(/,\./g, ".");
  text = text.replace(/ {2,}/g, " ");
  text = text.replace(/([.!?]\s+)([a-z])/g, function(m, pre, ch) { return pre + ch.toUpperCase(); });
  if (text.length > 0 && text[0] === text[0].toLowerCase() && text[0] !== text[0].toUpperCase()) {
    text = text[0].toUpperCase() + text.substring(1);
  }
  text = text.replace(/^[^A-Za-z0-9\u00C0-\u024F\*\['"\u2018\u2019\u201C\u201D({\[]*/, "");
  text = text.replace(/\bIn additional to\b/g, "In addition to");
  return text;
}

// "who knows" punctuation is the AUTHOR's call, not the engine's: a deterministic
// pass must never read authorial "who knows." (a rhetorical aside) as a question
// and coerce the period into "?", nor may it silently drop a real "?". When the
// SOURCE text carries a terminal mark immediately after "who knows", we enforce
// EXACTLY that mark on the revised text (author punctuation preserved verbatim,
// including surrounding spacing and case). When the source has no such mark, or
// "who knows" is not in the source, the revision is left untouched — the engine
// never fabricates punctuation.
function addQuestionMark(revised, original) {
  var srcTerm = /\bwho\s+knows(\s*)([.!?])(\s|$)/i.exec(String(original || ""));
  if (!srcTerm) return revised || "";
  var terminal = srcTerm[2];
  return String(revised || "").replace(/\b(who\s+knows)(\s*)[.!?](\s|$)/gi, function (m, wk, sp, tail) {
    return wk + sp + terminal + tail;
  });
}

function protectAcademicRegister(original, revised) {
  if (!original || !revised) return revised;
  var formalToInformal = {
    "utilizing": "using", "utilize": "use", "utilised": "used",
    "demonstrating": "showing", "demonstrate": "show",
    "facilitating": "helping", "facilitate": "help",
    "implementing": "setting up", "implement": "set up",
    "subsequently": "then", "furthermore": "also",
    "moreover": "also", "consequently": "so",
    "herein": "here", "notwithstanding": "despite",
    "robust": "strong", "transformative": "meaningful",
    "specifically": "especially", "particularly": "especially",
    "substantial": "large", "significant": "large",
    "numerous": "many", "enhance": "improve",
    "leverage": "use",
    // Formal discourse connectors the free model downgrades to generic words.
    "therefore": "so", "thereafter": "after",
    "accordingly": "so", "hence": "so", "thus": "so", "thereby": "by",
    "likewise": "also", "similarly": "also", "conversely": "but",
    "additionally": "also", "alternatively": "or", "meanwhile": "while",
  };
  var result = revised;
  for (var formal in formalToInformal) {
    var informal = formalToInformal[formal];
    var formalTest = new RegExp("\\b" + formal + "\\b", "i");
    var informalTest = new RegExp("\\b" + informal + "\\b", "i");
    var informalReplace = new RegExp("\\b" + informal + "\\b", "gi");
    if (formalTest.test(original) && informalTest.test(result) && !formalTest.test(result)) {
      result = result.replace(informalReplace, formal);
    }
  }

  // Phrase-level hardening: the free model sometimes corrupts the fixed collocation
  // "economic leverage" into "economic use" / "economic tools" / anything else.
  // If the ORIGINAL carries "economic leverage" and the revised dropped it for a
  // "economic <noun>", restore the author's exact collocation.
  if (!/\bleverage\b/i.test(result) && /economic\s+leverage\b/i.test(original)) {
    var econMatch = /\beconomic\b\s+[a-z']+\b/i.exec(result);
    if (econMatch && econMatch[0]) {
      var candidate = result.replace(econMatch[0], "economic leverage");
      if (/economic\s+leverage/i.test(candidate)) result = candidate;
    }
  }
  return result;
}

// Restores structural markers the model silently corrupted:
//  - leading discourse/linking phrases ("More specifically", "Furthermore",
//    "In addition", "Firstly", ...) that the model swapped for a generic word
//    ("especially", "also", "then", ...). Preserves the author's voice.
//  - roman-numeral list markers "(i)", "(ii)", "(iii)" whose casing the model
//    mangled into "Ii)" / "iI)" / "(II)".
function restoreStructuralMarkers(original, revised) {
  if (!original || !revised) return revised;
  var result = revised;

  // 1) Leading discourse marker restoration.
  // If the original STARTS with a multi-word / formal linker, and the revised
  // still starts a sentence but with a *different single* linker, restore the
  // original opener so voice and list structure survive.
  var openers = {
    "more specifically": ["especially", "specifically"],
    "specifically": ["especially", "in particular", "notably"],
    "in addition": ["also", "additionally", "moreover", "furthermore", "plus"],
    "furthermore": ["also", "moreover", "in addition", "additionally"],
    "moreover": ["also", "in addition", "additionally"],
    "firstly": ["first", "one"],
    "secondly": ["second", "two"],
    "thirdly": ["third", "three"],
    "finally": ["lastly", "at last"],
    "lastly": ["finally"],
    "on the other hand": ["however", "conversely", "but", "yet"],
    "in contrast": ["however", "but", "conversely", "yet"],
    "by contrast": ["however", "but", "conversely", "yet"],
    "nevertheless": ["but", "yet", "still", "however"],
    "nonetheless": ["but", "yet", "still", "however"],
    "as a result": ["so", "thus", "therefore", "hence"],
    "in consequence": ["so", "thus", "therefore"],
    "notwithstanding": ["despite"],
    "first and foremost": ["first", "primarily"],
  };

  var origTrim = original.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  var revTrim = result.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

  for (var openerPhrase in openers) {
    // Find the formal opener at a SENTENCE/paragraph boundary anywhere in the
    // original (not just anchored at index 0) - real model output often keeps
    // prior sentence content in the same entry, e.g. "...data. [1]\nMore
    // specifically, this chapter...".
    var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
    // Match the formal opener at a sentence boundary anywhere in the text.
    // origTrim is whitespace-normalized (newlines collapsed to spaces), so the
    // boundary is: start-of-string, a sentence terminator followed by space, a
    // footnote close-brace "] " (survives normalization), or a line-start.
    var boundarySrc = "(^|[.;:!?]\\s+|\\]\\s+|\\n|\\[\\d+\\]\\s+)";
    var openerRe = new RegExp(boundarySrc + "(" + esc(openerPhrase) + ")[\\s,;:]", "i");
    var om = openerRe.exec(origTrim);
    if (!om) continue;
    // Does the revised replace it with a "wrong" single-word substitute?
    var wrongSubs = openers[openerPhrase];
    var replacedOpener = null;
    for (var w = 0; w < wrongSubs.length; w++) {
      var subRe = new RegExp(boundarySrc + "(" + esc(wrongSubs[w]) + ")[\\s,;:]", "i");
      var sm = subRe.exec(revTrim);
      // Only restore if the SUBSTITUTE opener is present at a sentence boundary
      // (and the original opener is NOT present at any boundary in the revised).
      if (sm && !new RegExp(boundarySrc + "(" + esc(openerPhrase) + ")[\\s,;:]", "i").test(revTrim)) {
        replacedOpener = sm;
        break;
      }
    }
    if (!replacedOpener) continue;
    // Build new revised: splice the original opener phrase in place of the
    // wrong substitute at its boundary, preserving case of the opener as in the
    // original.
    var before = revTrim.slice(0, replacedOpener.index + replacedOpener[1].length);
    var openerCase = om[2];
    // Preserve capitalization as it appeared (first letter case).
    var openerWord = openerPhrase.charAt(0).toUpperCase() + openerPhrase.substring(1);
    if (openerCase && openerCase[0] !== openerCase[0].toUpperCase()) openerWord = openerPhrase;
    // Reinsert the trailing delimiter (e.g. "," or space) that followed the
    // wrong substitute in the revised text, then append the remaining text.
    var after = revTrim.slice(replacedOpener.index + replacedOpener[0].length);
    var delimiter = revTrim.charAt(replacedOpener.index + replacedOpener[0].length - 1);
    var newRev = before + openerWord + (delimiter === "," ? ", " : delimiter) + after;
    result = rebuildWithBold(revised, newRev);
    break;
  }

  // 2) Roman-numeral list marker casing restoration.
  var markerRe = /^\(([ivx]+|[IVX]+)\)\s*/gi;
  var origMarker = markerRe.exec(origTrim);
  if (origMarker) {
    var origSingle = origMarker[1].toLowerCase();
    markerRe.lastIndex = 0;
    var resClean = revTrim;
    // If the marker's casing changed (e.g. "(ii)" -> "Ii)" / "(II)" -> "iI)")...
    var badMarker = /^\(?[iIvVxX]{1,5}\)?\s*/i.exec(resClean);
    if (badMarker && badMarker[0]) {
      var badToken = badMarker[0].replace(/[().]/g, "").trim();
      if (badToken.toLowerCase() === origSingle) {
        var rest = resClean.slice(badMarker[0].length);
        var fixed = "(" + origMarker[1] + ") " + rest;
        fixed = fixed.charAt(0).toUpperCase() + fixed.substring(1);
        result = rebuildWithBold(revised, fixed);
      }
    }
  }

  function rebuildWithBold(oldRev, newPlain) {
    var wasBold = /^\*\*[^*]+\*\*$/.test(oldRev.replace(/\s+/g, " ").trim());
    if (wasBold) return "**" + newPlain + "**";
    return newPlain;
  }
  return result;
}

// Restores INVARIANT English idioms/collocations that the model wrongly "fixes"
// (e.g. "who knows" -> "who know"). These are fixed forms in English regardless
// of the surrounding grammar, so if the original contains the correct idiom and
// the revised corrupts it, we restore the original form. High-precision list:
// only entries that are unambiguous, so we never false-positive on prose.
function protectInvariantIdioms(original, revised) {
  if (!original || !revised) return revised;
  var result = revised;
  // 1) "who knows" is an invariant idiom. If the ORIGINAL had it (correct) and
  //    the model broke it into "who know" (e.g. over-correcting for plural
  //    "they"), restore it. If the ORIGINAL itself said "who know" (already
  //    wrong), the model's change may be legit — leave it.
  if (/who\s+know\b(?![s])/i.test(result) && /who\s+knows\b/i.test(original)) {
    result = result.replace(/\bwho\s+know\b(?!\s*[a-z])/gi, function (m) { return "who knows"; });
  }
  // 2) "Despite" never takes "of". If the ORIGINAL already had the CORRECT
  //    "Despite" (no "of") and the model introduced "Despite of", revert it.
  //    If the ORIGINAL itself said "Despite of", the model's removal is a real
  //    fix and should be kept (handled below in scoring via realChangeCount).
  if (/\bdespite\s+of\b/i.test(result) && /\bdespite\b(?!\s+of)/i.test(original)) {
    result = result.replace(/\bdespite\s+of\b/gi, "Despite");
  }
  return result;
}

// Restores a SUBSTANTIVE sentence that the free model silently DROPPED (not
// merely reworded). The model sometimes truncates a sentence after "when they
// write:" / "states that:" / a newline, deleting the quoted lead-in or clause
// that followed. Per-word guards can't bring it back, so catch it here:
//  - Only trigger when the original clearly continued AFTER where the revised
//    stops (revised ends at a colon/newline/token present in the original,
//    while the original carries more content past that point).
//  - Only restore if the dropped segment has >= 3 real content words (avoids
//    resurrecting pure filler or a lone footnote marker).
//  - Never operate on footnotes/citations/Ibid lines.
  // Restores a SUBSTANTIVE sentence that the free model silently DROPPED (not
// merely reworded). The model sometimes truncates after "when they write:" /
// "states that:" / a newline, deleting the clause that followed. Per-word
// guards can't bring it back, so catch it here:
//  - Only trigger when the REVISED ends at a delimiter (":", ";", or a bare
//    trailing newline) while the ORIGINAL carried substantive text past that
//    same delimiter — a true truncation, not a legit reword.
//  - Only restore if the dropped segment has >= 3 real content words (avoids
//    resurrecting filler or a lone footnote marker).
//  - Never operate on footnote/citation/Ibid lines.
  function contentWords(s) {
    return (String(s).match(/[A-Za-z]{4,}/g) || []);
  }
  function restoreDroppedSentence(original, revised) {
    if (!original || !revised) return revised;
    var o = String(original), r = String(revised);
    if (/^\s*\[\d+\]/.test(o) || /^\s*Ibid\.?/i.test(o) || /\(\d{4}\)/.test(o)) return revised;
    // The revised must look truncated: it ends in a colon/semicolon or a bare
    // newline (nothing substantive after it).
    if (!/([:;:\u2026])\s*$/.test(r.trim()) && !/\n\s*$/.test(r) ) return revised;
    // Locate the same delimiter in the original and grab the text AFTER it.
    var m = /[:;]\s*$/.exec(r.trim());
    var idx = o.lastIndexOf(":");
    if (idx < 0) idx = o.lastIndexOf(";");
    if (idx < 0) return revised;
    var dropped = o.slice(idx + 1).replace(/^\s*/, "").trim();
    if (!dropped) return revised;
    var words = contentWords(dropped);
    if (words.length < 3) return revised;
    // Confirm the words really are absent from the revised (it dropped them).
    var rw = contentWords(r.toLowerCase()).join(" ");
    if (words.some(function (w) { return rw.indexOf(w.toLowerCase()) !== -1; })) {
      // At least one dropped word survived in revised => not a clean drop.
      return revised;
    }
    // Keep the original delimiter's trailing text, preserving paragraph flow.
    return r.trim() + " " + dropped;
  }

// Restores a LEADING ellipsis / "(…)" continuation marker a quoted span drops
// when the splitter broke the quote across two sentences. Sentence [3] often
// starts as "(…) Theory holds out ..." while the opening quote lives in the
// previous sentence, so protectQuotes (which needs a full quoted span in one
// sentence) can't see it — the model then drops the ellipsis. A leading
// parenthesised/unparenthesised ellipsis is unambiguously an in-quote
// continuation marker, so it is never a legit deletion.
  function restoreLeadingEllipsis(original, revised) {
    if (!original || !revised) return revised;
    var lead = /^(?:[""\u201C]*\s*)(\(\.\.\.\)|\.\.\.|\u2026|\(\s*\u2026\s*\))\s*/.exec(original);
    if (!lead) return revised;
    var marker = lead[1];
    if (/^(?:[""\u201C]*\s*)(\(\.\.\.\)|\.\.\.|\u2026|\(\s*\u2026\s*\))/.test(revised)) return revised;
    return marker + " " + String(revised).replace(/^\s*/, "");
  }

// Conservative native-speaker polish applied to BODY sentences only (never
// footnotes/citations/quotes). These are high-confidence, verifiable grammar
// fixes a native editor would make and that cannot corrupt meaning:
//   1. "not merely X ... but Y" / "not only X ... but Y" parallelism — when the
//      second half uses a different grammatical form than the first, normalise.
// The free model often leaves awkward grammar untouched on clean-looking text;
// this pass guarantees at least the clearly-correct corrections surface in the
// diff and score instead of a misleading "no change".
// Applies a replacement callback only to the text OUTSIDE quoted spans, so
// quoted material (a direct quotation a writer must never have altered) is
// byte-preserved even when a filler word sits right next to a quote.
function replaceOutsideQuotes(text, fn) {
  if (!text) return text;
  var parts = [];
  var re = /[""\u201C\u2018][^""\u201D\u2019]*[""\u201D\u2019]/g;
  var last = 0, m;
  while ((m = re.exec(text)) !== null) {
    parts.push(fn(text.slice(last, m.index)));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  parts.push(fn(text.slice(last)));
  return parts.join("");
}

function nativePolish(s) {
    if (!s) return s;
    // Mechanical whitespace/punctuation polish ONLY — no word-level nativization
    // here. Lexical changes come exclusively from the deterministic DB pass.
    var out = String(s);
    // Clean a doubled separator ("ultimately, ," / "that ,") and stray spacing.
    out = out.replace(/\s*,+\s*,/g, ", ");
    out = out.replace(/\s+,\s*[,;:,]/g, " ");
    out = out.replace(/\s+/g, " ").replace(/\s,/, ",").replace(/\s+\./, ".");
    return out;
  }

// Deterministic, conservative correction of unambiguous common misspellings.
// The free model is variance-prone and may leave obvious typos untouched on
// otherwise-clean text; this body-only, quote-safe pass guarantees those clearly
// wrong words are corrected so the refined output (and its score delta) shows a
// real native-editor fix rather than a misleading "no change". Only high-
// confidence, one-way-fix words are listed; intentionally conservative to avoid
// ever rewriting a legitimate word a writer meant to keep.
function fixCommonMisspellings(s) {
  if (!s) return s;
  if (/^\s*\[\d+\]/.test(s) || /^\s*Ibid\.?/i.test(s) || /\(\d{4}\)/.test(s)) return s;
  var map = {
    "researh": "research", "acheived": "achieved", "acheive": "achieve",
    "resilts": "results", "resilt": "result", "seperation": "separation",
    "seperate": "separate", "compunds": "compounds", "compund": "compound",
    "phenominon": "phenomenon", "phenomena": "phenomenon", "phenominal": "phenomenal",
    "definetly": "definitely", "definately": "definitely", "unexpectd": "unexpected",
    "unpredicatble": "unpredictable", "receive":"receive", "recieve": "receive",
    "recieved": "received", "occured": "occurred", "occuring": "occurring",
    "occurr": "occur", "goverment": "government", "enviorment": "environment",
    "environemnt": "environment", "teh": "the", "adress": "address", "adresses": "addresses",
    "wich": "which", "becuase": "because", "becasue": "because", "untill": "until",
    "beleive": "believe", "beleived": "believed", "managment": "management",
    "devlopment": "development", "develpment": "development", "knowlege": "knowledge",
    "lanaguage": "language", "langauge": "language", "particualrly": "particularly",
    "particularily": "particularly", "accross": "across", "completly": "completely",
    "posession": "possession", "neccessary": "necessary", "neccessarily": "necessarily",
    "equpiment": "equipment", "environmnet": "environment", "thier": "their",
    "theyr": "their", "tehre": "there", "analysy": "analysis", "analys": "analysis",
    "emprical": "empirical", "empiracal": "empirical", "hierachy": "hierarchy",
    "hypothesis": "hypothesis", "hypthesis": "hypothesis", "methedology": "methodology",
    "metodology": "methodology", "signficant": "significant", "signifcant": "significant",
    "signifigant": "significant", "theoreticaly": "theoretically", "lhterature": "literature",
    "litterature": "literature", "pubication": "publication", "publcation": "publication",
    "reproducibile": "reproducible", "reproducability": "reproducibility",
    "quantitiative": "quantitative", "quanitative": "quantitative", "statistixal": "statistical",
    "vairable": "variable", "variabel": "variable", "dependancy": "dependency",
    "dependancies": "dependencies", "intial": "initial", "intially": "initially",
    "consistant": "consistent", "consistancy": "consistency", "adeqaute": "adequate",
    "adequeate": "adequate", "credibilty": "credibility", "reliablity": "reliability",
    "relevence": "relevance", "relevancy": "relevance", "interpritation": "interpretation",
    "interpratation": "interpretation", "representive": "representative"
  };
  var words = s.split(/(\b)/);
  var replaced = 0;
  var out = words.map(function (w) {
    if (/^[A-Za-z]+$/.test(w)) {
      var t = map[w.toLowerCase()];
      if (t) {
        replaced++;
        if (w[0] === w[0].toUpperCase() && w[0] === w[0].toLowerCase()) return t;
        return (w[0] === w[0].toUpperCase() && w.length > 1) ? t[0].toUpperCase() + t.slice(1) : t;
      }
    }
    return w;
  }).join("");
  if (replaced === 0) return s;
  return out;
}
// Quote-safe wrapper: never correct a misspelling that sits inside quoted text
// (a direct quotation must be preserved byte-for-byte).
function fixCommonMisspellingsSafe(s) {
  return replaceOutsideQuotes(s || "", fixCommonMisspellings);
}

// Restore typographic (curly) single quotes in the revision wherever the
// ORIGINAL used them. The model frequently normalizes the user's " ’ " to a
// straight " ' ", turning a sub-typographic (and style-correct) character into
// a fake, score-inflating diff. We re-map straight apostrophes back to the
// original's curly ones so the glyph, not the content, is preserved verbatim.
function restoreCurlyApostrophes(original, revised) {
  if (!original || !revised) return revised || original;
  if (original.indexOf("\u2019") === -1 && original.indexOf("\u2018") === -1) return revised;
  // Token-map restore: words that carried curly apostrophes in the ORIGINAL are
  // rebuilt with the curly glyph wherever they appear in the revision. Matching
  // by normalized word base (case+apostrophe agnostic, punctuation-stripped)
  // and consuming a per-word count makes this robust to inserted tokens ("the
  // added 'member' before 'SPPAIS’s'"), so curly apostrophes survive rewrites.
  var curlyMap = {};
  var rawByKey = {};
  original.split(/(\s+)/).forEach(function (w) {
    if (!/\s+/.test(w) && w !== "" && (w.indexOf("\u2019") !== -1 || w.indexOf("\u2018") !== -1)) {
      var key = w.replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/[^a-z']/g, "").replace(/'/g, "");
      if (key) {
        curlyMap[key] = (curlyMap[key] || 0) + 1;
        rawByKey[key] = w;
      }
    }
  });
  if (Object.keys(curlyMap).length === 0) return revised;
  var out = [];
  revised.split(/(\s+)/).forEach(function (rw) {
    if (/\s+/.test(rw) || rw === "") { out.push(rw); return; }
    var key = rw.replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/[^a-z']/g, "").replace(/'/g, "");
    if (key && curlyMap[key] > 0 && rawByKey[key]) {
      // Reused the original glyph for this word base.
      curlyMap[key]--;
      out.push(rawByKey[key]);
      return;
    }
    out.push(rw);
  });
  return out.join("");
}

var restoredQuoteCount = 0;

function protectQuotes(original, revised) {
  // Find all quoted text in original and restore them in revised if changed.
  // Handles double/curly quotes PLUS straight single quotes in quote position
  // (e.g. 'Qatar of the late 1990s, 2000s, and 2010s') while ignoring plain
  // possessives/contractions (today's, Roberts', leaders').
  var result = revised;

  function tokenOf(w) {
    return String(w).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9']/g, "");
  }
  function extractQuotes(t) {
    var out = {};
    // Double / curly quotes.
    var re = /["\u201C\u2018]([^"'\u201C\u201D\u2018\u2019]{2,})["\u201D\u2019]/g;
    var m;
    while ((m = re.exec(t)) !== null) {
      var c = m[1];
      if (/^['"]?[A-Z][a-z]+:/.test(c)) continue;
      out[m.index] = { index: m.index, content: c, full: m[0] };
    }
    // Straight single quotes in QUOTE position: an apostrophe preceded by a
    // non-alphanumeric and followed by content, closed by an apostrophe that
    // follows a letter and is followed by a non-letter.
    var ch = Array.from(t);
    for (var i = 0; i < ch.length; i++) {
      if (ch[i] !== "'") continue;
      var prev = i > 0 ? ch[i - 1] : "";
      if (prev && /[A-Za-z0-9]/.test(prev)) continue; // word-internal apostrophe
      var nxt = i < ch.length - 1 ? ch[i + 1] : "";
      if (!nxt || !/[A-Za-z0-9]/.test(nxt)) continue; // open must precede content
      for (var j = i + 1; j < ch.length; j++) {
        if (ch[j] !== "'") continue;
        var prevJ = ch[j - 1];
        if (!prevJ || !/[A-Za-z0-9]/.test(prevJ)) continue; // close follows a letter
        var nextJ = j < ch.length - 1 ? ch[j + 1] : "";
        if (nextJ && /[A-Za-z0-9]/.test(nextJ)) continue; // close precedes non-letter
        var inner = ch.slice(i + 1, j).join("");
        if (inner.length >= 2 && !/["'\u2018\u2019\u201C\u201D]/.test(inner)) {
          out[i] = { index: i, content: inner, full: "'" + inner + "'" };
        }
        i = j; // resume scan AFTER the closing quote
        break;
      }
    }
    var arr = [];
    for (var k in out) arr.push(out[k]);
    arr.sort(function (a, b) { return a.index - b.index; });
    return arr;
  }
  function words(s) { return s.replace(/[^\w\u2019'-]+/g, " ").trim().split(/\s+/); }
  function overlap(a, b) {
    var aw = words(a), bw = words(b);
    if (!aw.length || !bw.length) return 0;
    var hit = 0;
    for (var i = 0; i < aw.length; i++) if (bw.indexOf(aw[i]) !== -1) hit++;
    return hit / Math.max(aw.length, bw.length, 1);
  }

  var origQuotes = extractQuotes(original);
  var resQuotes = extractQuotes(result);

  // Iterate original quotes. Best-effort positional/similarity pairing with a
  // revised quote, then restore the EXACT original quote if they differ.
  var used = {};
  for (var i = 0; i < origQuotes.length; i++) {
    var oq = origQuotes[i];
    // Prefer the positional match (same index) or the best-overlap unused one.
    var target = null, bestScore = 0;
    if (resQuotes[i] && !used[i]) {
      target = resQuotes[i];
      bestScore = overlap(oq.full, resQuotes[i].full);
    }
    for (var j = 0; j < resQuotes.length; j++) {
      if (used[j]) continue;
      var s = overlap(oq.full, resQuotes[j].full);
      if (s > bestScore) { bestScore = s; target = resQuotes[j]; }
    }
    if (!target) continue;
    // Only restore when the revised quote is a REASONABLE but NOT identical
    // variant of the original (it has meaningful word overlap yet differs).
    if (bestScore >= 0.5 && target.full !== oq.full) {
      result = result.substring(0, target.index) + oq.full + result.substring(target.index + target.full.length);
      restoredQuoteCount++;
      used[i] = true;
    } else if (target === resQuotes[i]) {
      used[i] = true;
    }
  }

  // Anchor fallback: when pairing found no stale quote span to restore (e.g.
  // the model rewrote the phrase so the quote marks themselves moved), locate
  // the tokens that surrounded the quote in the ORIGINAL and swap whatever now
  // sits between them in the result for the EXACT original quoted span — but
  // only when the bracketed region still contains quote characters and is a
  // plausible length, otherwise we leave the sentence untouched.
  function tokenSpans(text) {
    var spans = [];
    var re = /[A-Za-z0-9\u2019']+/g;
    var mm;
    while ((mm = re.exec(text)) !== null) {
      spans.push({ start: mm.index, end: re.lastIndex, raw: text.slice(mm.index, re.lastIndex) });
    }
    return spans;
  }
  function findSeq(spans, from, wanted) {
    for (var a = from; a <= spans.length - wanted.length; a++) {
      var ok = true;
      for (var k = 0; k < wanted.length; k++) {
        if (tokenOf(spans[a + k].raw) !== wanted[k]) { ok = false; break; }
      }
      if (ok) return { start: spans[a].start, end: spans[a + wanted.length - 1].end };
    }
    return null;
  }
  var oSpans = tokenSpans(original);
  var oTokNorms = oSpans.map(function (sp) { return tokenOf(sp.raw); });
  var oStart = 0, oEnd = oSpans.length - 1;

  for (var q = 0; q < origQuotes.length; q++) {
    var qq = origQuotes[q];
    if (result.indexOf(qq.full) !== -1) continue; // already preserved verbatim
    // Tokens fully before / after the quote in the ORIGINAL.
    var beforeIdx = -1;
    while (oStart <= oEnd && oSpans[oStart].end <= qq.index) { beforeIdx = oStart; oStart++; }
    var afterIdx = -1;
    for (var t2 = oEnd; t2 >= 0; t2--) if (oSpans[t2].start >= qq.index + qq.full.length) afterIdx = t2;
    if (beforeIdx < 0 || afterIdx < 0 || afterIdx <= beforeIdx) continue;
    var beforeWanted = oTokNorms.slice(Math.max(0, beforeIdx - 2), beforeIdx + 1);
    var afterWanted = oTokNorms.slice(afterIdx, afterIdx + 3);
    var rSpans = tokenSpans(result);
    var bm = findSeq(rSpans, 0, beforeWanted);
    if (!bm) continue;
    var spanFrom = 0;
    for (var aa = 0; aa < rSpans.length; aa++) if (rSpans[aa].end <= bm.end) spanFrom = aa + 1;
    var am = findSeq(rSpans, spanFrom, afterWanted);
    if (!am || am.start <= bm.end) continue;
    var between = result.slice(bm.end, am.start);
    var qLen = qq.full.length;
    if (between.length < qLen * 0.4 || between.length > qLen * 3) continue;
    if (!/["'\u2018\u2019\u201C\u201D]/.test(between)) continue;
    result = result.slice(0, bm.end) + qq.full + result.slice(am.start);
    restoredQuoteCount++;
  }

  return result;
}

// Deterministic voice-preservation guard (Fix-E sibling): if the model HARDENED
// the author's epistemic stance (e.g. "This suggests that ... -> This shows",
// "may -> will", "could -> can", "tends to -> always"), swap the blunt word back
// to the author's exact hedged word. Word-swap level, so phrasing around the
// hedge keeps its edits. Only fires when (a) the hedged word is GONE from the
// revision, (b) exactly ONE blunt counterpart took its place, (c) that blunt
// word was NOT in the source (so a legit "show"/"will" elsewhere is untouched),
// and (d) the rest of the sentence still overlaps the source. Counts real
// restores in epistemicRestoreCount (surfaced via reviewNotes).
var epistemicRestoreCount = 0;

var HEDGED_TO_BLUNT = {
  suggest: ["show", "shows", "showed", "showing", "prove", "proves", "proved", "proven", "demonstrate", "demonstrates", "demonstrated", "confirm", "confirms", "confirmed", "establish", "establishes", "established"],
  imply: ["show", "shows", "showed", "showing", "prove", "proves", "proved", "proven", "demonstrate", "demonstrates", "demonstrated", "confirm", "confirms", "confirmed"],
  indicate: ["show", "shows", "showed", "showing", "prove", "proves", "proved", "proven", "demonstrate", "demonstrates", "demonstrated", "confirm", "confirms", "confirmed"],
  appear: ["prove", "proves", "proved", "proven", "show", "shows", "showed", "showing", "demonstrate", "demonstrates", "demonstrated", "confirm", "confirms", "confirmed"],
  argue: ["demonstrate", "demonstrates", "demonstrated", "prove", "proves", "proved", "proven", "show", "shows", "showed", "showing"],
  claim: ["demonstrate", "demonstrates", "demonstrated", "show", "shows", "showed", "showing", "prove", "proves", "proved", "proven"],
  may: ["will", "must", "certainly", "definitely"],
  might: ["will", "must"],
  could: ["can", "will", "must"]
};

// Cheap morphological variants so "suggests"/"suggested"/"suggesting" all reduce
// to a form that matches the hedge table. Kept conservative; inflected blunt
// forms are also listed explicitly above.
function stemVariants(w) {
  var t = String(w || "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z']/g, "").replace(/'/g, "");
  var out = [t];
  if (/ing$/.test(t) && t.length > 5) out.push(t.slice(0, -3));
  if (/ied$/.test(t)) out.push(t.slice(0, -3) + "y");
  if (/(ed|es)$/.test(t) && t.length > 4) out.push(t.slice(0, -2));
  if (/s$/.test(t) && !/ss$/.test(t) && t.length > 3) out.push(t.slice(0, -1));
  return out;
}

function protectEpistemicVoice(original, revised) {
  if (!original || !revised || original === revised) return revised;
  var result = revised;

  function splitWords(text) {
    return String(text || "").split(/\s+/).filter(function (w) { return w.length > 0; });
  }
  var origWords = splitWords(original);

  // "tends to <verb>" -> "always <verb>" (the listed hardening case): restore the
  // hedged phrase when the model swapped in an always/invariably adverb and the
  // verb's base form survives in the source ("tends to linger" -> "always
  // lingers" -> back to "tends to linger").
  if (/\btends?\s+to\b/i.test(original) && !/\btend/i.test(result) && /always|invariably/i.test(result)) {
    var altMatch = /\b(always|invariably)\s+([A-Za-z]+)/i.exec(result);
    var altVerb = altMatch ? altMatch[2] : "";
    var altBase = altVerb.toLowerCase().replace(/ing$/, "").replace(/ed$/, "").replace(/s$/, "");
    if (altMatch && altBase.length > 2 && new RegExp("\\b" + altBase + "\\w*", "i").test(original)) {
      result = result.replace(altMatch[0], "tends to " + altBase);
      epistemicRestoreCount++;
    }
  }

  var restoredFor = {};
  for (var i = 0; i < origWords.length; i++) {
    var ow = origWords[i];
    var oStems = stemVariants(ow);
    var hedge = null;
    for (var s = 0; s < oStems.length; s++) {
      if (HEDGED_TO_BLUNT[oStems[s]]) { hedge = oStems[s]; break; }
    }
    if (!hedge) continue;
    if (restoredFor[hedge]) continue; // one restore per hedge type per sentence
    var hedgeLower = hedge.toLowerCase();
    // "may" followed by a bare year/number is a month, not a hedge.
    if (hedgeLower === "may" && /^\d{2,4}$/.test(String(origWords[i + 1] || ""))) continue;

    var revWords = splitWords(result);
    // Hedge still present in some form? The model kept the author's voice; nothing to do.
    var stillHedged = revWords.some(function (rw) {
      return stemVariants(rw).some(function (st) { return st === hedge || (HEDGED_TO_BLUNT[st] && st === hedgeLower); });
    });
    if (stillHedged) continue;

    // Find blunt candidates in the revision whose word was NOT in the source.
    var bluntForms = HEDGED_TO_BLUNT[hedge];
    var bluntHits = [];
    revWords.forEach(function (rw) {
      var sts = stemVariants(rw);
      for (var x = 0; x < sts.length; x++) {
        var st = sts[x];
        var bluntHit = null;
for (var b = 0; b < bluntForms.length; b++) {
        if (st === bluntForms[b]) { bluntHit = bluntForms[b]; break; }
      }
      if (!bluntHit) continue;
        var bluntInSource = origWords.some(function (ow2) { return stemVariants(ow2).indexOf(bluntHit) !== -1; });
        if (!bluntInSource) bluntHits.push({ word: rw, stem: bluntHit });
        break;
      }
    });
    if (bluntHits.length !== 1) continue;

    // Sentence must otherwise still overlap the source (only the stance changed).
    var oSet = {};
    origWords.forEach(function (w) {
      stemVariants(w).forEach(function (st) { if (/[a-z]/.test(st) && st.length >= 3) oSet[st] = 1; });
    });
    var rSet = {};
    revWords.forEach(function (w) {
      stemVariants(w).forEach(function (st) { if (/[a-z]/.test(st) && st.length >= 3) rSet[st] = 1; });
    });
    var oTotal = Object.keys(oSet).length;
    var shared = 0;
    for (var k in rSet) if (oSet[k]) shared++;
    if (oTotal === 0 || shared / oTotal < 0.45) continue;

    // Swap the blunt word's FIRST occurrence back to the author's EXACT hedged
    // word from the source (case preserved).
    var exact = ow.replace(/[^A-Za-z\u2018\u2019]/g, "");
    if (!exact) continue;
    var bluntWord = bluntHits[0].word.replace(/[^A-Za-z\u2018\u2019]/g, "");
    if (!bluntWord) continue;
    if (!new RegExp("\\b" + escapeRegExp(bluntWord) + "\\b", "i").test(result)) continue;
    result = result.replace(new RegExp("\\b" + escapeRegExp(bluntWord) + "\\b", "i"), exact);
    epistemicRestoreCount++;
    restoredFor[hedge] = 1;
  }
  return result;
}

function postProcessSuggestions(suggestions, originalText, finalText, sentences, preservedFootnoteCount, reviewNotes) {
  var suggs = [];

  var changedSentences = [];
  var unchangedCount = 0;
  var flaggedCount = 0;
  var footnoteCount = preservedFootnoteCount || 0;
  var correctionTypes = { grammar: 0, punctuation: 0, spelling: 0, structure: 0, other: 0 };

  if (sentences && sentences.length > 0) {
    for (var i = 0; i < sentences.length; i++) {
      var orig = (sentences[i].original || "").trim();
      var rev = (sentences[i].revised || "").trim();

      // Skip only ACTUAL citation/footnote lines (same narrow detection as
      // deriveSentencesFromTexts + applyDatabaseNativization).
      var sOrig = orig.replace(/^\s*\[\d+\]\s*/, "");
      var sIsCitation = /^\[\d+\]/.test(orig) && sOrig.length > 0 && (
        /^\s*Ibid\.?(\s|$)/i.test(sOrig) ||
        /^[A-Z][^?!\n]*\(\d{4}\)/.test(sOrig) ||
        /https?:\/\//i.test(sOrig) ||
        /\bDOI\b/i.test(sOrig)
      );
      if (sentences[i].isImmutableFootnote || sIsCitation || /^\([A-Z][a-z]+,\s*\d{4}\)/.test(orig) || /^\s*Ibid\.?/i.test(orig)) {
        footnoteCount++;
        continue;
      }
      // Sentences the semantic-fidelity guard flagged as potentially inverted
      // are excluded from the changed/unchanged counts: they are surfaced as
      // explicit review notes (Fix-P0, Fix-P3).
      if (sentences[i].semanticRisk) {
        flaggedCount++;
        continue;
      }

      var origCleanH = orig.replace(/^\*\*/, "").replace(/\*\*$/, "").trim().replace(/\s+/g, " ");
      var revCleanH = rev.replace(/^\*\*/, "").replace(/\*\*$/, "").trim().replace(/\s+/g, " ");
      if (origCleanH === revCleanH) {
        unchangedCount++;
        continue;
      }
      if (origCleanH.length < 120 && /^[A-Z]/.test(origCleanH) && !/[.!?]$/.test(origCleanH) && rev.replace(/\s+/g, " ").trim() === "**"+origCleanH+"**") {
        unchangedCount++;
        continue;
      }

      if (orig === rev) {
        unchangedCount++;
        continue;
      }
      // Mark punctuation/citation-marker-only rewrites as unchanged (consistent
      // with the explanation/score classification).
      if (contentTokenSeq(origCleanH) === contentTokenSeq(revCleanH)) {
        unchangedCount++;
        continue;
      }

      changedSentences.push({
        num: i + 1,
        orig: orig.substring(0, 80) + (orig.length > 80 ? "..." : ""),
        revised: rev.substring(0, 80) + (rev.length > 80 ? "..." : ""),
        explanation: (sentences[i].explanation || ""),
      });

      var expl = (sentences[i].explanation || "").toLowerCase();
      if (orig.indexOf("?") === -1 && rev.indexOf("?") !== -1) correctionTypes.punctuation++;
      else if (expl.indexOf("grammar") !== -1 || expl.indexOf("agreement") !== -1 || expl.indexOf("tense") !== -1) correctionTypes.grammar++;
      else if (expl.indexOf("punctuation") !== -1 || expl.indexOf("comma") !== -1 || expl.indexOf("splice") !== -1) correctionTypes.punctuation++;
      else if (expl.indexOf("spell") !== -1 || expl.indexOf("misspell") !== -1) correctionTypes.spelling++;
      else if (expl.indexOf("replac") !== -1 || expl.indexOf("word") !== -1 || expl.indexOf("phras") !== -1) correctionTypes.other++;
      else correctionTypes.other++;
    }
  }

  var parts = [];
  if (correctionTypes.grammar > 0) parts.push(correctionTypes.grammar + " grammar");
  if (correctionTypes.punctuation > 0) parts.push(correctionTypes.punctuation + " punctuation");
  if (correctionTypes.spelling > 0) parts.push(correctionTypes.spelling + " spelling");
  if (correctionTypes.other > 0) parts.push(correctionTypes.other + " other");

  if (parts.length > 0) {
    suggs.push("Corrected " + parts.join(", ") + " issue(s) across " + changedSentences.length + " sentence(s).");
  } else if (changedSentences.length > 0) {
    suggs.push(changedSentences.length + " sentence(s) refined for clarity and natural flow.");
  } else {
    suggs.push("No grammar, punctuation, or spelling errors found. Text is clean.");
  }

  var showCount = Math.min(changedSentences.length, 8);
  for (var j = 0; j < showCount; j++) {
    var cs = changedSentences[j];
    suggs.push("Sentence " + cs.num + ": " + cs.explanation);
  }
  if (changedSentences.length > 8) {
    suggs.push("... and " + (changedSentences.length - 8) + " more corrected sentence(s).");
  }

  suggs.push("Preserved: " + unchangedCount + " unchanged sentence(s), " + footnoteCount + " footnote(s)/citation(s).");
  var srcCount = countSourceSentences(originalText);
  if (srcCount > 0 && changedSentences.length + unchangedCount + flaggedCount > srcCount) {
    suggs.push("Based on " + srcCount + " source sentence(s); the output was re-segmented during alignment, so the counts above include reconstructed sentences.");
  }

  if (flaggedCount > 0) {
    suggs.push("Flagged: " + flaggedCount + " sentence rewrite(s) may have inverted the meaning — see notes below.");
  }
  if (reviewNotes && reviewNotes.length > 0) {
    // Bound the note volume so the panel never floods.
    reviewNotes.slice(0, 6).forEach(function (note) { suggs.push(note); });
  }

  return suggs;
}

function detectDialect(text) {
  var lower = (text || "").toLowerCase();
  if (/\b(colour|behaviour|favour|flavour|harbour|labour|behaviour|towards|amongst|whilst|analyse[sd]?|analysing|organisation|organise[sd]?|prioritise[sd]?|recognise[sd]?|defence|offence|licence|practise|cheque|programme|centre|theatre|metre|fibre|colonisation|travelled|labelled|characterisation)\b/i.test(lower)) return "UK";
  if (/\bcanada\b|\bcanadian\b/.test(lower)) return "CA";
  if (/\baustralia\b|\baustralian\b/.test(lower)) return "AU";
  return "US";
}

function buildGrammarPrompt(text, options) {
  var dialect = options.forcedDialect || "the most likely";
  return (
    "Domain: " + options.domain + "\nTone: " + options.tone + "\nMode: " + options.mode + "\nDialect: " + dialect + "\n\n" +
    "TASK: Fix grammar and spelling errors ONLY — subject-verb agreement, wrong verb tenses, misspellings, " +
    "wrong articles (a/an/the), and clearly wrong prepositions. Do NOT restructure sentences, change word " +
    "choice, nativize or 'improve' the style, add or remove commas, or rewrite phrasing. The COMPLETE text " +
    "is returned; the deterministic nativization layer runs afterwards, so lexical replacement is not your job.\n" +
    "Text:\n" + text
  );
}

async function callGemini(text, options, apiKey) {
  return callGeminiRaw(buildGrammarPrompt(text, options), apiKey);
}

function chunkText(text, maxWords) {
  var limit = maxWords || 800;
  var paragraphs = (text || "").split(/\r?\n+/);
  var chunks = [];
  var currentChunk = [];
  var currentWordCount = 0;

  paragraphs.forEach(function (p) {
    var trimmed = p.trim();
    if (!trimmed) return;
    var m = trimmed.match(/\S+/g);
    var pWords = m ? m.length : 0;
    if (pWords === 0) return;

    if (currentWordCount + pWords > limit && currentChunk.length > 0) {
      chunks.push(currentChunk.join("\n\n"));
      currentChunk = [];
      currentWordCount = 0;
    }
    currentChunk.push(trimmed);
    currentWordCount += pWords;
  });

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join("\n\n"));
  }
  return chunks;
}

async function callGeminiWithChunking(bodyText, options, apiKey, pushLine) {
  var m = (bodyText || "").match(/\S+/g);
  var wordCount = m ? m.length : 0;
  if (wordCount <= 800) {
    return callGemini(bodyText, options, apiKey);
  }

  var chunks = chunkText(bodyText, 800);
  if (pushLine) {
    pushLine({ ev: "tick", pct: 20, phase: "Divided text into " + chunks.length + " chunks for parallel processing..." });
  }

  var chunkPromises = chunks.map(async function (chunk, idx) {
    try {
      var rawResult = await callGemini(chunk, options, apiKey);
      var parsedResult = parseJsonFromModel(rawResult);
      if (pushLine) {
        pushLine({ ev: "tick", pct: Math.min(84, 20 + Math.round(((idx + 1) / chunks.length) * 60)), phase: "Completed chunk " + (idx + 1) + " of " + chunks.length });
      }
      return { index: idx, parsed: parsedResult, raw: rawResult, ok: !!parsedResult };
    } catch (e) {
      if (pushLine) {
        pushLine({ ev: "tick", pct: 30, phase: "Chunk " + (idx + 1) + " failed: " + String(e.message || e).substring(0, 100) });
      }
      return { index: idx, parsed: null, raw: null, ok: false, error: e };
    }
  });

  var results = await Promise.all(chunkPromises);
  var mergedSentences = [];
  var mergedFinalParts = [];
  var allOk = true;
  var failedIdx = [];

  for (var r = 0; r < results.length; r++) {
    var res = results[r];
    if (!res.ok || !res.parsed) {
      allOk = false;
      failedIdx.push(r + 1);
      continue;
    }

    if (Array.isArray(res.parsed.sentences)) {
      mergedSentences = mergedSentences.concat(res.parsed.sentences);
    }

    var chunkFinal = res.parsed.finalVersion || res.parsed.final || res.parsed.text || "";
    if (!chunkFinal && Array.isArray(res.parsed.sentences)) {
      chunkFinal = res.parsed.sentences
        .filter(Boolean)
        .map(function (s) { return s.revised || s.original || ""; })
        .join(" ");
    }
    if (chunkFinal) {
      mergedFinalParts.push(chunkFinal);
    } else {
      mergedFinalParts.push(chunks[res.index]);
    }
  }

  if (!allOk) {
    throw new Error("Gemini chunked processing failed. Failed chunks: " + failedIdx.join(", "));
  }

  var mergedFinalVersion = mergedFinalParts.join("\n\n");
  var mergedParsed = {
    finalVersion: mergedFinalVersion,
    sentences: mergedSentences,
    originalScore: results[0].parsed.originalScore,
    revisedScore: results[0].parsed.revisedScore,
    detectedDialect: results[0].parsed.detectedDialect || "US"
  };

  return JSON.stringify(mergedParsed);
}

// Provider-agnostic chunked wrapper used by the FALLBACK providers. Gemini
// keeps its own parallel path (callGeminiWithChunking) byte-identical; the
// free providers are rate-limited (OpenRouter free ~20 req/min), so their
// chunks run with a bounded concurrency instead of a parallel firehose.
async function callProviderWithChunking(bodyText, chunkFn, pushLine, opts) {
  var cfg = opts || {};
  var m = (bodyText || "").match(/\S+/g);
  var wordCount = m ? m.length : 0;
  if (wordCount <= 800) {
    return chunkFn(bodyText);
  }

  var chunks = chunkText(bodyText, 800);
  if (pushLine) {
    pushLine({ ev: "tick", pct: 20, phase: "Divided text into " + chunks.length + " chunks for bounded-concurrency processing..." });
  }

  var results = [];
  var cursor = 0;
  async function worker() {
    while (cursor < chunks.length) {
      var idx = cursor;
      cursor++;
      var chunk = chunks[idx];
      try {
        var rawResult = await chunkFn(chunk);
        var parsedResult = parseJsonFromModel(rawResult);
        if (pushLine) {
          pushLine({ ev: "tick", pct: Math.min(84, 20 + Math.round(((idx + 1) / chunks.length) * 60)), phase: "Completed chunk " + (idx + 1) + " of " + chunks.length });
        }
        results[idx] = { index: idx, parsed: parsedResult, raw: rawResult, ok: !!parsedResult };
      } catch (e) {
        if (pushLine) {
          pushLine({ ev: "tick", pct: 30, phase: "Chunk " + (idx + 1) + " failed: " + String(e.message || e).substring(0, 100) });
        }
        results[idx] = { index: idx, parsed: null, raw: null, ok: false, error: e };
      }
    }
  }

  var limit = cfg.concurrency || Infinity;
  var workerCount = limit === Infinity ? chunks.length : Math.max(1, Math.min(limit, chunks.length));
  var workers = [];
  for (var w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);

  var mergedSentences = [];
  var mergedFinalParts = [];
  var allOk = true;
  var failedIdx = [];

  for (var r = 0; r < results.length; r++) {
    var res = results[r];
    if (!res || !res.ok || !res.parsed) {
      allOk = false;
      failedIdx.push(r + 1);
      continue;
    }

    if (Array.isArray(res.parsed.sentences)) {
      mergedSentences = mergedSentences.concat(res.parsed.sentences);
    }

    var chunkFinal = res.parsed.finalVersion || res.parsed.final || res.parsed.text || "";
    if (!chunkFinal && Array.isArray(res.parsed.sentences)) {
      chunkFinal = res.parsed.sentences
        .filter(Boolean)
        .map(function (s) { return s.revised || s.original || ""; })
        .join(" ");
    }
    if (chunkFinal) {
      mergedFinalParts.push(chunkFinal);
    } else {
      mergedFinalParts.push(chunks[res.index]);
    }
  }

  if (!allOk) {
    throw new Error("chunked fallback processing failed. Failed chunks: " + failedIdx.join(", "));
  }

  var mergedFinalVersion = mergedFinalParts.join("\n\n");
  var mergedParsed = {
    finalVersion: mergedFinalVersion,
    sentences: mergedSentences,
    originalScore: results[0].parsed.originalScore,
    revisedScore: results[0].parsed.revisedScore,
    detectedDialect: results[0].parsed.detectedDialect || "US"
  };

  return JSON.stringify(mergedParsed);
}

async function callGeminiRaw(prompt, apiKey) {
  // 3.6-flash is the only candidate: older flash models are retired
  // (gemini-2.5-flash now 404s with "no longer available to new users"). A 404 /
  // 429 / 503 on the single candidate moves the whole attempt to the fallback
  // chain; real auth failures still surface.
  var MODEL_CANDIDATES = ["gemini-3.6-flash"];
  var lastError = "";
  for (var ci = 0; ci < MODEL_CANDIDATES.length; ci++) {
    var model = MODEL_CANDIDATES[ci];
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
    var response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }] }],
          generationConfig: { temperature: 0, topP: 1, responseMimeType: "application/json", maxOutputTokens: 65536 },
        }),
        signal: AbortSignal.timeout(90000),
      });
    } catch (e) {
      lastError = model + ": " + String((e && e.message) || e).substring(0, 200);
      continue;
    }

    if (!response.ok) {
      var errBody = await response.text();
      lastError = model + ": " + errBody.substring(0, 200);
      if (response.status === 404 || response.status === 429 || response.status === 400 || response.status === 503 || /not found|unavailable|does not exist|invalid argument|invalid_argument/i.test(errBody)) continue;
      throw new Error("Gemini API error (" + model + "): " + errBody.substring(0, 200));
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
  throw new Error("Gemini API error: all candidate models failed. Last: " + lastError);
}

// --- Fallback providers (OpenRouter free -> Workers AI)
// Every fallback returns the same JSON *string* the main loop's parseJsonFromModel
// consumes, so rotation, no-edit guards, coverage checks and rescue are shared.
var OPENROUTER_FREE_MODELS = [
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openai/gpt-oss-20b:free",
  "openrouter/free"
];

async function callChatCompletions(baseUrl, model, apiKey, prompt, opts) {
  var cfg = opts || {};
  var withoutJsonMode = false;
  while (true) {
    var body = {
      model: model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ],
      temperature: 0,
max_tokens: cfg.maxTokens || 16384
    };
    if (cfg.jsonMode !== false && !withoutJsonMode) {
      body.response_format = { type: "json_object" };
    }
    var response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs || 90000)
    });
    if (!response.ok && response.status === 400 && cfg.jsonMode !== false && !withoutJsonMode) {
      withoutJsonMode = true;
      continue;
    }
    if (!response.ok) {
      var errBody = await response.text();
      throw new Error(model + ": " + errBody.substring(0, 200));
    }
    var data = await response.json();
    var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return String(content || "");
  }
}

async function callOpenRouter(prompt, apiKey) {
  var lastError = "";
  for (var mi = 0; mi < OPENROUTER_FREE_MODELS.length; mi++) {
    var model = OPENROUTER_FREE_MODELS[mi];
    try {
      var content = await callChatCompletions("https://openrouter.ai/api/v1/chat/completions", model, apiKey, prompt, { jsonMode: true, timeoutMs: 60000, maxTokens: 16384 });
      if (parseJsonFromModel(content)) return content;
      lastError = model + ": unparseable model output (length " + String(content).length + ")";
    } catch (e) {
      lastError = model + ": " + String((e && e.message) || e).substring(0, 200);
    }
  }
  throw new Error("OpenRouter: all free models failed or returned unparseable output. Last: " + lastError);
}

var WORKERS_AI_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/qwen/qwen1.5-14b-chat-awq",
  "@cf/openai/gpt-oss-20b"
];

async function callWorkersAI(prompt, ai) {
  var lastError = "";
  for (var wi = 0; wi < WORKERS_AI_MODELS.length; wi++) {
    var model = WORKERS_AI_MODELS[wi];
    try {
      var data = await ai.run(model, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        temperature: 0,
        max_tokens: 16384
      });
      var content = data && (data.response || (data.result && data.result.response) || "");
      if (content && parseJsonFromModel(content)) return content;
      lastError = model + ": " + (content ? "unparseable model output (length " + String(content).length + ")" : "empty response");
    } catch (e) {
      lastError = model + ": " + String((e && e.message) || e).substring(0, 200);
    }
  }
  throw new Error("Workers AI: all models failed or returned unusable output. Last: " + lastError);
}

// Chip each chunk through the SAME grammar-only prompt the Gemini path uses,
// with bounded concurrency for the rate-limited free providers.
function grammarChunked(bodyText, options, pushLine, concurrency, providerFn) {
  return callProviderWithChunking(bodyText, function (chunk) {
    return providerFn(buildGrammarPrompt(chunk, options));
  }, pushLine, { concurrency: concurrency });
}

// Gemini is the ONLY primary provider; these rotate in strictly behind it and
// only after Gemini's own model rotation (3.6) is exhausted. Missing
// keys/bindings are skipped by the caller's attempts loop.
function buildProviderAttempts(bodyText, options, pushLine, env) {
  var attempts = [];
  attempts.push(["gemini", env.GEMINI_API_KEY ? function () {
    return callGeminiWithChunking(bodyText, options, env.GEMINI_API_KEY, pushLine);
  } : null]);
  attempts.push(["openrouter", env.OPENROUTER_API_KEY ? function () {
    return grammarChunked(bodyText, options, pushLine, 2, function (prompt) { return callOpenRouter(prompt, env.OPENROUTER_API_KEY); });
  } : null]);
  attempts.push(["workersai", env.AI ? function () {
    return grammarChunked(bodyText, options, pushLine, 2, function (prompt) { return callWorkersAI(prompt, env.AI); });
  } : null]);
  return attempts;
}

// Dedicated nativize/humanize prompt for the GATED pass (Phase C). Only flagged
// residual-stiff sentences reach this prompt; every other sentence is untouched
// so the author's voice is preserved by construction.
var NATIVIZE_PROMPT =
  "You are a senior native-English editor at a literary magazine. Rewrite each sentence so it reads " +
  "the way a fluent native writer actually writes prose — natural diction, idiomatic word choice, " +
  "unforced phrasing — WITHOUT changing its meaning, facts, names, numbers, dates, hedging, tone, or " +
  "the author's intended voice. Preserve the dialect convention the author uses (UK/CA/AU/US spellings " +
  "and idioms). Do not add information, do not drop information, do not restructure the sentence's logic, " +
  "and do not touch punctuation beyond what the rewrite requires. If a sentence already reads naturally " +
  "and natively, return 'revised' identical to 'original'. Respond ONLY with JSON:" +
  ' {"revisions":[{"index":0,"original":"...","revised":"..."},...]} matching every input index in order.';

async function callGeminiNativize(pairs, options, apiKey) {
  var input = JSON.stringify(pairs.map(function (p) {
    return { index: p.index, original: String(p.original || "") };
  })).substring(0, 24000);
  var prompt = NATIVIZE_PROMPT + "\n\nInput sentences:\n" + input;
  return callGeminiRaw(prompt, apiKey);
}

function countMisspellings(text) {
  if (!text) return 0;
  var mis = [
    "accomodate","acheived","acheive","adress","alot","arguement","beleive","bussiness","calender",
    "carreer","commitee","comparision","concious","councillor","definetly","definately",
    "dissapoint","embarass","enviroment","exagerate","experiance","familar","febuary","fustrated",
    "goverment","grammer","harras","hierachy","independant","knowlege","liason","maintainence",
    "millenium","mispell","mispelled","neccessary","noticable","occassion","occured","oppurtunity",
    "parrallel","passanger","persistant","phenominon","portugese","privilege","probablly",
    "pronounciation","publically","reccomend","recieve","relevent","repitition","researh",
    "resilts","seige","seperate","seperation","sieze","similer","speach","speling","succesful",
    "suprise","supersede","teh","thier","tommorow","tounge","truely","unexpectd","unecessary",
    "untill","vaccum","vauge","wich","wierd","wrok","seperately","compunds","comparitive","consious",
    "embarassing","gurantee","irrelevent","labratory","licence","managment",
    "neccesary","nucular","ocassion","occasions","rememberance","particularily","posession","proffessor",
    "refered","registre","rhethorric","rythm","sargent","soliloquy","strenght",
    "superceed","suprised","threshhold","tolerent","truley","twelth","aquaintance","aquire",
    "asessment","attemp","basicly","begginer","belive","camouflague","cemetary","colleuge","comming",
    "comparitively","conciousness","critisize","developement","discrib","dissapointed","djustment",
    "econonmy","excellance","flustrated","foriegn","fued","guarentee","heirarchy",
    "incidentaly","jeapardy","jewlery","knowledgable","lutenant","lollypop","maintainance",
    "managable","mementoes","miscellaneous","ninetheen","ninty","occurence","oppartunity",
    "paralel","paralell","peice","persue","playright","practicly","previlege","probabbly","profesional",
    "promiss","prophacy","qestion","recomend","referance","repossed","repitition","resaurant","reserach",
    "retorick","ritainment","seperately","similiar","sophmore","souds","spesific","supercede","tatoo",
    "thresold","tomorow","uneccessary","unforseen","usefull","vacume","volumn","withold","yeild"
  ];
  var lower = String(text).toLowerCase();
  var count = 0;
  for (var i = 0; i < mis.length; i++) {
    // Word-boundary match so a proper English word that merely CONTAINS a
    // misspelling entry ("maintain" containing "maintai") is never falsely
    // flagged, and no entry is credited twice from one occurrence.
    var re = new RegExp("(^|[^a-z])" + mis[i] + "(?![a-z])", "g");
    if (re.test(lower)) count++;
  }
  return count;
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
    if (/^(Chapter\s+\d+|Abstract|Introduction|Conclusion|Discussion|Results|Methods|References|Bibliography|Acknowledgments|Appendix|Key\s*[wW]ords?)\s*[:.]?\s*$/i.test(t)) return true;
    if (/^Title:|^Keywords?:|^\([A-Z]/.test(t)) return true;
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
      if (!origSent) {
        // A genuinely added sentence (empty original). Keep it in the current
        // paragraph in order so finalVersion stays 1:1 with the sentences list.
        paraSentences.push(sObj);
        sentIdx++;
        continue;
      }

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

function isFootnoteRefLine(line) {
  var t = String(line == null ? "" : line).trim().replace(/\r$/, "");
  return !!t && (/^\[\d+\]\s*/.test(t) || /^\[\[\d+\]\]\(#/.test(t) || /^Ibid\.?/i.test(t));
}

// Normalizes the rich-text footnote-reference links some editors produce
// ("[[1]](#_ftnref1)" or "[[2]](#_ftn2)") to plain "[N]" markers in the body,
// so Gemini sees the same marker shape it is told to preserve and the prose
// diff never treats the URL-ish wrapper as content. The footnote BLOCK itself
// is re-appended verbatim by the caller; only the inline body markers change.
function normalizeFootnoteRefs(text) {
  return String(text || "").replace(/\[\[(\d+)\]\]\(#[^)]*\)/g, "[$1]");
}

// A wrapped piece of a multi-line citation (URL/DOI/ISSN on its own line,
// publisher/page/editor continuation, or an indented line) stays part of the
// footnote run; a real body paragraph does not.
function isFootnoteContinuationLine(line) {
  var raw = String(line == null ? "" : line);
  var t = raw.trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^10\.\d{4,9}\//.test(t)) return true;
  if (/^(doi|issn|isbn)\s*:/i.test(t)) return true;
  if (/^(retrieved|accessed|available)\b/i.test(t)) return true;
  if (/^\s{2,}/.test(raw)) return true;
  if (/^[a-z]/.test(t)) return true;
  if (/^(p\.|pp\.|vol\.|vols\.|ed\.|eds\.|edn\.|no\.)\s*\d/i.test(t)) return true;
  // Publisher / venue continuation ("Cambridge University Press. P. 5.",
  // "Journal of Peace Research.") as the first word of a short line.
  if (/^(University|Univ\.|Press|Routledge|Springer|Wiley|Elsevier|Oxford|Cambridge|Harvard|Princeton|Chicago|M\.?I\.?T|Sage|Emerald|Palgrave|Columbia|Yale|Stanford|Journal|Review|Institute|Annual)\b/i.test(t) &&
      t.split(/\s+/).length <= 16) {
    return true;
  }
  return false;
}

// Given a tail that begins at (or with) the first footnote marker, consume the
// contiguous reference run (markers, blank gaps, wrapped continuations) and
// return the leftover as trailing body content.
function splitRefRun(tail) {
  var lines = String(tail || "").split("\n");
  var end = -1;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*$/.test(line)) continue;
    if (isFootnoteRefLine(line)) { end = i; continue; }
    if (end !== -1 && isFootnoteContinuationLine(line)) { end = i; continue; }
    break;
  }
  if (end === -1) return { refs: "", trailing: lines.join("\n").trim() };
  return {
    refs: lines.slice(0, end + 1).join("\n").trim(),
    trailing: lines.slice(end + 1).join("\n").trim(),
  };
}

function extractFootnoteBlock(text) {
  // Handle footnotes that start mid-line as "  [N] Author" at end of body paragraph
  var midFootnote = text.match(/\s{2,}\[\d+\]\s+[A-Z][^\n]*\n/);
  if (midFootnote) {
    var idx = text.indexOf(midFootnote[0]);
    var before = text.substring(0, idx).trim();
    var after = text.substring(idx).trim();
    // If after looks like footnote block, split there
    if (/^\s*\[\d+\]/.test(after)) {
      var midSplit = splitRefRun(after);

  return {
        body: (before + (midSplit.trailing ? "\n\n" + midSplit.trailing : "")).trim(),
        footnotes: midSplit.refs,
      };
    }
  }
  var lines = text.split("\n");
  var footnoteStart = -1;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim().replace(/\r$/, "");
    if (isFootnoteRefLine(line)) {
      if (footnoteStart === -1) footnoteStart = i;
    } else if (footnoteStart !== -1) {
      // Once a real, non-blank line follows the reference run, the run is over —
      // anything past it is body content (e.g. a paragraph the author placed
      // after the reference list). Previously the entire remainder was treated
      // as footnotes, hiding that paragraph from nativization.
      if (line.length > 0) break;
    }
  }
  var body;
  var footnotes = "";
  if (footnoteStart !== -1) {
    var mainSplit = splitRefRun(lines.slice(footnoteStart).join("\n"));
    footnotes = mainSplit.refs;
    body = lines.slice(0, footnoteStart).concat(mainSplit.trailing ? [mainSplit.trailing] : []).join("\n").trim();
  } else {
    body = text;
  }

  // Footnote glued to the END of a body paragraph (same line / end of input):
  // " ...theories.    [1] Ibid."  or  " ...text.[1] Author (2020)."  is NOT at
  // line start, so the line-based split above misses it. Pull it out so the
  // reference is preserved as its own footnote block instead of being sent into
  // the model body where it gets welded onto a body sentence.
  if (!footnotes) {
    // A reference glued to the last body sentence ("theories. [1] Ibid." or
    // "theories.\n[1] Ibid.") begins a footnote segment: move everything from
    // the first marker at/after the paragraph's end inward. Bare "[2]" markers
    // sitting mid-prose (not after sentence-ending punctuation) are left alone.
    var mBody = body.match(/([.!?:])[\s\n]*(\[\d+\][\s\S]*)$/);
    if (mBody && /^\[\d+\]/.test(mBody[2].trim())) {
      var gluedSplit = splitRefRun(mBody[2]);
      // Only treat glued text as footnotes when it genuinely looks like
      // references (contains a year, "Ibid", DOI, or URL).  Body prose
      // that uses inline [N] citation markers — e.g. "[1] This approach
      // is better suited for... [2] Standard approaches... [3] ... [4]"
      // — has none of these and must stay in the body so the deterministic
      // layer can nativize it.
      var refsText = gluedSplit.refs || "";
      var isRefBlock = /(?:1[89]|20)\d{2}/.test(refsText) ||
                       /\bIbid\b/i.test(refsText) ||
                       /https?:\/\//i.test(refsText) ||
                       /\bDOI[:\s]/i.test(refsText);
      if (isRefBlock) {
        footnotes = gluedSplit.refs;
        body = body.substring(0, body.length - mBody[2].length).trimEnd();
        if (gluedSplit.trailing) body = (body + "\n\n" + gluedSplit.trailing).trim();
      }
    }
  }
  return { body: (body || "").trim(), footnotes: (footnotes || "").trim() };
}

function deriveSentencesFromTexts(originalText, finalVersion) {
  function toParagraphs(text) {
    return text.split(/\n\n+/).filter(function(p) { return p.trim().length > 0; }).map(function(p) { return p.trim(); });
  }
  function toSentences(text) {
    // Don't split before footnote markers [N] — keep "politicking. [2]" together
    return text.split(/(?<=[.!?])\s+(?!\[\d+\])/).filter(function(s) { return s.trim().length > 0; }).map(function(s) { return s.trim(); });
  }
  function isFootnotePara(text) {
    var t = text.trim();
    return /^\[\d+\]/.test(t) || /^\s*Ibid\.?/i.test(t);
  }
  function isHeadingPara(text) {
    var t = text.trim().replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
    return t.length > 0 && t.length < 120 && /^[A-Z]/.test(t) && !/[.!?]$/.test(t) && !/^\[\d+\]/.test(t);
  }
  var origParas = toParagraphs(originalText);
  var revParas = toParagraphs(finalVersion);
  var result = [];
  function normalizeText(t) {
    return String(t || "").replace(/\*\*/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }
  function tokenMap(text) {
    var map = {};
    var toks = normalizeText(text).split(" ");
    for (var i = 0; i < toks.length; i++) {
      if (toks[i]) map[toks[i]] = (map[toks[i]] || 0) + 1;
    }
    return map;
  }
  function tokenSimilarity(a, b) {
    var ca = tokenMap(a);
    var cb = tokenMap(b);
    var inter = 0;
    var total = 0;
    for (var key in ca) {
      if (cb[key]) inter += Math.min(ca[key], cb[key]);
      total += ca[key];
    }
    for (key in cb) total += cb[key];
    if (total === 0) return a === b ? 1 : 0;
    return (2 * inter) / total;
  }
  var revParaUsed = {};
  for (var p = 0; p < origParas.length; p++) {
    var origPara = origParas[p];
    var origSents = (isFootnotePara(origPara) || isHeadingPara(origPara)) ? [origPara] : toSentences(origPara);
    // Match the revised paragraph by content similarity, not by exact prefix
    // (so fixes near the start of a paragraph still align).
    var revPara = "";
    var bestIdx = -1;
    var bestScore = 0;
    for (var j = 0; j < revParas.length; j++) {
      if (revParaUsed[j]) continue;
      var sim = tokenSimilarity(origPara, revParas[j]);
      if (sim > bestScore && sim >= 0.5) {
        bestScore = sim;
        bestIdx = j;
      }
    }
    if (bestIdx !== -1) {
      revPara = revParas[bestIdx];
      revParaUsed[bestIdx] = true;
    }
    if (!revPara) revPara = origPara;
    var revSents = (isFootnotePara(revPara) || isHeadingPara(revPara)) ? [revPara] : toSentences(revPara);
    // Pair each original sentence with its best-matching revised sentence.
    var usedRev = {};
    for (var s = 0; s < origSents.length; s++) {
      var orig = origSents[s];
      var rev = "";
      var sbIdx = -1;
      var sbScore = 0;
      function contentSet(text) {
        var set = {};
        normalizeText(text).split(" ").forEach(function (w) {
          if (w && !/^(a|an|the|is|are|was|were|of|in|on|at|to|for|and|or|but|not|with|from|by|that|this|these|those|it|its|as|also|than|more|most|such|been|being|have|has|had|do|does|did|will|would|can|could|should|may|might|shall|there|their|they|we|you|i|he|she|it's|be|would|which|who|what|when|where|how|so|then|after|before)$/i.test(w)) {
            set[w] = true;
          }
        });
        return set;
      }
      var origContentSet = contentSet(orig);
      var origContentWords = Object.keys(origContentSet);
      for (var r = 0; r < revSents.length; r++) {
        if (usedRev[r]) continue;
        var sim2 = tokenSimilarity(orig, revSents[r]);
        // Require a meaningful match: decent token overlap AND, when the original
        // has content words, the candidate must share at least one of them. This
        // prevents a short fragment (e.g. "It is deeply, fundamentally real.")
        // from overwriting a different sentence (e.g. "The problem is real.").
        var candContentSet = contentSet(revSents[r]);
        var sharesContent = false;
        for (var ci = 0; ci < origContentWords.length; ci++) {
          if (candContentSet[origContentWords[ci]]) { sharesContent = true; break; }
        }
        var qualified = sim2 >= 0.55 && (origContentWords.length === 0 || sharesContent);
        if (qualified && sim2 > sbScore) {
          sbScore = sim2;
          sbIdx = r;
        }
      }
      if (sbIdx !== -1) {
        rev = revSents[sbIdx];
        usedRev[sbIdx] = true;
      }
      if (!rev) rev = orig;
      // No-shorten/elongate guard: keep original if revised is >20% shorter/longer (correct, don't bridge)
      if (orig.length > 20 && rev.length > 0) {
        if (rev.length < orig.length * 0.8 || rev.length > orig.length * 1.3) {
          rev = orig;
        }
      }
      if (rev.length > 0 && rev[0] !== rev[0].toUpperCase() && rev[0] === rev[0].toLowerCase()) {
        rev = rev[0].toUpperCase() + rev.substring(1);
      }
      // Only flag ACTUAL footnote/citation lines as immutable — body prose that
      // happens to begin with an inline "[N] " marker (e.g. the model split a
      // paragraph into "[1] This approach is better suited for ...") must NOT be
      // flagged, or the deterministic layer will skip nativizing it.
      var strippedOrig = orig.replace(/^\s*\[\d+\]\s*/, "");
      var origIsCitation = /^\[\d+\]/.test(orig) && strippedOrig.length > 0 && (
        /^\s*Ibid\.?(\s|$)/i.test(strippedOrig) ||
        /^[A-Z][^?!\n]*\(\d{4}\)/.test(strippedOrig) ||
        /https?:\/\//i.test(strippedOrig) ||
        /\bDOI\b/i.test(strippedOrig)
      );
      result.push({
        original: orig,
        revised: rev,
        explanation: "",
        isImmutableFootnote: origIsCitation || /^\([A-Z][a-z]+,\s*\d{4}\)/.test(orig) || /^\s*Ibid\.?/i.test(orig),
        paragraphIndex: p,
        semanticRisk: undefined,
      });
    }
    // Emit revised sentences that have no original counterpart (e.g., a split sentence),
    // unless they duplicate already-covered content (model hallucination/echo).
    var covered = normalizeText(result.map(function (s) { return (s.original || "") + " " + (s.revised || ""); }).join(" "));
    var stripped = [];
    for (var r = 0; r < revSents.length; r++) {
      if (!usedRev[r]) {
        var addText = revSents[r].trim();
        var normAdd = normalizeText(addText);
        var isHeading = /^\*\*/.test(addText);
        var isEcho = false;
        covered = normalizeText(result.map(function (s) { return (s.original || "") + " " + (s.revised || ""); }).join(" "));
        if (!isHeading && normAdd.length > 0) {
          // (a) Verbatim/substring copy of something already covered.
          if (covered.indexOf(normAdd) !== -1) {
            isEcho = true;
          } else {
            // (b) Near-duplicate echo: most of this sentence's tokens already
            // live inside a single earlier original/revised sentence (catches
            // restatements like "Importantly, the results are clear." echoing
            // "It is important to note that the results are clear.").
            var addTokens = normAdd.split(/\s+/).filter(function (w) { return w; });
            if (addTokens.length >= 3) {
              var bestCover = 0;
              for (var ei = 0; ei < result.length; ei++) {
                var pairText = (result[ei].original || "") + " " + (result[ei].revised || "");
                var cov = tokenCoverage(addText, pairText);
                if (cov > bestCover) bestCover = cov;
              }
              if (bestCover >= 0.75) isEcho = true;
              if (!isEcho && contentCoverage(normAdd, covered) >= 0.75) isEcho = true;
            }
          }
        }
        if (isEcho) {
          stripped.push(addText);
          continue;
        }
        // Only surface genuinely new, complete sentences. Skip mid-word
        // fragments, bare fragments that are substrings of a real sentence,
        // and anything without proper sentence-end punctuation.
        var addClean = addText.replace(/^["'\u201C\u2018]+/, "").replace(/["'\u201D\u2019]+$/, "");
        var isCompleteSentence = /[.!?]["'\u201D\u2019]*\s*$/.test(addClean);
        var looksLikeFragment = addClean.length > 0 && addClean.length < 140 && !/\b(is|are|was|were|has|have|had|the|a|an|to|of|in|on|for|with|that|this|it|they|we|you|i|he|she)\b/i.test(addClean);
        var midWordBreak = /[a-z][a-z0-9'\u2019]*\s+\S*$/.test(addClean) && !isCompleteSentence;
        if (!isCompleteSentence && (looksLikeFragment || midWordBreak)) continue;
        result.push({ original: "", revised: addText, explanation: "", isImmutableFootnote: false, paragraphIndex: p, semanticRisk: undefined });
      }
    }
    // Remove hallucinated/echo copies from finalVersion (the LAST occurrence is the extra one).
    if (stripped.length > 0) {
      for (var k = 0; k < stripped.length; k++) {
        var raw = stripped[k];
        var gi = finalVersion.lastIndexOf(raw);
        if (gi !== -1) {
          var before = finalVersion.substring(0, gi).replace(/\s+$/, "");
          var after = finalVersion.substring(gi + raw.length).replace(/^\s+/, "");
          finalVersion = (before + " " + after).replace(/\s+/g, " ").trim();
        }
      }
    }
  }
  return {
    sentences: result,
    finalVersion: finalVersion,
  };
}

function capitalizeEnhanced(str) {
  if (!str) return str;
  str = str.replace(/([.!?]\s+)([a-z])/g, function(m, pre, ch) { return pre + ch.toUpperCase(); });
  if (str.length > 0 && str[0] !== str[0].toUpperCase() && str[0] === str[0].toLowerCase()) {
    str = str[0].toUpperCase() + str.substring(1);
  }
  return str;
}

function normalizeTitleBreaks(text) {
  // Handle Chapter titles with word numbers and multi-line titles (e.g., Chapter Five: ... )
  text = text.replace(/^(Chapter\s+\S+[^\n]*\n)([^\n]{1,80}\n)/, function(m, p1, p2) {
    var combined = (p1 + p2).trim();
    if (combined.length < 160 && !/[.!?]\s*$/.test(combined) && !/^\*\*/.test(combined)) {
      return "**" + combined.replace(/\n/g, " ").trim() + "**\n\n";
    }
    return m;
  });
  // First, handle specific known heading keywords with existing pattern — bold them
  var pattern = /(^|\n)((?:Chapter\s+\S+[^\n]*|Abstract|Introduction|Conclusion|Discussion|Results|Methods|References|Bibliography|Acknowledgments|Appendix|Key\s*[wW]ords?)\s*)\n/g;
  text = text.replace(pattern, function(m, p1, p2) {
    var inner = p2.trim();
    if (/^\*\*/.test(inner)) return m;
    if (inner.length > 120) return m;
    return p1 + "\n\n**" + inner + "**\n";
  });

  // General heading detection: a short line (< 80 chars) not ending with sentence-ending
  // punctuation or continuation words, followed by \n then more text. Bold + ensure \n\n.
  var continuationWords = /\b(of|the|and|or|but|in|on|at|to|for|with|from|by|that|this|a|an|is|are|was|were|has|have|had|it|its|as|be|being|been|not|also|than|more|most|such|do|does|did|will|would|can|could|should|may|might|shall|if|then|so|no|yes|however|therefore|moreover|furthermore|consequently|thus|indeed|further|meanwhile|otherwise|instead|nevertheless|nonetheless|hence|accordingly|likewise|similarly|conversely|alternatively)\s*$/i;
  text = text.replace(/([^\n]{1,80})\n(?!\n)/g, function(match, line) {
    var trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length < 80
        && !/[.!?]\s*$/.test(trimmed)
        && !/[,;:?!]\s*$/.test(trimmed)
        && !/[)\]]["\u201D\u2019]?\s*$/.test(trimmed)
        && !continuationWords.test(trimmed)
        && /^[A-Z]/.test(trimmed)
        && !/^\*\*/.test(trimmed)
        && !/^\[\d+\]/.test(trimmed)) {
      return "**" + line.trim() + "**\n\n";
    }
    return match;
  });

  // Also bold headings that are already paragraphs (already \n\n separated)
  text = text.split("\n\n").map(function(para) {
    var trimmed = para.trim();
    if (trimmed.length > 0 && trimmed.length < 80
        && !/[.!]$/.test(trimmed)
        && !/[,;:!]$/.test(trimmed)
        && !/[)\]]["\u201D\u2019]?\s*$/.test(trimmed)
        && !continuationWords.test(trimmed)
        && /^[A-Z]/.test(trimmed)
        && !/^\*\*/.test(trimmed)
        && !/^\[\d+\]/.test(trimmed)
        && !/^\([A-Z]/.test(trimmed)) {
      return "**" + trimmed + "**";
    }
    return para;
  }).join("\n\n");

  return text;
}

function reinsertParagraphBreaks(originalText, finalVersion) {
  var origParas = normalizeTitleBreaks(originalText).split(/\n\n+/).filter(function(p) { return p.trim().length > 0; });
  if (origParas.length <= 1) return finalVersion;

  var stopWords = /^(the|a|an|and|or|but|in|on|at|to|for|with|from|by|of|is|are|was|were|has|have|had|it|its|this|that|these|those|as|be|being|been|not|also|than|more|most|such|do|does|did|will|would|can|could|should|may|might|shall|if|then|so|no|yes|however|which|who|whom|whose|where|when|how|what)$/i;

  function getWords(text) {
    return text.split(/\s+/).filter(function(w) { return w.length > 0; });
  }

  function getContentWords(text) {
    return getWords(text).filter(function(w) { return !stopWords.test(w.replace(/[^a-zA-Z]/g, "")); });
  }

  function findWordSequence(text, words) {
    var textLower = text.toLowerCase();
    var searchFrom = 0;
    // Words must match at real word boundaries AND sit close together
    // (bounded gap) so the sequence forms one phrase. The old indexOf loop
    // matched substrings ("i" inside "Application") and allowed unbounded
    // gaps, which could split unrelated text (e.g. reinserting the
    // "Nonneman's framework" boundary at the "Nonneman's approach" inside
    // the previous paragraph).
    var maxGap = 60;
    while (searchFrom <= textLower.length) {
      var firstIdx = textLower.indexOf(words[0].toLowerCase(), searchFrom);
      if (firstIdx === -1) return -1;
      var beforeChar = firstIdx > 0 ? textLower[firstIdx - 1] : " ";
      var afterChar = textLower.substring(firstIdx + words[0].length, firstIdx + words[0].length + 1);
      if (/[a-z0-9]/.test(beforeChar) || /[a-z0-9]/.test(afterChar)) {
        searchFrom = firstIdx + 1;
        continue;
      }
      var phraseOk = true;
      var pos = firstIdx + words[0].length;
      for (var w = 1; w < words.length; w++) {
        var wordIdx = textLower.indexOf(words[w].toLowerCase(), pos);
        if (wordIdx === -1 || wordIdx - pos > maxGap) { phraseOk = false; break; }
        pos = wordIdx + words[w].length;
      }
      if (phraseOk) return firstIdx;
      searchFrom = firstIdx + 1;
    }
    return -1;
  }

  var matches = [];
  for (var i = 1; i < origParas.length; i++) {
    var cleanPara = origParas[i].replace(/\*\*/g, "").trim();
    // Skip headings — handled by final re-bold pass, not by word-fuzzy matcher
    if (cleanPara.length > 0 && cleanPara.length < 80 && /^[A-Z]/.test(cleanPara) && !/[.!?]$/.test(cleanPara) && !/^\[\d+\]/.test(cleanPara) && !/^\([A-Z]/.test(cleanPara)) continue;
    var rawWords = getWords(cleanPara).slice(0, 5);
    var contentWords = getContentWords(cleanPara);
    if (rawWords.length < 2 && contentWords.length < 2) continue;

    var bestIdx = -1;
    // Try raw words first (preserves paragraph start like "The principal")
    for (var w = Math.min(4, rawWords.length); w >= 3; w--) {
      var rWindow = rawWords.slice(0, w);
      var rIdx = findWordSequence(finalVersion, rWindow);
      if (rIdx > 0) { bestIdx = rIdx; break; }
    }
    if (bestIdx === -1) {
      var windowSize = Math.min(5, contentWords.length);
      for (var w = windowSize; w >= 3; w--) {
        var window = contentWords.slice(0, w);
        var idx = findWordSequence(finalVersion, window);
        if (idx > 0) { bestIdx = idx; break; }
      }
    }

    if (bestIdx === -1 && contentWords.length >= 2) {
      var pair = contentWords.slice(0, 2);
      var idx2 = findWordSequence(finalVersion, pair);
      if (idx2 > 0) bestIdx = idx2;
    }
    // Don't insert inside title/first 100 chars
    if (bestIdx !== -1 && bestIdx < 100) {
      var before = finalVersion.substring(0, bestIdx);
      if (before.indexOf("**Chapter") !== -1 || before.indexOf("Chapter") === 0) bestIdx = -1;
    }

    if (bestIdx > 0) {
      matches.push({ pos: bestIdx, paraIndex: i });
    }
  }

  matches.sort(function(a, b) { return b.pos - a.pos; });

  var result = finalVersion;
  for (var m = 0; m < matches.length; m++) {
    result = result.substring(0, matches[m].pos) + "\n\n" + result.substring(matches[m].pos);
  }
  return result;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSentenceKey(s) {
  return String(s || "")
    .replace(/^\*\*?\s*/, "")
    .replace(/\s*\*\*$/, "")
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/[""\u201C\u201D\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Echo-detection helpers: measure how much of a child sentence's meaningful
// tokens already appear in a parent sentence or a concatenated blob.
function _echoTokenSet(text) {
  var set = {};
  String(text || "")
    .toLowerCase()
    .split(/\s+/)
    .forEach(function (w) { if (w) set[w] = true; });
  return set;
}
function tokenCoverage(childText, parentText) {
  var c = _echoTokenSet(childText);
  var p = _echoTokenSet(parentText);
  var overlapped = 0;
  var total = 0;
  for (var k in c) {
    if (!Object.prototype.hasOwnProperty.call(c, k)) continue;
    total++;
    if (Object.prototype.hasOwnProperty.call(p, k)) overlapped++;
  }
  return total === 0 ? 0 : overlapped / total;
}

function echoContentSet(text) {
  var STOP = /\b(a|an|the|is|are|was|were|of|in|on|at|to|for|and|or|but|not|with|from|by|that|this|these|those|it|its|as|also|than|more|most|such|been|being|have|has|had|do|does|did|will|would|can|could|should|may|might|shall|there|their|they|we|you|i|he|she|it's|be|would|which|who|what|when|where|how|so|then|after|before)\b/gi;
  var set = {};
  String(text || "").replace(STOP, " ").split(/\s+/).forEach(function (w) {
    if (w && !/^[0-9\[\]]+$/.test(w)) set[w] = true;
  });
  return set;
}
function contentCoverage(childText, parentText) {
  var c = echoContentSet(childText);
  var p = echoContentSet(parentText);
  var overlapped = 0;
  var total = 0;
  for (var k in c) {
    if (!Object.prototype.hasOwnProperty.call(c, k)) continue;
    total++;
    if (Object.prototype.hasOwnProperty.call(p, k)) overlapped++;
  }
  return total === 0 ? 0 : overlapped / total;
}

function stripQuotedContent(t) {
  return String(t || "").replace(/["\"\u201C\u201D\u2018\u2019][^"\"\u201C\u201D\u2018\u2019]*["\"\u201C\u201D\u2018\u2019]/g, " ");
}

function normContent(t) {
  return String(t || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// True when the parsed response contains at least one REAL content change,
// mirroring the honest scorer in ensureValidResult: cosmetic-only edits
// (punctuation swaps, quote-region rewrites, whitespace/case shuffles that a
// weak free model pads into an otherwise verbatim echo) do NOT count as real
// changes — such an output must rotate to a stronger provider instead of being
// accepted as "success" and scored flat.
function parsedHasRealChanges(parsed, bodyText) {
  if (!parsed) return false;
  var list = Array.isArray(parsed.sentences) && parsed.sentences.length > 0;
  if (list) {
    var real = 0;
    for (var i = 0; i < parsed.sentences.length; i++) {
      var s = parsed.sentences[i];
      if (!s) continue;
      if (s.isImmutableFootnote) continue;
      var before = String(s.original || "").trim().replace(/\s+/g, " ");
      var after = String(s.revised || "").trim().replace(/\s+/g, " ");
      var o = before.toLowerCase();
      var r = after.toLowerCase();
      if (!/[a-z]/.test(o) || !/[a-z]/.test(r)) continue;
      if (o === r) {
        if (/(?:^|[.!?]\s+)[a-z]/.test(before)) real++;
        continue;
      }
      var oq = stripQuotedContent(o).replace(/\s+/g, " ").trim();
      var rq = stripQuotedContent(r).replace(/\s+/g, " ").trim();
      if (oq === rq) continue;
      real++;
    }
    return real > 0;
  }
  // No sentence array (finalVersion-only payload): treat a verbatim echo as no-change.
  var bn = normContent(bodyText);
  var fn = normContent(parsed.finalVersion || parsed.final || parsed.text || "");
  return !!bn && !!fn && fn !== bn;
}
function stripForContentCompare(t) {
  return stripQuotedContent(String(t || ""))
    .replace(/\*\*/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function hasRealContentChange(parsed, bodyText) {
  if (!parsed) return false;
  var list = Array.isArray(parsed.sentences) && parsed.sentences.length > 0;
  if (list) {
    for (var i = 0; i < parsed.sentences.length; i++) {
      var s = parsed.sentences[i];
      if (!s) continue;
      if (s.isImmutableFootnote) continue;
      var before = String(s.original || "").trim();
      var after = String(s.revised || "").trim();
      if (!/[A-Za-z]/.test(before) || !/[A-Za-z]/.test(after)) continue;
      if (stripForContentCompare(before) === stripForContentCompare(after)) continue;
      return true;
    }
    return false;
  }
  var bn = stripForContentCompare(bodyText);
  var fn = stripForContentCompare(parsed.finalVersion || parsed.final || parsed.text || "");
  return !!bn && !!fn && fn !== bn;
}
function contentTokenSeq(text) {
  return String(text || "")
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .replace(/\[\s*\d+[a-z]*\s*\]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .map(function (t) { return t.replace(/^[^a-z]+|[^a-z]+$/g, ""); })
    .filter(function (t) { return /^[a-z]/.test(t); })
    .join(" ");
}

// --- Deterministic nativization gates (shared with the test harness) ----------
// A very small blocklist: only genuinely paired-correlative constructions that
// MUST never be swapped out (swapping one half mangles the other half). The old
// blanket "already-native connector" stoplist was removed so the databases
// actually FIRE on common stiff phrasings; context-sensitive protection is done
// at match time by isCollocationLocked() using the COLLOCATION_PAIRS below, and
// the single-word allowlist keeps bare one-word swaps conservative.
var NATIVE_STOPLIST = [
  // "in particular" -> "especially" would be unsafe at sentence start
  // ("Especially, the MENA region..."), so the whole entry is blocked. "in
  // general" is NOT blocked: it now fires as "generally" unless its partner
  // "in particular" appears in the same sentence (see isCollocationLocked).
  "in particular",
  "in general and in particular", "in general in particular", "in general, in particular"
];

// Correlative constructions: one half may be swapped only when the other half is
// NOT present in the same sentence/quote-free segment.
var COLLOCATION_PAIRS = [
  ["in general", "in particular"],
  ["on the one hand", "on the other hand"],
  ["not only", "but also"]
];

// ONLY bare single-word sources allowed through the word-boundary pass. Every
// other single-word entry is skipped by the <2-words gate because a bare common
// word swap is too context-dependent. Each key must also exist in a database to
// do anything; inflected forms get added alongside their DB entries in Phase 2.
var SINGLE_WORD_ALLOW = {
  "seamless": true, "streamline": true, "optimize": true, "enable": true,
  "empower": true, "accelerate": true, "groundbreaking": true,
  "transformative": true, "unparalleled": true, "orchestrate": true
};

function containsWordBoundary(text, word) {
  return new RegExp("\\b" + escapeRegExp(word) + "\\b").test(String(text || "").toLowerCase());
}

function isCollocationLocked(text, src) {
  var srcLow = String(src || "").toLowerCase();
  var t = String(text || "").toLowerCase();
  for (var i = 0; i < COLLOCATION_PAIRS.length; i++) {
    var a = COLLOCATION_PAIRS[i][0];
    var b = COLLOCATION_PAIRS[i][1];
    if (a === srcLow && containsWordBoundary(t, b)) return true;
    if (b === srcLow && containsWordBoundary(t, a)) return true;
  }
  return false;
}

// Server-authoritative fallback database: used whenever the request carries no
// usable client databases (empty payload, failed client load, or a transform
// issued before the DB fetches resolved). Guarantees the deterministic
// nativization layer ALWAYS has something to enforce — so even a bare request
// with zero client data still produces real, honest transformations.
var DEFAULT_DATABASES = {
  idiomDb: [],
  // Minimal always-on AI-ese floor for the server-side fallback path (used when
  // the client ships an empty database payload). The full rule set ships with
  // the public/ JSONs via the client; these entries keep the deterministic layer
  // on task for a bare request.
  aiDb: [
    { ai: "some sort of", natural: "some kind of" },
    { ai: "went ahead with", natural: "proceeded with" },
    { ai: "go ahead with", natural: "proceed with" },
    { ai: "let us analyze this", natural: "we now analyze this" },
    { ai: "let us now analyze this", natural: "we now analyze this" },
    { ai: "as stated earlier", natural: "as noted earlier" },
    { ai: "harks back to", natural: "traces back to" },
    { ai: "levels of certainty about", natural: "confidence in" },
    { ai: "a certain richness to the", natural: "richness to the" },
    { ai: "a complex of factors", natural: "a range of factors" },
    { ai: "took the decision", natural: "made the decision" },
    { ai: "takes the decision to", natural: "decides to" },
    { ai: "it will be useful to map out", natural: "it helps to map out" },
    { ai: "intent upon spreading", natural: "determined to spread" },
    { ai: "was the key culprit in", natural: "was the main driver of" },
    { ai: "equally pressing sources of concern", natural: "equally pressing worries" },
    { ai: "casting doubt on the very legitimacy", natural: "calling into question the very legitimacy" },
    { ai: "is seen as an extension of", natural: "is regarded as an extension of" },
    { ai: "has the asset of allowing me to", natural: "allows me to" },
    { ai: "remaining within the continuity of", natural: "continuing" },
    { ai: "lends itself basically to the mere fact that", natural: "rests essentially on the fact that" },
    { ai: "within the parameters of", natural: "within the bounds of" },
    { ai: "have affinities with each other", natural: "share affinities" },
    { ai: "underpinning representation of", natural: "underlying representation of" },
    { ai: "as the world evolves at a rapid pace", natural: "as the world changes fast" },
    { ai: "is a testament to", natural: "attests to" },
    { ai: "a tapestry of", natural: "a mix of" },
    { ai: "regarding for the", natural: "regarding the" }
  ],
  lexicalDb: {
    general: [
      { clunky: "in general", native: "generally" },
      { clunky: "as well as", native: "along with" }
    ],
    academic: [
      { clunky: "it is like saying", native: "it is akin to saying" },
      { clunky: "does not have much to do with", native: "bears little relation to" },
      { clunky: "do not have much to do with", native: "bear little relation to" },
      { clunky: "better suited for", native: "better suited to" },
      { clunky: "generally oblivious to", native: "largely unaware of" },
      { clunky: "in general", native: "generally" }
    ],
    business: [
      { clunky: "in general", native: "generally" }
    ],
    creative: [
      { clunky: "it is like", native: "it is akin to" },
      { clunky: "in general", native: "generally" }
    ]
  }
};

// Heading re-bold (output-side, deterministic): the model round-trip can strip
// the '**' markers normalizeTitleBreaks added to headings in the INPUT body, so
// this pass re-wraps any sentence that is unambiguously a heading — short,
// sentence-shaped, no terminal punctuation — guaranteeing the title keeps its
// formatting in the UI, exports, and Apply-to-Editor regardless of provider.
// Deliberately conservative: skips footnotes/citations, already-bold text,
// lines ending in sentence punctuation OR ,;: (a '...following:' label is NOT a
// heading), and any multi-sentence run.
function headingShapedText(t) {
  var n = String(t || "").replace(/^\*\*/, "").replace(/\*\*$/, "").trim().replace(/\s+/g, " ");
  if (!n) return false;
  if (/^\[\d+\]/.test(n) || /^\s*Ibid\.?/i.test(n) || /^\([A-Z]/.test(n)) return false;
  if (n.indexOf("\n") !== -1) return false;
  if (/[.,!;:)]["\u201D\u2019]?\s*$/.test(n)) return false;
  if (n.split(/\s+/).length > 15 || n.length > 140) return false;
  if (!/^[A-Z]/.test(n)) return false;
  if (/["'\u201C\u201D\u2018\u2019]/.test(n.slice(0, 1)) || n.indexOf("  ") !== -1) return false;
  return true;
}

// Deterministic "heading ate the first sentence" unweld (text-level): a bold
// label glued onto a full sentence by SPACES only — "**Conclusion** This
// chapter serves as the backdrop for this thesis." — is split back into its own
// heading line. Gates: heading inner is a short label (no terminal punctuation,
// no colon "Note:" lead-ins), the bold span sits at a sentence boundary (start,
// or right after .!?\u201D\u2019;\u2018), the glued tail is a complete sentence
// that is not itself heading-shaped, and the tail is not huge. This runs BEFORE
// sentence derivation (so derive splits cleanly) and AGAIN after the paragraph
// re-builder, which can reintroduce the weld.
function splitGluedHeadings(text) {
  return String(text).replace(/(\*\*[^*\n]{1,120}\*\*)[ \t]+(?=[A-Z\u201C\u2018])/g, function(m, h, off, whole) {
    var inner = h.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
    if (/[.!?,;:\u2018\u2019]\s*$/.test(inner) || inner.split(/\s+/).length > 14) return m;
    var prevCh = off > 0 ? whole[off - 1] : "";
    // Mid-paragraph boundary (right after sentence-final punctuation): insert a
    // break BEFORE the heading too, so "...theory.**Implications** Deeper..." ->
    // "...theory.\n\n**Implications**\n\nDeeper...".
    var leadBreak = prevCh && !/[\n \t.!?\u201D\u2019;\u2018]/.test(prevCh) ? "" :
                    (prevCh && /[.!?\u201D\u2019;\u2018]/.test(prevCh) ? "\n\n" : "");
    if (prevCh && !/[.!?\u201D\u2019;\u2018\n]/.test(prevCh)) return m;
    var tail = whole.slice(off + m.length).split(/\r?\n/)[0];
    if (!/[.!?]["'\u201D\u2019]*[ \t]*$/.test(tail)) return m;
    if (headingShapedText(tail) || tail.length >= 500) return m;
    return leadBreak + h + "\n\n";
  });
}

function boldHeadingSentences(sentences) {
  if (!Array.isArray(sentences)) return sentences;
  // Question-form headings ("Where does X come from?") must stay titles ONLY when
  // the question line is its own paragraph — a question inside body prose never
  // becomes a heading. Count sentences per paragraph so we can check the gate.
  var paraCounts = {};
  sentences.forEach(function (x) {
    if (x && typeof x.paragraphIndex === "number") paraCounts[x.paragraphIndex] = (paraCounts[x.paragraphIndex] || 0) + 1;
  });
  return sentences.map(function (s) {
    if (!s) return s;
    var txt = (s.revised || "").trim();
    if (!txt) return s;
    if (s.isImmutableFootnote) return s;
    if (/^\[\d+\]/.test(txt) || /^\s*Ibid\.?/i.test(txt) || /^\([A-Z]/.test(txt)) return s;
    if (/^\*\*/.test(txt)) return s;
    var qForm = /\?\s*$/.test(txt);
    if (/[.,!;:]$/.test(txt)) return s;
    // A body sentence never becomes a heading: a closing bracket/paren tail
    // (citation marker "[4]"/"(2020)") proves the text runs on, so it is NOT
    // a title even though it lacks terminal punctuation.
    if (/[)\]]["\u201D\u2019]?\s*$/.test(txt)) return s;
    if (txt.split(/\s+/).length > 15) return s;
    if (txt.length < 1 || txt.length > 140) return s;
    if (!/^[A-Z]/.test(txt)) return s;
    if (/["'\u201C\u201D\u2018\u2019]/.test(txt.slice(0, 1)) || txt.indexOf("\n") !== -1 || txt.indexOf("  ") !== -1) return s;
    // Only re-bold when the ORIGINAL input was ALSO heading-shaped — bolding is a
    // restoration of an input heading, never an upgrade of ordinary prose.
    if (!headingShapedText(s.original)) return s;
    // A question-form title was heading-shaped in the input, but ONLY trusts the
    // restore when the line truly stands alone: a question in the middle of a
    // multi-sentence paragraph stays plain.
    if (qForm && typeof s.paragraphIndex === "number" && (paraCounts[s.paragraphIndex] || 0) !== 1) return s;
    s.revised = "**" + txt + "**";
    return s;
  });
}

// Builds deterministic nativization maps from the databases the client sends.
// Only MULTI-WORD sources participate in phrase-level matching (a bare single
// common word like "plus" -> "also" is far too risky and changes meaning);
// full-sentence mappings require the whole sentence to match verbatim. Both are
// high-precision, so enforcing them never mangles natural prose.
function buildNativizationMaps(dbs, domain) {
  var maps = { aiMap: {}, sentenceMap: {}, phraseList: [] };
  if (!dbs || typeof dbs !== "object") return maps;

  function sourceOf(e) { return e && (e.ai || e.clunky || e.source); }
  function targetOf(e) { return e && (e.natural || e.native || e.target); }

  // NATIVE_STOPLIST / COLLOCATION_PAIRS / SINGLE_WORD_ALLOW / isCollocationLocked
  // live at module scope above (shared with the test harness).

  function push(srcRaw, tgtRaw, cat) {
    var src = String(srcRaw || "").trim();
    var tgt = String(tgtRaw || "").trim();
    if (!src || !tgt) return;
    if (src.toLowerCase() === tgt.toLowerCase()) return; // idempotent entries
    var norm = src.replace(/[""\u201C\u201D]+/g, "").replace(/\s+/g, " ").trim();
    if (!norm) return;
    // Block genuinely paired-correlative connectors only (see isCollocationLocked
    // for the at-match-time counterpart of this build-time list).
    var normLow = norm.toLowerCase();
    if (NATIVE_STOPLIST.indexOf(normLow) !== -1) return;
    var first = norm.charAt(0);
    var last = norm.charAt(norm.length - 1);
    if (!/[A-Za-z\u00C0-\u024F']/.test(first) || !/[A-Za-z0-9'\u2019.]$/.test(last)) return;
    var wordCount = (norm.match(/[A-Za-z0-9'\u2019-]+/g) || []).length;
    var isAllowedSingle = wordCount === 1 && !!SINGLE_WORD_ALLOW[normLow];
    if (wordCount < 2 && !isAllowedSingle) return;
    var endsSentence = /[.!?]$/.test(norm);
    if (!endsSentence && norm.length >= 6) {
      var key = norm.toLowerCase();
      if (!maps.aiMap[key]) {
        maps.aiMap[key] = { tgt: tgt, cat: cat };
        maps.phraseList.push({ src: norm, tgt: tgt, cat: cat });
      }
    } else if (endsSentence || wordCount >= 6) {
      var sentKey = normalizeSentenceKey(norm);
      if (sentKey.length >= 8 && !maps.sentenceMap[sentKey]) {
        maps.sentenceMap[sentKey] = { tgt: tgt, cat: cat };
      }
    }
  }

  if (Array.isArray(dbs.aiDb)) dbs.aiDb.forEach(function (e) { push(sourceOf(e), targetOf(e), "ai"); });
  if (Array.isArray(dbs.idiomDb)) dbs.idiomDb.forEach(function (e) { push(sourceOf(e), targetOf(e), "idioms"); });
  var lex = dbs.lexicalDb;
  if (lex && typeof lex === "object" && !Array.isArray(lex)) {
    var domainList = lex[domain];
    if (Array.isArray(domainList)) domainList.forEach(function (e) { push(sourceOf(e), targetOf(e), "lexical"); });
    else if (lex.general) Array.isArray(lex.general) && lex.general.forEach(function (e) { push(sourceOf(e), targetOf(e), "lexical"); });
  } else if (Array.isArray(lex)) {
    lex.forEach(function (e) { push(sourceOf(e), targetOf(e), "lexical"); });
  }
  // Longest-first so a longer phrase wins over its nested shorter fragment.
  maps.phraseList.sort(function (a, b) { return b.src.length - a.src.length; });
  return maps;
}

// --- Universal grammar layer (residual DETECTOR only) -------------------------
// The "known and standard" grammar every text shares. These are language-wide,
// structural, high-confidence rules — deliberately conservative (a regex grammar
// layer only certifies what it can verify; the MODEL's correction phase handles
// the broad grammar in Pass 1). This layer NEVER edits text: it exists only as a
// deterministic residual meter (`applyGrammarLayer(...).fixes`) for scoring and
// the census. Every rule is quote-safe (via replaceOutsideQuotes).
var GRAMMAR_PLURAL_NOUNS = [
  "findings","results","factors","studies","analyses","policies","approaches",
  "strategies","mechanisms","processes","outcomes","implications","developments",
  "challenges","opportunities","measures","changes","issues","matters","effects",
  "aspects","features","dimensions","laws","rules","models","theories"
];
var GRAMMAR_SINGULAR_NOUNS = [
  "finding","result","factor","study","analysis","policy","approach","strategy",
  "mechanism","process","outcome","implication","development","challenge",
  "opportunity","measure","change","issue","matter","effect","aspect","feature",
  "dimension","law","rule","model","theory"
];
// A preceding modal/auxiliary means "have"/"do" is the bare infinitive, not a
// finite form agreeing with the pronoun: "Did she have...", "Does he have...",
// "Will it do...". The pronoun-agreement rules must never reorder those.
var AUX_PRECEDER = {
  did: 1, "didnt": 1, "didnt't": 1, do: 1, does: 1, will: 1, would: 1, can: 1,
  could: 1, shall: 1, should: 1, may: 1, might: 1, must: 1, wont: 1, wouldnt: 1,
  couldnt: 1, shouldnt: 1, cant: 1, dont: 1, doesnt: 1
};
var GRAMMAR_RULES = [
  // a/an by sound: silent-h and letter-name words take "an"; eu-/u-/one- words
  // (vowel letter, consonant sound) take "a".
  { id: "a-an-silent-h",
    re: /\b(a)\s+(hour|hourly|honest|honour|honor|honourable|honorable|honorary|heir|heiress|NGO|MBA|FBI)\b/gi,
    repl: function (m) { return "an " + m[2]; } },
  { id: "an-a-eu-words",
    re: /\b(an)\s+(university|union|uniform|unique|unit|useful|user|used|usual|usage|utensil|eulogy|euphoria|Europe|European|euro|one|once|ubiquitous|unified|unilateral|upward|uranium|UFO|URL|hourglass)\b/gi,
    repl: function (m) { return "a " + m[2]; } },
  // Subject-verb agreement in high-confidence plural/singular frames.
  { id: "sv-plural",
    re: new RegExp("\\b(the\\s+)?((" + GRAMMAR_PLURAL_NOUNS.join("|") + "))\\s+(is|was|has)\\b", "gi"),
    repl: function (m) { var map = { is: "are", was: "were", has: "have" }; return (m[1] || "") + m[2] + " " + map[m[4].toLowerCase()]; } },
  { id: "sv-singular",
    re: new RegExp("\\b(the\\s+)?((" + GRAMMAR_SINGULAR_NOUNS.join("|") + "))\\s+(are|were|have|do)\\b", "gi"),
    repl: function (m) { var map = { are: "is", were: "was", have: "has", do: "does" }; return (m[1] || "") + m[2] + " " + map[m[4].toLowerCase()]; } },
  // Pronoun-auxiliary agreement: he/she/it + have/do -> has/does; plural
  // pronouns + has/does -> have/do.
  { id: "pron-singular",
    re: /\b(he|she|it)\s+(have|do)\b/gi,
    guard: function (s, idx) {
      var pre = s.slice(0, idx).replace(/[""\u201C\u201D\u2018\u2019,;:!?()\[\]\d]+/g, " ").replace(/\s+/g, " ").trim();
      var tok = pre.split(/\s+/).pop() || "";
      return !!AUX_PRECEDER[tok.toLowerCase()];
    },
    repl: function (m) { return m[1] + " " + (m[2].toLowerCase() === "have" ? "has" : "does"); } },
  { id: "pron-plural",
    re: /\b(they|we|you|people|researchers|scholars|authors|writers)\s+(has|does)\b/gi,
    repl: function (m) { return m[1] + " " + (m[2].toLowerCase() === "has" ? "have" : "do"); } },
  // Doubled subject ("the study it shows" -> "the study shows"), only when a
  // finite verb follows immediately so legitimate relative clauses survive.
  { id: "doubled-subject",
    re: /\b(the\s+)?(study|analysis|approach|government|policy|system|process|findings|survey|research|work|text|chapter|article|paper|book|argument|field|model|project|report|section|paragraph|thesis|theory|strategy|programme|program|initiative|regime|state|country|army|force|coalition|alliance|company|team|department|school|court|council|committee|party|union|staff|faculty|society|economy|market|sector|industry)\s+(it|they)\s+(shows|show|reveals|reveal|demonstrates|demonstrate|highlights|highlight|is|are|was|were|has|have|concludes|conclude|argues|argue|explains|explain|provides|provide|illustrates|illustrate|suggests|suggest|indicates|indicate|claims|claim|asserts|assert|describes|describe|examines|examine|explores|explore|discusses|discuss|advances|advanced|advance|entered|enters|emerges|emerged|moves|moved|acts|acted|responds|responded|reacts|reacted|differs|differed|agrees|agreed|declines|declined|grows|grew|rises|rose|exerts|exerted|exercises|exercised|pursues|pursued|promotes|promoted|implements|implemented|launches|launched|conducts|conducted|opposes|opposed|resists|resisted|supports|supported|expands|expanded|extends|extended|mobilizes|mobilized|deploys|deployed|marches|marched|withdraws|withdrew|intervenes|intervened|escalates|escalated)\b/gi,
    repl: function (m) { return (m[1] || "") + m[2] + " " + m[4]; } },
];
// Governed-preposition pairs (wrong preposition -> the head verb's true
// complement). Universal collocations, not per-text patches.
var GRAMMAR_PREPOSITIONS = [
  { re: /\b(depend(?:s|ed|ing)?)\s+(?:of|in|with)\b/gi, good: function (m) { return m[1] + " on"; } },
  { re: /\brelevant\s+(?:for|with)\b/gi, good: function (m) { return "relevant to"; } },
  { re: /\bassociated\s+to\b/gi, good: function (m) { return "associated with"; } },
  { re: /\bcomposed\s+(?:by|with)\b/gi, good: function (m) { return "composed of"; } },
  { re: /\bsimilar\s+(?:with|than)\b/gi, good: function (m) { return "similar to"; } },
  { re: /\bdifferent\s+with\b/gi, good: function (m) { return "different from"; } },
  { re: /\bcontrary\s+(?:in|with|for|at)\b/gi, good: function (m) { return "contrary to"; } },
  { re: /\bwith\s+respect\s+for\b/gi, good: function (m) { return "with respect to"; } },
  { re: /\bcommitted\s+for\b/gi, good: function (m) { return "committed to"; } },
  { re: /\born\s+the\s+basis\s+of\b/gi, good: function (m) { return "on the basis of"; } },
  { re: /\bon\s+the\s+behalf\s+of\b/gi, good: function (m) { return "on behalf of"; } },
  { re: /\birregardless\b/gi, good: function (m) { return "regardless"; } },
  { re: /\b(could|should|would|must|might)\s+of\b/gi, good: function (m) { return m[1] + " have"; } },
  { re: /\bthe\s+reason\s+is\s+because\b/gi, good: function (m) { return "the reason is that"; } },
];
// Applies the grammar layer to a prose block; quote-safe, footnote lines must be
// excluded by the caller. Returns { text, fixes } so the SAME detector counts
// source vs revised defects for scoring (fully deterministic, provider-free).
function applyGrammarLayer(text) {
  if (!text) return { text: text || "", fixes: 0 };
  var fixes = 0;
  var out = replaceOutsideQuotes(String(text), function (seg) {
    var s = seg;
    for (var i = 0; i < GRAMMAR_RULES.length; i++) {
      var rule = GRAMMAR_RULES[i];
      var re = new RegExp(rule.re.source, rule.re.flags);
      var res;
      while ((res = re.exec(s)) !== null) {
        if (rule.guard && rule.guard(s, res.index)) { re.lastIndex = res.index + res[0].length; continue; }
        var rep = rule.repl(res);
        s = s.substring(0, res.index) + rep + s.substring(res.index + res[0].length);
        re.lastIndex = res.index + rep.length;
        fixes++;
      }
    }
    for (var j = 0; j < GRAMMAR_PREPOSITIONS.length; j++) {
      var pp = GRAMMAR_PREPOSITIONS[j];
      var pr = new RegExp(pp.re.source, pp.re.flags);
      while ((res = pr.exec(s)) !== null) {
        var good = String(typeof pp.good === "function" ? pp.good(res) : pp.good);
        if (/^[A-Z]/.test(res[0]) && !/^[A-Z]/.test(good)) good = good.charAt(0).toUpperCase() + good.slice(1);
        s = s.substring(0, res.index) + good + s.substring(res.index + res[0].length);
        pr.lastIndex = res.index + good.length;
        fixes++;
      }
    }
    return s;
  });
  return { text: out, fixes: fixes };
}

// --- Nativization is DATABASE-DRIVEN ONLY (two-pass contract) -----------------
// Pass 2 applies the three client DB families (ai-ese -> idioms -> domain
// lexical) as pure regex replacements; there are NO code-side nativization
// rules beyond the DB layer (no builtin word-swap maps, no slot-template
// families). A single-token entry needs an explicit SINGLE_WORD_ALLOW slot.
// applyDatabaseNativization below is the ONLY lexical pass.

// Deterministic enforcement layer: applies the exact DB replacements to each
// sentence (recap-safe via replaceOutsideQuotes, footnote/citation-safe) and
// reports honest statistics for the suggestions and score. This is the ONLY
// lexical pass — no built-in word-swap rules or template families exist.
function applyDatabaseNativization(sentences, dbs, domain) {
  var stats = { totalMatches: 0, sentencesChanged: 0, aiPhrases: 0, idioms: 0, lexical: 0 };
  var maps = dbs && typeof dbs === "object" ? buildNativizationMaps(dbs, domain) : buildNativizationMaps({}, domain);
  if (!sentences || !sentences.length) return { sentences: sentences || [], stats: stats };

  function bump(matchKind) {
    stats.totalMatches++;
    if (matchKind === "ai") stats.aiPhrases++;
    else if (matchKind === "idioms") stats.idioms++;
    else if (matchKind === "lexical") stats.lexical++;
  }

  sentences.forEach(function (s) {
    if (!s || !s.revised) return;
    var orig = (s.original || "").trim();
    // Skip only ACTUAL footnote/citation lines, not body prose that merely
    // begins with an inline reference marker ("[1] This approach is better
    // suited for analysing..." must still be nativized). A line counts as a
    // citation only when it STARTS with a [N] marker (or is already flagged
    // isImmutableFootnote) and, with that marker stripped, is author-year
    // shaped, an "Ibid.", or carries a URL/DOI. Body prose that merely
    // contains book years like "The Woman Warrior (1976)" is NOT a citation.
    var hasMarker = /^\[\d+\]/.test(orig);
    var stripped = orig.replace(/^\s*\[\d+\]\s*/, "");
    var isCitation = hasMarker && stripped.length > 0 && (
      /^\s*Ibid\.?(\s|$)/i.test(stripped) ||
      /^[A-Z][^?!\n]*\(\d{4}\)/.test(stripped) ||
      /https?:\/\//i.test(stripped) ||
      /\bDOI\b/i.test(stripped)
    );
    if (s.isImmutableFootnote || isCitation || /^".*"$/.test(s.revised.trim())) return;

    var baseline = s.revised;
    var changedHere = false;

    // 1) Whole-sentence mappings (lexical/idiom full-sentence entries).
    var sentKey = normalizeSentenceKey(orig);
    var sentEntry = maps.sentenceMap[sentKey];
    if (sentEntry && sentKey.length >= 8 && /[A-Za-z]/.test(sentKey)) {
      s.revised = sentEntry.tgt;
      bump(sentEntry.cat);
      changedHere = true;
    }

    // 2) Phrase-level, word-boundary exact, quote-safe replacements.
    if (!/^".*"$/.test(s.revised.trim())) {
      var phraseRx = [];
      for (var i = 0; i < maps.phraseList.length; i++) {
        var p = maps.phraseList[i];
        phraseRx.push({ src: escapeRegExp(p.src), tgt: p.tgt, cat: p.cat, len: p.src.length });
      }
      s.revised = replaceOutsideQuotes(s.revised, function (seg) {
        var out = seg;
        for (var j = 0; j < phraseRx.length; j++) {
          var item = phraseRx[j];
          var re = new RegExp("\\b" + item.src + "\\b", "gi");
          var res;
          while ((res = re.exec(out)) !== null) {
            // Correlative safety: skip the swap when this phrase's partner (e.g.
            // "in general" vs "in particular") is present in the same sentence.
            if (isCollocationLocked(out, item.src)) { re.lastIndex = res.index + res[0].length; continue; }
            var prefix = out.slice(0, res.index);
            var atStart = prefix.trim() === "" || /[.!?]["'\u201D\u2019]?\s+$/.test(prefix) || /\n\s*$/.test(prefix) || /\]\s+$/.test(prefix);
            var cap = res[0].charAt(0) === res[0].charAt(0).toUpperCase() && res[0].charAt(0) !== res[0].charAt(0).toLowerCase();
            var tgt = cap && atStart ? item.tgt.charAt(0).toUpperCase() + item.tgt.slice(1) : item.tgt;
            out = out.substring(0, res.index) + tgt + out.substring(res.index + res[0].length);
            re.lastIndex = res.index + tgt.length;
            bump(item.cat);
            changedHere = true;
          }
        }
        return out;
      });
    }

    if (changedHere) stats.sentencesChanged++;
  });

  return { sentences: sentences, stats: stats };
}

// Phase-C source-first sweep: applies the deterministic DB nativization rules to
// the raw SOURCE text BEFORE the grammar model sees it (Pipeline: DB sweep on
// source -> grammar pass -> gated humanize). Treating the whole body as one
// unit keeps phrase-level word-boundary swaps quote-safe and citation-gated
// exactly as the sentence-level backstop does; whole-sentence map entries
// cannot match a multi-sentence body, which is correct (they fire later on the
// derived sentence units). Honors paragraph structure so the reassembled text
// still contains the original \n\n breaks for normalizeTitleBreaks / scoring.
function nativizeSourceText(text, dbs, domain) {
  var ZERO = { totalMatches: 0, sentencesChanged: 0, aiPhrases: 0, idioms: 0, lexical: 0 };
  if (!text || !String(text).trim()) return { text: String(text || ""), stats: ZERO };
  var units = [{ original: String(text), revised: String(text), isImmutableFootnote: false }];
  var applied = applyDatabaseNativization(units, dbs, domain);
  return { text: applied.sentences[0].revised, stats: applied.stats };
}

// Function words excluded from semantic-fidelity / dropped-content analysis
// (deliberately NOT including "very"/"one" — a tightening that silently drops
// those may be worth surfacing).
var SEMANTIC_FUNCTION_WORDS = {
  a:1, an:1, the:1, and:1, or:1, but:1, nor:1, of:1, in:1, on:1, at:1, to:1,
  for:1, by:1, with:1, from:1, between:1, through:1, within:1, without:1,
  into:1, upon:1, under:1, over:1, across:1, among:1, around:1, against:1,
  beyond:1, during:1, after:1, before:1, toward:1, towards:1, inside:1,
  outside:1, below:1, above:1, that:1, this:1, these:1, those:1, it:1, its:1,
  is:1, are:1, was:1, were:1, be:1, been:1, being:1, has:1, have:1, had:1,
  do:1, does:1, did:1, will:1, would:1, can:1, could:1, shall:1, should:1,
  may:1, might:1, must:1, as:1, also:1, than:1, then:1, more:1, most:1,
  such:1, so:1, while:1, when:1, where:1, which:1, who:1, whom:1, there:1,
  here:1, they:1, their:1, them:1, we:1, our:1, you:1, your:1, i:1, he:1,
  she:1, his:1, her:1, me:1, us:1, my:1, s:1, t:1, d:1, ll:1, ve:1, re:1,
  cant:1, dont:1, doesnt:1, didnt:1, couldnt:1, shouldnt:1, wouldnt:1,
  isnt:1, arent:1, wasnt:1, werent:1, wont:1, hasnt:1, havent:1, hadnt:1,
  thats:1, theres:1, heres:1, wheres:1, whos:1, whats:1, lets:1, youd:1,
  youll:1, youve:1, ofcourse:1, well:1, even:1, just:1, still:1
};

// Semantic-fidelity guard: flags sentences whose REVISED wording may have
// inverted the author's meaning. Two deterministic signals:
//   - "negation": a negation was inserted or removed while most words survived
//     ("It is not expensive." -> "It is expensive.").
//   - "inversion": a negation persists, the content tokens are nearly the same,
//     but a shared key token jumped from one end of the sentence to the other
//     ("they are NOT the primary focus of technology" -> "technology is not
//     their primary focus").
// Flagged sentences earn NO score bump and get a review note in the Notes tab.
function detectSemanticRisk(sentences) {
  var NEG = /\b(?:not|no|never|none|nothing|nobody|nowhere|neither|nor|without|hardly|barely|scarcely|rarely|seldom|cannot|can't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|wouldn't|couldn't|shouldn't)\b/i;
  function tokens(t) {
    return String(t || "").replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/[^a-z'\s]/g, " ").split(/\s+/)
      .filter(function (w) {
        var k = w.replace(/'/g, "");
        return k.length >= 3 && !SEMANTIC_FUNCTION_WORDS[k];
      })
      .map(function (w) { return w.replace(/'/g, ""); });
  }
  function diffMag(a, b) {
    var counts = {};
    var diff = 0;
    a.forEach(function (w) { counts[w] = (counts[w] || 0) + 1; });
    b.forEach(function (w) { if (counts[w] > 0) counts[w]--; else diff++; });
    Object.keys(counts).forEach(function (w) { diff += counts[w]; });
    return diff;
  }
  function sharedStats(a, b) {
    var bSet = {};
    b.forEach(function (w) { bSet[w] = (bSet[w] || 0) + 1; });
    var aSeen = {};
    var uniq = [];
    var shared = 0;
    a.forEach(function (w) { aSeen[w] = (aSeen[w] || 0) + 1; });
    a.forEach(function (w) {
      if (bSet[w] > 0) {
        shared += Math.min(aSeen[w], bSet[w]);
        if (!aSeen[w + "_unit"]) { aSeen[w + "_unit"] = 1; uniq.push(w); }
      }
    });
    return { shared: shared, uniq: uniq };
  }
  var risks = {};
  sentences.forEach(function (s, si) {
    var o = (s.original || "").trim();
    var r = (s.revised || "").trim();
    if (!o || !r || o === r) return;
    if (s.isImmutableFootnote || /^\[\d+\]/.test(o) || /^\s*Ibid\.?/i.test(o)) return;
    var ot = tokens(o);
    var rt = tokens(r);
    if (ot.length < 2 || rt.length < 2) return;
    var negO = NEG.test(o);
    var negR = NEG.test(r);
    var mag = diffMag(ot, rt);
    if (negO !== negR && mag <= 6) {
      var st = sharedStats(ot, rt);
      if (st.shared / Math.min(ot.length, rt.length) >= 0.5) {
        risks[si] = { kind: "negation", detail: negO && !negR ? "a 'not/no/never' negation was removed" : "a negation was introduced" };
        return;
      }
    }
    if (negO && negR && mag <= 5) {
      var st2 = sharedStats(ot, rt);
      if (st2.uniq.length >= 3) {
        var sharedMap = {};
        st2.uniq.forEach(function (w) { sharedMap[w] = 1; });
        var oOrder = ot.filter(function (w) { return sharedMap[w]; });
        var rOrder = rt.filter(function (w) { return sharedMap[w]; });
        var firstO = oOrder[0], lastO = oOrder[oOrder.length - 1];
        var firstR = rOrder[0], lastR = rOrder[rOrder.length - 1];
        if ((firstR === lastO && lastR === firstO) || firstR === lastO || lastR === firstO) {
          risks[si] = { kind: "inversion", detail: "the subject/object wording swapped around a negation — meaning may be flipped" };
        }
      }
    }
  });
  return risks;
}

// Content words from the SOURCE (len>=4, non-stopword) that vanish entirely
// from the final text. Words consumed by a FIRED DB nativization rule are
// intentionally removable and never flagged, so "prior to" -> "before" stays
// silent while un-credited tightening drops like "today" / "registered" get
// surfaced as a review note.
function droppedContentWords(originalText, finalText, options) {
  function addKeys(set, phrase) {
    String(phrase || "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z\s]/g, " ").split(/\s+/).forEach(function (t) {
      var k = t.replace(/'/g, "");
      if (k && k.length >= 3 && !SEMANTIC_FUNCTION_WORDS[k]) set[k] = 1;
    });
  }
  // Normalize a raw token into its base word(s): the possessive "SPPAIS’s" yields
  // base "sppais" (plus the detached "'s"), so a surviving "SPPAIS" in the final
  // text technically still contains the word and is NOT a dropped content word.
  function baseKeys(raw) {
    return String(raw || "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/'/g, " ").replace(/[^a-z\s]/g, " ").split(/\s+/)
      .filter(function (t) { return t.length >= 4 && !SEMANTIC_FUNCTION_WORDS[t]; });
  }
  function finalHas(k) {
    if (finalTokenSet[k]) return true;
    // Morphological tolerance: accept an inflected/derived relative so a word
    // that only changed form is not a drop. Exact equality is handled above;
    // here we accept any final token sharing a common prefix of >= 3 chars
    // with the source key ("guiding" ~ "guide" share "guid"; "come" ~ "coming"
    // share "com").
    if (k.length >= 4) {
      for (var i = 0; i < finalTokens.length; i++) {
        var t = finalTokens[i];
        if (t.length < 4) continue;
        var n = t.length < k.length ? t.length : k.length;
        var p = 0;
        while (p < n && t.charCodeAt(p) === k.charCodeAt(p)) p++;
        if (p >= 3) return true;
      }
    }
    return false;
  }
  var allowed = {};
  try {
    var maps = buildNativizationMaps((options && options.databases) || {}, (options && options.domain) || "general");
    if (maps && maps.phraseList) {
      maps.phraseList.forEach(function (p) {
        var re = new RegExp("\\b" + p.src + "\\b", "gi");
        var pm;
        while ((pm = re.exec(originalText)) !== null) addKeys(allowed, pm[0]);
      });
    }
  } catch (e) { /* DB phrase maps are optional */ }
  // Normalize the FINAL text the same way the source is normalized: strip every
  // non-letter down to whitespace so "AI-powered" becomes "ai powered" and the
  // standalone key "powered" can match (previously the hyphen blocked the match
  // and "powered" was falsely flagged as dropped).
  var finalNorm = " " + String(finalText || "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z]+/g, " ") + " ";
  var finalTokens = finalNorm.split(/\s+/).filter(Boolean);
  var finalTokenSet = {};
  finalTokens.forEach(function (t) { finalTokenSet[t] = 1; });
  var out = [];
  var seen = {};
  String(originalText || "").split(/\s+/).forEach(function (raw) {
    baseKeys(raw).forEach(function (k) {
      if (seen[k] || allowed[k]) return;
      seen[k] = 1;
      if (!finalHas(k)) out.push(k);
    });
  });
  // Longer words are more likely substantive content, so surface the genuine
  // losses ("registered") ahead of short intensifier-like deletions ("very"),
  // and let 8 items show instead of truncating the real drops at 6.
  out.sort(function (a, b) { return b.length - a.length; });
  return out.length > 8 ? out.slice(0, 8) : out;
}

// Mirror of droppedContentWords: open-class words that appear in the FINAL text
// but nowhere in the source. The model sometimes invents detail ("moral
// considerations", "stakeholder buy-in") that the author never wrote; those are
// surfaced as an advisory note (NOT auto-reverted) so the author can confirm the
// added detail is intended. Words introduced by the deterministic nativization
// layer (a built-in rule or a DB phrase that matched the source) are excluded,
// so legit "firms ups" never get flagged.
function addedContentWords(originalText, finalText, options) {
  function addKeys(set, phrase) {
    String(phrase || "").split(/\s+/).forEach(function (p) {
      if (p && p.length >= 3) set[p.toLowerCase().replace(/[^a-z]+/g, "")] = 1;
    });
  }
  function baseKeys(raw) {
    return String(raw || "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z']/g, " ")
      .split(/\s+/).map(function (t) { return t.replace(/'/g, ""); })
      .filter(function (t) { return t.length >= 4 && !SEMANTIC_FUNCTION_WORDS[t]; });
  }
  // Words the deterministic nativization layer is allowed to introduce: any
  // replacement word from a DB phrase that MATCHED the source.
  var allowed = {};
  try {
    var maps = buildNativizationMaps((options && options.databases) || {}, (options && options.domain) || "general");
    if (maps && maps.phraseList) {
      maps.phraseList.forEach(function (p) {
        if (!p || !p.src) return;
        var rePh = new RegExp("\\b" + p.src + "\\b", "gi");
        var pm, phMatched = 0;
        while ((pm = rePh.exec(originalText)) !== null && phMatched < 10) { phMatched++; addKeys(allowed, p.tgt || p.dst); }
      });
    }
  } catch (e) { /* DB phrase maps are optional */ }
  var origNorm = " " + String(originalText || "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z]+/g, " ") + " ";
  var origTokens = origNorm.split(/\s+/).filter(Boolean);
  var origTokensSet = {};
  origTokens.forEach(function (t) { origTokensSet[t] = 1; });
  var out = [];
  var seen = {};
  String(finalText || "").split(/\s+/).forEach(function (raw) {
    baseKeys(raw).forEach(function (k) {
      if (seen[k] || allowed[k]) return;
      seen[k] = 1;
      if (origTokensSet[k]) return;
      // Morphological tolerance: "considerations" next to source "consideration"
      // (added word is a prefix of a source token) or the reverse (prefix of the
      // added word is a source token) is a form of the author's word, not an
      // invention. New words sharing only a 3-letter stub are still flagged.
      var hit = false;
      for (var j = k.length; j >= 3; j--) {
        if (origTokensSet[k.slice(0, j)]) { hit = true; break; }
      }
      if (!hit) {
        for (var t = 0; t < origTokens.length; t++) {
          var ot = origTokens[t];
          if (ot.length > k.length && ot.slice(0, k.length) === k) { hit = true; break; }
        }
      }
      if (!hit) out.push(k);
    });
  });
  out.sort(function (a, b) { return b.length - a.length; });
  return out.length > 8 ? out.slice(0, 8) : out;
}

// Shared stiffness scanner used by findStiffestSentence, the stiffest-note gate
// (hasDealtWithStiffness) and the score measurement — ONE rule set, ONE matcher,
// three consumers, so none of them can drift apart. Only multi-character ai-phase
// candidates participate from the database phrase list. Quote CHARACTERS are
// blanked exactly like the current detection contract (matching quoted text
// counts as stiff, but the apply layer never rewrites inside quotes). Each
// DISTINCT rule credits once (longest first, so a longer phrase beats its
// nested fragment). Returns { keys, count } where keys are the matched rule
// identities (aiDb phrases) and count is the word-displacement surrogate used
// by ranking and scoring (aiDb phrases weigh their word count).
function scanStiffPhrases(text, maps) {
  var out = { keys: [], count: 0 };
  if (!text) return out;
  var aiRules = [];
  for (var i = 0; i < maps.phraseList.length; i++) {
    var p = maps.phraseList[i];
    if (p.cat === "ai" && p.src.length >= 4) aiRules.push(p.src);
  }
  aiRules.sort(function (a, b) { return b.split(/\s+/).length - a.split(/\s+/).length; });
  var matched = {};
  var t = " " + String(text).replace(/\s+/g, " ").replace(/[""\u201C\u201D]+/g, " ") + " ";
  for (var r = 0; r < aiRules.length; r++) {
    var ph = aiRules[r];
    if (matched[ph]) continue;
    var re = new RegExp("\\b" + escapeRegExp(ph).split(/\s+/).join("\\s+") + "\\b", "i");
    if (re.test(t)) {
      matched[ph] = 1;
      out.keys.push(ph);
      out.count += (ph.match(/[^\s]+/g) || []).length;
    }
  }
  return out;
}

// Coverage-census watchlist (diagnostic only, never applied as edits): common
// stiff/non-native patterns observed across academic, business and general text
// that are too voice- or context-dependent to auto-rewrite safely. The census
// reports "present but not covered by any rule" so a quiet run reads as an
// explainable coverage reading instead of a silent shrug. Entries here must NOT
// overlap entries shipping in the aiDb / public databases (they would be double
// counted; the census already skips any watch item a matched rule covers).
var COVERAGE_WATCHLIST = [
  "the mere fact that",
  "more likely to break than not",
  "in whose neighbourhood",
  "such a common denominator",
  "is occasioned by",
  "do not want to hear",
  "looking forward to receive"
];

// Detector-only lexicon for the GATED humanize pass (Phase C). These are the
// generic AI-ese / non-native / formulaic markers that the deterministic DB
// layers (aiDb + public databases) do NOT reliably cover or that can survive
// the DB backstop in partial form. It is NEVER applied as an edit — it only
// decides which residual-stiff sentences get sent to the humanize model pass.
// Running it on the REVISED text means any marker a DB rule already removed is
// invisible here, so gating stays honest about what is still stiff.
var HUMANIZE_DETECTOR = [
  /delve\s+into\b/i,
  /\bin\s+today['\u2019]s\b/i,
  /\bfast[- ]paced\s+world\b/i,
  /\bplays?\s+a\s+pivotal\s+role\b/i,
  /\bunderscores?\b/i,
  /\bin\s+a\s+bid\s+to\b/i,
  /\bwhen\s+it\s+comes\s+to\b/i,
  /\bit\s+is\s+worth\s+(mentioning|noting)\b/i,
  /\bit\s+is\s+important\s+to\s+(note|mention|highlight)\b/i,
  /\bit\s+should\s+be\s+noted\b/i,
  /\bit\s+goes\s+without\s+saying\b/i,
  /\bthe\s+bottom\s+line\s+is\b/i,
  /\bat\s+the\s+end\s+of\s+the\s+day\b/i,
  /\bin\s+this\s+(fast\s+-?\s*)?(ever[- ])?changing\s+(world|landscape)\b/i,
  /\ba\s+plethora\s+of\b/i,
  /\btapestry\s+of\b/i,
  /\bnavigate\s+(the\s+)?(complex|complexities|challenges)\b/i,
  /\bleverage\b/i,
  /\butilize\b/i,
  /\boptimal\b/i,
  /\bholistic\b/i,
  /\bparadigm\b/i,
  /\bfacilitate\b/i
];
function detectHumanizeMarkers(text) {
  if (!text) return 0;
  var n = 0;
  for (var i = 0; i < HUMANIZE_DETECTOR.length; i++) {
    if (HUMANIZE_DETECTOR[i].test(text)) n++;
  }
  return n;
}

// Content-overlap guard used to reject a humanize rewrite that dropped or
// invented facts (returning only the fraction of content words shared).
function contentOverlapRatio(a, b) {
  var norm = function (t) { return String(t || "").replace(/\*\*/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim().split(" "); };
  var wa = norm(a).filter(Boolean);
  var wb = norm(b).filter(Boolean);
  if (!wa.length || !wb.length) return a === b ? 1 : 0;
  var count = {};
  var shared = 0;
  for (var i = 0; i < wa.length; i++) count[wa[i]] = (count[wa[i]] || 0) + 1;
  for (var j = 0; j < wb.length; j++) {
    if (count[wb[j]]) { shared++; count[wb[j]]--; }
  }
  return shared / Math.min(wa.length, wb.length);
}

// Heading-shaped check shared by the gated humanize pass (mirrors the
// deriveHeaderPara/isHeadingPara logic: short, capital-initial, no terminal
// sentence punctuation, not a footnote marker).
function isHeadingShapedText(t) {
  var s = String(t || "").trim().replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
  return s.length > 0 && s.length < 120 && /^[A-Z]/.test(s) && !/[.!?]$/.test(s) && !/^\[\d+\]/.test(s);
}

// Identifies the single "stiffest" source sentence: the one carrying the most
// formulaic / AI-sounding phrasing (aiDb AI-ese entries PLUS the builtin
// nativization sources). Score = total rule word-displacement (see
// scanStiffPhrases), so a sentence crowded with long stiff phrases ranks above
// one with a single short hit. Only prose counts (footnotes/citations excluded).
// Returns { index, score, phraseCount, textLen } or null when nothing stiff was
// found.
function findStiffestSentence(sentences, options) {
  if (!Array.isArray(sentences)) return null;
  var maps = buildNativizationMaps((options && options.databases) || {}, (options && options.domain) || "general");
  var best = null;
  for (var si = 0; si < sentences.length; si++) {
    var s = sentences[si];
    if (!s || s.isImmutableFootnote || /^\[\d+\]/.test((s.original || "").trim()) || /^\s*Ibid\.?/i.test((s.original || "").trim())) continue;
    var text = " " + String(s.original || "").replace(/\s+/g, " ").replace(/[""\u201C\u201D]+/g, " ") + " ";
    var prof = scanStiffPhrases(text, maps);
    if (prof.count === 0) continue;
    if (!best || prof.count > best.score || (prof.count === best.score && text.length > best.textLen)) {
      best = { index: si, score: prof.count, phraseCount: prof.keys.length, textLen: text.length };
    }
  }
  return best;
}

// The stiffest-sentence note must not be silenced by an unrelated edit: a
// sentence is "handled" only when EVERY nativization rule that matched its
// SOURCE text is also gone from its REVISED text. A grammar-only fix that leaves
// the stiff phrasing behind (e.g. 'Despite of ... went ahead with' ->
// 'Despite ... went ahead with', where the awkward phrase survives the grammar
// fix) still deserves the note.
function hasDealtWithStiffness(original, revised, options) {
  var maps = buildNativizationMaps((options && options.databases) || {}, (options && options.domain) || "general");
  var srcKeys = scanStiffPhrases(String(original || ""), maps).keys;
  if (srcKeys.length === 0) return true;
  var revKeys = scanStiffPhrases(String(revised || ""), maps).keys;
  for (var i = 0; i < srcKeys.length; i++) {
    if (revKeys.indexOf(srcKeys[i]) !== -1) return false;
  }
  return true;
}

// Does this sentence's revision contain a REAL content change (vs a cosmetic
// case/punctuation/citation-marker/quote-only flip)? Mirrors the scoring loop's
// unchanged/real-change rules so the stiffest-sentence note never contradicts
// the score.
function hasRealSentenceChange(original, revised) {
  function stripQuotesLike(t) {
    return String(t || "").replace(/[""\u201C\u201D\u2018\u2019][^""\u201C\u201D\u2018\u2019]*[""\u201C\u201D\u2018\u2019]/g, " ");
  }
  var before = String(original || "").trim().replace(/\s+/g, " ");
  var after = String(revised || "").trim().replace(/\s+/g, " ");
  var o = before.toLowerCase();
  var r = after.toLowerCase();
  if (!/[a-z]/.test(o) || !/[a-z]/.test(r)) return false;
  if (o === r) {
    // Case-only flip counts ONLY as a real fix when the source literally began
    // with a lowercase letter (genuine capitalization error).
    return /(?:^|[.!?]\s+)[a-z]/.test(before);
  }
  if (stripQuotesLike(o).replace(/\s+/g, " ").trim() === stripQuotesLike(r).replace(/\s+/g, " ").trim()) return false;
  if (contentTokenSeq(before) === contentTokenSeq(after)) return false;
  return true;
}

// How many prose sentences does the SOURCE actually have? Used to reconcile the
// diagnostics count ("11 improved + 4 preserved" vs the real 14-sentence input)
// when the alignment step re-segments the model output.
function countSourceSentences(text) {
  if (!text) return 0;
  var paras = String(text).split(/\n{2,}/).filter(function (p) { return p.trim().length > 0; });
  var n = 0;
  for (var i = 0; i < paras.length; i++) {
    var p = paras[i].trim();
    if (/^\[\d+\]/.test(p) || /^\s*Ibid\.?/i.test(p)) continue;
    n += p.split(/(?<=[.!?])\s+(?!\[\d+\])/).filter(function (s) { return s.trim().length > 0; }).length;
  }
  return n;
}

// Gated nativize/humanize pass (Phase C, stage 3 of the pipeline):
// source-first DB sweep -> grammar pass -> HERE (residual-stiff sentences only).
// A sentence is flagged for the humanize model call only when, after the
// deterministic DB backstop, it STILL carries stiff/AI-ese diction the DB layer
// does not cover (deterministic detector), is prose (not a footnote, a
// quote-only line, or a heading), and is within a sane length band. Flagged =
// bounded edit surface; everything else is untouched, so the author's voice is
// preserved by construction. Offline / no-key runs skip the model call entirely
// (fully deterministic) and report skippedReason so the UI can be honest.
// Rewrites are content-overlap guarded and re-routed through the protective
// passes so meaningful content, quotes, idioms and footnotes survive.
var HUMANIZE_MAX_SENTENCES = 12;
var HUMANIZE_MIN_LEN = 40;
var HUMANIZE_MAX_LEN = 360;

async function humanizeFlaggedSentences(sentences, options, env) {
  var out = { sentences: sentences, changed: 0, flagged: 0, skippedReason: null };
  if (!env || !env.GEMINI_API_KEY) {
    out.skippedReason = "no-api-key";
    return out;
  }
  if (!sentences || !sentences.length) {
    out.skippedReason = "empty";
    return out;
  }
  var domain = (options && options.domain) || "general";
  var maps = buildNativizationMaps((options && options.databases) || {}, domain);
  var flaggedIdx = [];
  for (var i = 0; i < sentences.length; i++) {
    var s = sentences[i];
    if (!s || s.isImmutableFootnote) continue;
    var orig = String(s.original || "").trim();
    var rev = String(s.revised || "").trim();
    if (!rev || rev.length < HUMANIZE_MIN_LEN || rev.length > HUMANIZE_MAX_LEN) continue;
    if (/\*\*/.test(rev) || /\*\*/.test(orig)) continue;
    if (/^\[\d+\]/.test(orig) || /^\s*Ibid\.?/i.test(orig)) continue;
    if (isHeadingShapedText(orig) || isHeadingShapedText(rev)) continue;
    if (/^["\u201C\u201D].*["\u201C\u201D]$/.test(rev) || /^["\u201C\u201D].*["\u201C\u201D]$/.test(orig)) continue;
    var residual = scanStiffPhrases(rev, maps);
    var generic = detectHumanizeMarkers(rev);
    if (residual.count === 0 && generic === 0) continue;
    flaggedIdx.push(i);
    if (flaggedIdx.length >= HUMANIZE_MAX_SENTENCES) break;
  }
  out.flagged = flaggedIdx.length;
  if (flaggedIdx.length === 0) {
    out.skippedReason = "nothing-flagged";
    return out;
  }

  var pairs = flaggedIdx.map(function (i, k) {
    return { index: k, original: String(sentences[i].revised || "") };
  });
  try {
    var raw = await callGeminiNativize(pairs, options, env.GEMINI_API_KEY);
    var gparsed = parseJsonFromModel(raw);
    var revisions = gparsed && Array.isArray(gparsed.revisions) ? gparsed.revisions : null;
    if (!revisions && gparsed && Array.isArray(gparsed.revised)) revisions = gparsed.revised;
    if (!revisions && gparsed && Array.isArray(gparsed.sentences)) revisions = gparsed.sentences;
    if (revisions && revisions.length > 0) {
      for (var r = 0; r < revisions.length; r++) {
        var rv = revisions[r];
        var ridx = rv && rv.index != null ? Number(rv.index) : r;
        if (isNaN(ridx) || ridx < 0 || ridx >= flaggedIdx.length) continue;
        var newText = typeof rv.revised === "string" ? rv.revised.trim() : "";
        if (!newText || newText === "[object Object]") continue;
        var targetIdx = flaggedIdx[ridx];
        var target = sentences[targetIdx];
        if (!target) continue;
        if (contentOverlapRatio(String(target.revised || ""), newText) < 0.4) continue;
        newText = postProcessText(newText);
        newText = protectQuotes(String(target.original || ""), newText);
        newText = protectInvariantIdioms(String(target.original || ""), newText);
        newText = restoreDroppedSentence(String(target.original || ""), newText);
        newText = restoreCurlyApostrophes(String(target.original || ""), newText);
        newText = fixCommonMisspellingsSafe(newText);
        newText = capitalizeEnhanced(newText);
        if (!newText || newText === String(target.revised || "")) continue;
        target.revised = newText;
        out.changed++;
      }
    } else {
      out.skippedReason = "unparseable-revisions";
    }
  } catch (e) {
    out.skippedReason = "humanize-error";
    console.error("humanize pass failed (non-fatal): " + String((e && e.message) || e).substring(0, 300));
  }
  return out;
}

async function ensureValidResult(parsed, originalText, options, env) {
  if (!parsed || typeof parsed !== "object") return null;

  var finalVersion = parsed.finalVersion || parsed.final || parsed.text || "";
  if ((!finalVersion || finalVersion.length < 10) && Array.isArray(parsed.sentences) && parsed.sentences.length > 0) {
    finalVersion = parsed.sentences
      .filter(function (s) { return !!s; })
      .map(function(s) { return s.revised || s.native || s.original || s.source || ""; })
      .filter(function(s) { return s.length > 0; })
      .join(" ");
  }
  if (!finalVersion || finalVersion.length < 10) finalVersion = originalText;
  if (!finalVersion || finalVersion.length < 10) return null;

  // Post-process finalVersion
  finalVersion = postProcessText(finalVersion);

  // Re-insert paragraph breaks from original structure (Gemini strips them)
  finalVersion = reinsertParagraphBreaks(originalText, finalVersion);

  // Normalize single newlines between paragraphs to double newlines
  // A paragraph break is: a newline preceded by sentence-ending punctuation or heading-like text
  finalVersion = finalVersion.replace(/([.!?\u201D\u2019"\u2018\u2019\)])(\n)(?=[A-Z\u201C\u2018])/g, "$1\n\n");
  // Collapse 3+ newlines to double
  finalVersion = finalVersion.replace(/\n{3,}/g, "\n\n");
  // Fix split bold titles that got broken across \n\n (join any **...** that spans \n\n)
  if (finalVersion.startsWith("**Chapter")) {
    var closeIdx = finalVersion.indexOf("**", 2);
    if (closeIdx !== -1) {
      var titleBlock = finalVersion.substring(0, closeIdx + 2);
      if (titleBlock.indexOf("\n") !== -1) {
        var fixedTitle = "**" + titleBlock.replace(/\*\*/g, "").replace(/\s+/g, " ").trim() + "**";
        finalVersion = fixedTitle + finalVersion.substring(closeIdx + 2);
      }
    }
  }
  // Also join any remaining split bold title (generic)
  finalVersion = finalVersion.replace(/\*\*([^\n]*?)\n\n([^\n]*?\*\*)/g, function(m, p1, p2){
    // Gate: only join a split bold heading when the SECOND span is itself
    // heading-shaped. A full sentence (e.g. "**Conclusion**\n\nThis chapter
    // serves as the backdrop for this thesis.**<something>") must never be
    // welded onto the title — that produced "Conclusion** This chapter...".
    if (!headingShapedText(p2)) return m;
    return "**" + (p1 + p2).replace(/\*\*/g, "").replace(/\s+/g, " ").trim() + "**";
  });
  // Fix concatenated bold headings with no break (e.g., "**Chapter...**Introduction**" -> two paras)
  finalVersion = finalVersion.replace(/(\*\*[^*]+\*\*)\s*(?=\*\*[A-Z])/g, "$1\n\n");
  // Also fix case where second heading lost its opening ** (e.g., "**Chapter...**Introduction**" without opening on second)
  finalVersion = finalVersion.replace(/(\*\*[^*]+\*\*)([A-Z][a-z]+[^*]*\*\*)/g, function(m, p1, p2){
    var inner = p2.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
    if(inner.length < 80 && !/[.!?]$/.test(inner) && headingShapedText(p2)){
      return p1 + "\n\n**" + inner + "**";
    }
    return m;
  });
  // Fix single-newline between headings (e.g., "**Introduction**\nCore puzzle" -> two bold paras)
  finalVersion = finalVersion.replace(/(\*\*[^*]+\*\*)\n([A-Z][^\n]{1,80})\n/g, function(m, p1, p2){
    var t=p2.trim();
    if(t.length<80 && !/[.!?]$/.test(t) && !/^\[\d+\]/.test(t) && headingShapedText(t)){
      return p1 + "\n\n**" + t + "**\n";
    }
    return m;
  });
  // Re-bold headings the model stripped (text-agnostic, same as normalizeTitleBreaks)
  (function(){
    var cw = /\b(of|the|and|or|but|in|on|at|to|for|with|from|by|that|this|a|an|is|are|was|were|has|have|had|it|its|as|be|being|been|not|also|than|more|most|such|do|does|did|will|would|can|could|should|may|might|shall|if|then|so|no|yes|however|therefore|moreover|furthermore|consequently|thus|indeed|further|meanwhile|otherwise|instead|nevertheless|nonetheless|hence|accordingly|likewise|similarly|conversely|alternatively)\s*$/i;
    finalVersion = finalVersion.split("\n\n").map(function(para){
      var t=para.trim();
      var clean = t.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
      if(clean.length>0 && clean.length<80 && !/[.!?]$/.test(clean) && !/[,;:?!]$/.test(clean) && !/[)\]]["\u201D\u2019]?\s*$/.test(clean) && !cw.test(clean) && /^[A-Z]/.test(clean) && !/^\[\d+\]/.test(clean) && !/^\([A-Z]/.test(clean)){
        if(t === "**"+clean+"**") return para;
        return "**"+clean+"**";
      }
      return para;
    }).join("\n\n");
  })();

  // Footnote handling is made idempotent: footnotes are extracted from the
  // ORIGINAL, kept out of the model body, stripped from any model/hallucinated
  // output, and appended EXACTLY ONCE after the final rebuild (below). A page
  // therefore never shows the reference block twice, which was inflating the
  // displayed word count and corrupting the output.
  var savedFootnotes = parsed._originalFootnotes || "";
  // Original text WITHOUT the footnote block, used as the paragraph skeleton so
  // rebuildFinalVersion never re-emits footnotes as body paragraphs.
  var bodyOnlyOriginal = originalText;
  if (savedFootnotes) {
    var extractedFoot = extractFootnoteBlock(finalVersion);
    if (extractedFoot.footnotes) {
      finalVersion = extractedFoot.body;
    }
    finalVersion = normalizeFootnoteRefs(finalVersion);
    // Normalize footnote separation for the single append at the end.
    var normalizedFootnotes = savedFootnotes.replace(/\r?\n(?=\[\d+\])/g, "\n\n").replace(/\r?\n(?=\s*Ibid)/gi, "\n\n");
    // Recompute the body-only original (strip the trailing footnote block).
    var origFoot = extractFootnoteBlock(originalText);
    bodyOnlyOriginal = normalizeFootnoteRefs(origFoot.body || originalText);
    // Headings the user typed WITHOUT a blank line ("Literature Review\nWith this...")
    // must still be promoted to their own paragraph, so the derive/rebuild steps
    // treat them as standalone elements instead of welding them onto the body
    // sentence (which previously DROPPED the heading from the output).
    bodyOnlyOriginal = normalizeTitleBreaks(bodyOnlyOriginal);
    // Re-strip any footnotes the model echoed inside the body (defensive).
    finalVersion = finalVersion.split(normalizedFootnotes.trim()).filter(function (p) { return p && p.trim(); }).join("\n\n");
  }

  // No-shorten guard for overall text (correct, don't bridge). Compare against
  // the BODY-ONLY original (the model never receives the footnote block), so
  // footnote-heavy manuscripts never trip the guard on their reference section
  // and discard every edit.
  if (finalVersion.length > 0 && bodyOnlyOriginal.length > 100 && finalVersion.length < bodyOnlyOriginal.length * 0.7) {
    finalVersion = bodyOnlyOriginal;
  }

  // Re-derive sentences from paragraph-matched diff
  // First, repair any newline that falls mid-word (from the model or from
  // fuzzy paragraph-break reinsertion). "remarkable \n\nresults" -> "remarkable results".
  finalVersion = finalVersion.replace(/([A-Za-z0-9'\u2019\u2018])\r?\n\r?\n(?=[a-z])/g, function(m, c) { return c + " "; });
  finalVersion = finalVersion.replace(/([A-Za-z0-9'\u2019\u2018])\r?\n(?=[a-z])/g, function(m, c) { return c + " "; });
  // Split space-glued bold headings BEFORE derivation so the model's
  // "**Conclusion** This chapter serves..." cannot be welded onto the body.
  finalVersion = splitGluedHeadings(finalVersion);
  var derivedS = deriveSentencesFromTexts(bodyOnlyOriginal, finalVersion);
  var sentences = derivedS.sentences;
  finalVersion = derivedS.finalVersion;
  finalVersion = addQuestionMark(finalVersion, bodyOnlyOriginal);

  // Post-process each sentence
  restoredQuoteCount = 0; // per-document reset so the diagnostics note is honest
  epistemicRestoreCount = 0; // per-document reset so the diagnostics note is honest
  sentences = sentences.map(function(s) {
    s.revised = postProcessText(s.revised);
    // Grammar correction is the MODEL's job (Pass 1); the deterministic grammar
    // layer here exists ONLY as a residual detector for scoring, never an editor.
    if (s.original && s.revised && s.original !== s.revised) {
      s.revised = protectQuotes(s.original, s.revised);
      s.revised = protectAcademicRegister(s.original, s.revised);
      s.revised = restoreStructuralMarkers(s.original, s.revised);
      s.revised = protectInvariantIdioms(s.original, s.revised);
      s.revised = restoreDroppedSentence(s.original, s.revised);
      s.revised = restoreCurlyApostrophes(s.original, s.revised);
      s.revised = restoreLeadingEllipsis(s.original, s.revised);
      // Restore the author's hedged/evidential wording if the model hardened it
      // (suggests -> shows, may -> will, could -> can) AFTER quote protection so
      // quoted speech never loses its hedging.
      s.revised = protectEpistemicVoice(s.original, s.revised);
    }
    s.revised = nativePolish(s.revised);
    s.revised = fixCommonMisspellingsSafe(s.revised);
    s.revised = capitalizeEnhanced(s.revised);
    s.revised = addQuestionMark(s.revised, s.original);
    return s;
  });

  // Database-backed nativization (deterministic enforcement layer): applies the
  // exact idiom / AI-ese / lexical replacements from the client DBs to each
  // sentence, then reports honest stats so the diff, suggestions, and score all
  // reflect the nativization instead of double-counting on the client.
  // Phase C: the pipeline ALSO swept the SOURCE before the grammar pass
  // (nativizeSourceText). The sweep's stats arrive via parsed._preSweepStats and
  // are the authoritative DB counts; the backstop below re-enforces rules on the
  // revised text (catching anything the pre-sweep could not see — re-garbles or
  // model-introduced phrases) and only ADDS its new matches. Pre-swept phrases
  // are no longer present in revised, so they are never double counted.
  var preSweepStats = parsed && parsed._preSweepStats ? parsed._preSweepStats : null;
  var databaseStats = {
    totalMatches: preSweepStats && typeof preSweepStats.totalMatches === "number" ? preSweepStats.totalMatches : 0,
    sentencesChanged: preSweepStats && typeof preSweepStats.sentencesChanged === "number" ? preSweepStats.sentencesChanged : 0,
    aiPhrases: preSweepStats && typeof preSweepStats.aiPhrases === "number" ? preSweepStats.aiPhrases : 0,
    idioms: preSweepStats && typeof preSweepStats.idioms === "number" ? preSweepStats.idioms : 0,
    lexical: preSweepStats && typeof preSweepStats.lexical === "number" ? preSweepStats.lexical : 0,
  };
  if (sentences.length) {
    // Always enforced: DB phrase rules (when provided) PLUS the built-in
    // nativization rules, so a real transformation and honest stats are
    // produced even with an empty database or a conservative model.
    var dbPass = applyDatabaseNativization(sentences, options && options.databases, (options && options.domain) || "general");
    sentences = dbPass.sentences;
    databaseStats.totalMatches += dbPass.stats.totalMatches;
    databaseStats.sentencesChanged += dbPass.stats.sentencesChanged;
    databaseStats.aiPhrases += dbPass.stats.aiPhrases;
    databaseStats.idioms += dbPass.stats.idioms;
    databaseStats.lexical += dbPass.stats.lexical;
  }

  // Phase C stage 3: gated humanize — only residual-stiff sentences (uncovered
  // by the DB layers) reach the nativize model call; everything else untouched.
  var humanizePass = await humanizeFlaggedSentences(sentences, options, env);
  sentences = humanizePass.sentences;
  var humanizeInfo = {
    flagged: humanizePass.flagged,
    changed: humanizePass.changed,
    skippedReason: humanizePass.skippedReason,
  };

  // Split any sentence whose revised text begins with a standalone bold heading
  // ("**Conclusion**\nThe findings...") into TWO entries: the heading kept as
  // its own paragraph, then the body. This stops headings from being welded
  // onto body sentences (which produced misleading "replaced X with **Heading**"
  // diffs and lost paragraph breaks).
  (function () {
    var split = [];
    // Track standalone heading sentences already emitted so we can de-dup an
    // echo where the model repeats the heading ("Conclusion" AND "**Conclusion**").
    var seenHeadings = {};
    for (var si = 0; si < sentences.length; si++) {
      var s = sentences[si];
      var r = (s.revised || "").replace(/^\s+/, "");
      // Detect a heading welded to body text: either "**Heading**\n<rest>" or the
      // space-glued variant "**Heading** <sentence>." the model produces (the
      // "title ate the first sentence" defect). The space variant splits only
      // when the tail is a real sentence — never "**Intro** Subheading", and
      // never a "**Note:** ..." lead-in.
      var spec = null;
      var m = /^(\*\*[^*]+\*\*)\s*\r?\n(?=\S)/.exec(r);
      if (m && m[0].indexOf("\n") !== -1 && r.slice(m[1].length).trim().length > 0) {
        spec = { head: m[1], tail: r.slice(m[1].length).replace(/^\s*\r?\n+/, "").trim() };
      } else {
        var sm = /^(\*\*[^*]+\*\*)\s+(\S[\s\S]*)$/.exec(r);
        if (sm) {
          var headInner = sm[1].replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
          var tailTxt = sm[2].trim();
          if (!/[.!?,;:\u2018\u2019]\s*$/.test(headInner) &&
              /^[A-Z\u201C\u2018]/.test(tailTxt) &&
              /[.!?]["'\u201D\u2019]*\s*$/.test(tailTxt) &&
              !headingShapedText(tailTxt) &&
              tailTxt.length < 500) {
            spec = { head: sm[1], tail: tailTxt };
          }
        }
      }
      // Only split when the heading is followed by real body text.
      if (spec && spec.tail.length > 0) {
        var headKey = spec.head.replace(/\*\*/g, "").toLowerCase().trim();
        if (seenHeadings[headKey]) {
          // The heading was already emitted as a standalone prior sentence;
          // keep only the body, so we don't duplicate the heading.
          split.push({
            original: s.original,
            revised: spec.tail,
            explanation: s.explanation,
            isImmutableFootnote: s.isImmutableFootnote,
            paragraphIndex: s.paragraphIndex,
            semanticRisk: undefined,
          });
        } else {
          seenHeadings[headKey] = true;
          split.push({
            original: spec.head,
            revised: spec.head,
            explanation: s.explanation === "No corrections needed." ? "No corrections needed." : "Formatted as heading.",
            isImmutableFootnote: false,
            paragraphIndex: s.paragraphIndex,
            semanticRisk: undefined,
          });
          split.push({
            original: s.original,
            revised: spec.tail,
            explanation: s.explanation,
            isImmutableFootnote: s.isImmutableFootnote,
            paragraphIndex: s.paragraphIndex,
            semanticRisk: undefined,
          });
        }
      } else {
        // Also record standalone headings (bold or plain) as seen, so a later
        // echo of the same heading merged with body text is de-duplicated.
        var rvTrim = (s.revised || "").trim();
        var h = /^(\*\*[^*]+\*\*)\s*$/i.exec(rvTrim);
        var hPlain = /^[A-Z][^*]{0,138}$/.test(rvTrim) && !/[.!?]$/.test(rvTrim) && !/^\[\d+\]/.test(rvTrim) && rvTrim.split(/\s+/).length < 15;
        var key = h ? h[1].replace(/\*\*/g, "").toLowerCase().trim() : (hPlain ? rvTrim.toLowerCase().trim() : null);
        if (key) { seenHeadings[key] = true; }
        split.push(s);
      }
    }
    sentences = split;
  })();

  // Deterministic heading re-bold (see boldHeadingSentences): keeps titles and
  // section headings bold in the UI / exports even when the model stripped the
  // '**' markers. finalVersion is rebuilt from the same array below, so both
  // stay in sync.
  sentences = boldHeadingSentences(sentences);

  // Rebuild finalVersion from the post-processed sentences so it is always
  // 1:1 with the sentences list (no divergence between finalVersion and the
  // breakdown). Preserve original paragraph breaks via the body-only original.
  // Footnote/citation sentences are EXCLUDED from the body rebuild — they are
  // re-appended once, verbatim, below — so they can never be duplicated.
  var rebuildSentences = sentences.filter(function (s) {
    return !(s && (s.isImmutableFootnote || /^\[\d+\]/.test((s.original || "").trim()) || /^\s*Ibid\.?/i.test((s.original || "").trim())));
  });
  var rebuilt = rebuildFinalVersion(bodyOnlyOriginal, rebuildSentences);
  if (rebuilt && rebuilt.trim().length > 0) {
    finalVersion = rebuilt;
  }

  // Deterministic unweld (text-level): splitGluedHeadings is applied again
  // after the paragraph re-builder, which can reintroduce a space-glued bold
  // heading (the "title ate the first sentence" defect).
  finalVersion = splitGluedHeadings(finalVersion);

  // Append the original footnote block EXACTLY ONCE, as its own paragraphs,
  // after the body rebuild (idempotent — removed the previous double append).
  if (savedFootnotes && savedFootnotes.trim()) {
    savedFootnotes = savedFootnotes.replace(/\r?\n(?=\[\d+\])/g, "\n\n").replace(/\r?\n(?=\s*Ibid)/gi, "\n\n");
    if (!finalVersion.includes(savedFootnotes.trim())) {
      finalVersion = finalVersion.trim() + "\n\n" + savedFootnotes.trim();
    }
  }

  // FINAL DEDUP (Fix 3): collapse any verbatim duplication the model introduced
  // — repeated footnote lines and repeated trailing body fragments — so the
  // published output never shows the same reference/body text twice. This runs
  // after everything else and is purely defensive (idempotent).
  (function () {
    // 1) Remove whole duplicated footnote paragraphs ([N] ... / Ibid ...).
    var blocks = finalVersion.split(/\n\n+/).filter(function (p) { return p && p.trim(); });
    var seenRef = {};
    finalVersion = blocks.map(function (p) {
      var t = p.trim();
      var key = null;
      if (/^\[\d+\]/.test(t)) key = "fn:" + t;
      else if (/^Ibid\.?/i.test(t)) key = "fn:" + t;
      else if (/^\[?\d+[.\]]?\s+[A-Z].*\(\d{4}\)/.test(t)) key = "fn:" + t;
      if (key) {
        if (seenRef[key]) return "\uFFFF"; // marker to drop
        seenRef[key] = true;
      }
      return p;
    }).filter(function (p) { return p !== "\uFFFF"; }).join("\n\n");
    // 1b) Drop VERBATIM repeated BODY paragraphs (headings and footnote lines
    // are protected; a body paragraph repeating itself is a model echo).
    blocks = finalVersion.split(/\n\n+/).filter(function (p) { return p && p.trim(); });
    var seenBody = {};
    finalVersion = blocks.map(function (p) {
      var t = p.trim();
      if (/^\*\*/.test(t)) return p;
      if (/^\[\d+\]/.test(t) || /^Ibid\.?/i.test(t) || /^\[?\d+[.\]]?\s+[A-Z].*\(\d{4}\)/.test(t)) return p;
      var key = "body:" + t;
      if (seenBody[key]) return "\uFFFF"; // marker to drop
      seenBody[key] = true;
      return p;
    }).filter(function (p) { return p !== "\uFFFF"; }).join("\n\n");
    // 2) Collapse 3+ newlines.
    finalVersion = finalVersion.replace(/\n{3,}/g, "\n\n");
  })();

  // Build explanations
  function buildDiffExplanation(orig, revised) {
    if (!orig || !orig.trim()) return "Added sentence.";
    var origTrim = orig.trim();
    var revTrim = revised.trim();
    var origClean = origTrim.replace(/^\*\*/, "").replace(/\*\*$/, "").trim().replace(/\s+/g, " ");
    var revClean = revTrim.replace(/^\*\*/, "").replace(/\*\*$/, "").trim().replace(/\s+/g, " ");
    if (origClean === revClean) return "No corrections needed.";
    if (origClean.length < 120 && /^[A-Z]/.test(origClean) && !/[.!?]$/.test(origClean) && revTrim.replace(/\s+/g, " ").trim() === "**"+origClean+"**") return "No corrections needed.";
    if (/^\[\d+\]/.test(origTrim) || /^\s*Ibid\.?/i.test(origTrim)) return "No corrections needed.";
    // Never present a change confined to QUOTED material as a "correction": the
    // model must not be credited (or blamed) for editing citations/quotes.
    function stripQuotes(t) {
      return String(t || "").replace(/[""\u201C\u201D\u2018\u2019][^""\u201C\u201D\u2018\u2019]*[""\u201C\u201D\u2018\u2019]/g, " ");
    }
    var oOut = stripQuotes(origClean).toLowerCase().replace(/\s+/g, " ").trim();
    var rOut = stripQuotes(revClean).toLowerCase().replace(/\s+/g, " ").trim();
    if (oOut === rOut) return "No corrections needed.";
    // A citation-marker move / spacing / punctuation-only rewrite is not a real
    // correction: the underlying content words are identical.
    if (contentTokenSeq(origClean) === contentTokenSeq(revClean)) return "No corrections needed.";
    if (/\(\d{4}\)/.test(orig) && !/\(\d{4}\)/.test(revised)) return "No corrections needed.";
    if (orig.replace(/[-–—]/g, "-").replace(/\s+/g, " ").trim() === revised.replace(/[-–—]/g, "-").replace(/\s+/g, " ").trim()) return "No corrections needed.";
    if (orig === revised) return "No corrections needed.";
    var changes = [];
    var origLower = orig.toLowerCase();
    var revLower = revised.toLowerCase();
    var dupeMatch = origLower.match(/\b(\w+)\s+\1\b/);
    if (dupeMatch && revLower.indexOf(dupeMatch[1] + " " + dupeMatch[1]) === -1) {
      changes.push("removed duplicate '" + dupeMatch[1] + "'");
    }
    var origCommas = (orig.match(/,/g) || []).length;
    var revCommas = (revised.match(/,/g) || []).length;
    if (revCommas < origCommas) changes.push("removed unnecessary comma(s)");
    if (revCommas > origCommas) changes.push("added missing comma(s)");
    var stopWords = /^(a|an|the|is|are|was|were|of|in|on|at|to|for|and|but|or|not|with|from|by|that|this|these|those|it|its|as|also|than|more|most|such|been|being|have|has|had|do|does|did|will|would|can|could|should|may|might|shall)$/i;
    // Token-normalized word diff (Fix-P1): compare by apostrophe-style- and
    // punctuation-agnostic content key so a curly "SPPAIS’s" vs straight
    // "SPPAIS's" never feeds a bogus "replaced X with X" narrative, and matched
    // words consume a count (moves don't double-report).
    function normKey(w) {
      return String(w).replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/[^a-z']/g, "").replace(/'/g, "");
    }
    var origContent = orig.split(/\s+/).filter(function(w) { return !stopWords.test(w.replace(/[^a-zA-Z]/g, "")); });
    var revContent = revised.split(/\s+/).filter(function(w) { return !stopWords.test(w.replace(/[^a-zA-Z]/g, "")); });
    var oc = origContent.map(normKey);
    var rc = revContent.map(normKey);
    var removed = [];
    var removedSeen = {};
    oc.forEach(function (k, i) {
      if (rc.indexOf(k) === -1 && !removedSeen[k]) { removedSeen[k] = 1; removed.push(origContent[i]); }
    });
    var added = [];
    var addedSeen = {};
    rc.forEach(function (k, i) {
      if (oc.indexOf(k) === -1 && !addedSeen[k]) { addedSeen[k] = 1; added.push(revContent[i]); }
    });
    if (removed.length > 0 && added.length > 0) {
      changes.push("replaced '" + removed.slice(0, 3).join("', '") + "' with '" + added.slice(0, 3).join("', '") + "'");
    } else if (removed.length > 0) {
      changes.push("removed " + removed.length + " word(s)");
    } else if (added.length > 0) {
      changes.push("added " + added.length + " word(s) for clarity");
    }
    if (orig.length - revised.length > 20) changes.push("tightened phrasing");
    if (revised.length - orig.length > 20) changes.push("expanded for clarity");
    if (changes.length === 0) changes.push("minor phrasing adjustment");
    return changes.join("; ");
  }

  sentences = sentences.map(function(s) {
    s.explanation = buildDiffExplanation(s.original, s.revised);
    return s;
  });

  var dialect = parsed.detectedDialect || detectDialect(originalText);

  // Scoring based on ONE deterministic measurement applied to the source prose
  // and to the final revised prose from the SAME rule set, so a score can only
  // climb when a real, detected, deterministic defect actually disappears:
  //   1. Misspellings cap a text at 80 — a spelled-out error blocks "native".
  //   2. Residual detectable grammar defects dock 3 each (cap 15).
  //   3. Residual stiff/AI-ese phrases (aiDb + builtin + template families) dock
  //      density-normalized: min(40, round(stiffHits / proseSentenceCount * 30)).
  //   4. Duplicate-word slips cap at 85.
  // The provider's per-run "originalScore" guess is deliberately NOT consulted
  // here — a quality score is measured, never guessed, and a weak provider that
  // under-rated clean input previously pinned production originals to the 62
  // floor while a lone cosmetic swap granted a +9 revised bump.
  var hasDuplicateWords = /\b(\w+)\s+\1\b/.test(originalText);
  var remainingSpelling = countMisspellings(sentences.map(function (s) { return s.revised || ""; }).join(" "));
  var sourceSpelling = countMisspellings(bodyOnlyOriginal);
  var stiffMaps = buildNativizationMaps((options && options.databases) || {}, (options && options.domain) || "general");
  // The prose definition shared with findStiffestSentence / scanStiffPhrases:
  // footnotes and citation lines never participate in a measurement.
  function scoringProse(list) {
    return (list || []).filter(function (s) {
      if (!s || s.isImmutableFootnote) return false;
      var raw = (s.original || "").trim();
      if (/^\[\d+\]/.test(raw) || /^\s*Ibid\.?/i.test(raw)) return false;
      return true;
    });
  }
  function proseJoin(list, field) {
    return scoringProse(list).map(function (s) { return String(s[field] || ""); }).join(" \n ");
  }
  var sourceProse = proseJoin(sentences, "original");
  var revisedProse = proseJoin(sentences, "revised");
  var srcProf = scanStiffPhrases(sourceProse, stiffMaps);
  var revProf = scanStiffPhrases(revisedProse, stiffMaps);
  var sourceStiffness = srcProf.keys.length;
  var revisedStiffness = revProf.keys.length;
  // Distinct rules the revision actually consumed — the honest numerator for the
  // "N stiff/AI-sounding phrase(s) nativized" diagnostic below.
  var nativizedRuleCount = Math.max(0, srcProf.keys.length - revProf.keys.length);
  // Coverage census (diagnostic honesty): the count of phrases the rule set
  // matched in the SOURCE versus a small curated watchlist of stiff patterns the
  // rule set deliberately does NOT auto-rewrite (too voice-/context-dependent —
  // they stay the model's or the author's job). Surfaced so a "quiet" run is
  // explainable: when a text is full of stiff phrasing the rules do not cover,
  // the response reports the gap instead of pretending nothing was wrong. Watch
  // entries already covered by a matched DB rule are never double-listed.
  var coverage = { matched: srcProf.keys.length, uncovered: [] };
  var srcNorm = " " + String(sourceProse || "").replace(/\s+/g, " ").replace(/[""\u201C\u201D]+/g, " ") + " ";
  var srcMatchedLow = {};
  srcProf.keys.forEach(function (k) { srcMatchedLow[String(k).toLowerCase()] = 1; });
  COVERAGE_WATCHLIST.forEach(function (ph) {
    var low = ph.toLowerCase();
    if (srcMatchedLow[low]) return;
    var cre = new RegExp("\\b" + escapeRegExp(low).split(/\s+/).join("\\s+") + "\\b", "i");
    if (cre.test(srcNorm)) coverage.uncovered.push(ph);
  });
  // Residual, length-normalized scoring (the "residual 0-100 + counts" contract):
  // a score measures what is genuinely LEFT in the text, never what the rule
  // book consumed. Same deterministic measurement applied to source and to
  // revised, so a score climbs ONLY when a real, detected defect disappears.
  // Grammar residual is rescanned with the SAME applyGrammarLayer after every
  // pass (idempotent: already-fixed constructs no longer match, so the residual
  // is the honest remainder). Template-family hits are counted once per phrase
  // and merged with the DB/builtin stiffness scan (never double-docked).
  var proseSentenceCount = Math.max(1, scoringProse(sentences).length);
  var sourceGrammarHits = 0;
  var revisedGrammarHits = 0;
  scoringProse(sentences).forEach(function (s) {
    // Quote-only sentences are skipped by every editing pass, so they must not
    // count as an untouchable residual defect in the measurement either (the
    // noted Lolita-untouched corpus stays at the native 98-98 this way).
    if (/^".*"$/.test((s.original || "").trim()) || /^".*"$/.test((s.revised || "").trim())) return;
    sourceGrammarHits += applyGrammarLayer(s.original || "").fixes;
    revisedGrammarHits += applyGrammarLayer(s.revised || "").fixes;
  });
  var sourceStiffAll = sourceStiffness;
  var revisedStiffAll = revisedStiffness;
  function measuredResidual(spelling, grammarHits, stiffAll, dupWords) {
    var score = 100 - Math.min(15, grammarHits * 3) - Math.min(40, Math.round((stiffAll / proseSentenceCount) * 30));
    if (spelling > 0) score = Math.min(score, 80);
    if (dupWords) score = Math.min(score, 85);
    return Math.min(100, Math.max(40, score));
  }
  var origScore = measuredResidual(sourceSpelling, sourceGrammarHits, sourceStiffAll, hasDuplicateWords);
  var revScore = measuredResidual(remainingSpelling, revisedGrammarHits, revisedStiffAll, false);

  // Count REAL content changes (ignore trivial punctuation/case-only rewrites
  // from the AI echo that padded earlier scores). Also EXCLUDE changes confined
  // to quoted material — the model must never gain score by editing citations or
  // quoted passages (Fix 4).
  function stripQuotes(t) {
    return String(t || "").replace(/[""\u201C\u201D\u2018\u2019][^""\u201C\u201D\u2018\u2019]*[""\u201C\u201D\u2018\u2019]/g, " ");
  }
  // Records what the revision ACTUALLY displaced:
  //   realChangeCount = how many sentences really changed content (cosmetic
  //     quote/punctuation/case-only echo never counts, and changes confined to
  //     quoted material never count — the model can't gain score by editing
  //     citations or quoted passages, Fix 4). Drives the deterministic summary.
  //   magnitudeAll = how many content tokens the revision displaced across those
  //     really-changed sentences (symmetric word-difference). Kept as a measured
  //     diagnostic (probes / further analysis read it); the scores above are
  //     driven purely by the deterministic spelling + stiffness measurement, so
  //     a lone cosmetic swap can no longer manufacture a bump.
  function tokenDiffMagnitude(a, b) {
    var counts = {};
    String(a || "").split(/\s+/).forEach(function (w) { if (w) counts[w] = (counts[w] || 0) + 1; });
    var diff = 0;
    String(b || "").split(/\s+/).forEach(function (w) {
      if (!w) return;
      if (counts[w] > 0) counts[w]--; else diff++;
    });
    Object.keys(counts).forEach(function (w) { diff += counts[w]; });
    return diff;
  }
  // Semantic-fidelity guard (Fix-P0): flag sentences whose REVISED wording
  // flips the meaning (negation inserted/removed, or a subject/object swap
  // around a surviving negation). Flagged sentences earn NO bump below and get
  // a review note surfaced via postProcessSuggestions.
  var semanticRisks = detectSemanticRisk(sentences);
  for (var sr in semanticRisks) {
    if (Object.prototype.hasOwnProperty.call(semanticRisks, sr)) sentences[Number(sr)].semanticRisk = semanticRisks[sr];
  }
  // Content words that vanished from the SOURCE without a justifying
  // nativization rule firing (Fix-P2, "dropped words" note). Word-level
  // comparisons must exclude the preserved reference/citation block: the source
  // has ALREADY had its footnotes extracted, while finalVersion can carry them
  // (the model returns the reference block and the rebuild keeps it). Without
  // this, citation words ("Clausewitz", "university", "international"...) are
  // mislabeled as invented detail — re-stripping finalVersion with
  // extractFootnoteBlock yields the same prose-only view the source uses.
  var bodyFinalForWords = extractFootnoteBlock(String(finalVersion || "")).body || finalVersion;
  var droppedWords = droppedContentWords(bodyOnlyOriginal, bodyFinalForWords, options);
  // Content words the revision ADDED that appear nowhere in the source (possibly
  // invented detail) — advisory note so the author can confirm intent.
  var addedWords = addedContentWords(bodyOnlyOriginal, bodyFinalForWords, options);

  var realChangeCount = 0;
  var magnitudeAll = 0;
  sentences.forEach(function (s, si) {
    // Semantically-flagged sentences must not inflate the score: their edit is
    // unverifiable (may have flipped meaning), so it cards no credit.
    if (semanticRisks[si]) return;
    var before = (s.original || "").trim().replace(/\s+/g, " ");
    var after = (s.revised || "").trim().replace(/\s+/g, " ");
    var o = before.toLowerCase();
    var r = after.toLowerCase();
    if (!/[a-z]/.test(o) || !/[a-z]/.test(r)) return;
    if (o === r) {
      // The only difference is character case. Count it as a REAL improvement
      // ONLY when the ORIGINAL sentence literally began with a lowercase letter
      // (a genuine non-native capitalization error the revision fixed) — never
      // when the original already started correctly, which would be a budget-
      // inflating model echo. This keeps scores honest in both directions.
      // (No quote-strip here: a case-only change has no word-level differences,
      // so that guard would always match and would swallow genuine caps fixes.)
      if (/(?:^|[.!?]\s+)[a-z]/.test(before)) { realChangeCount++; magnitudeAll += 1; }
      return;
    }
    // If the ONLY meaningful difference is inside quoted text, it is NOT a real
    // (score-worthy) change — the words outside quotes match.
    var oq = stripQuotes(o).replace(/\s+/g, " ").trim();
    var rq = stripQuotes(r).replace(/\s+/g, " ").trim();
    if (oq === rq) return;
    // A citation-marker move / spacing / punctuation-only rewrite (same content
    // words, different markers) is NOT a real improvement.
    if (contentTokenSeq(before) === contentTokenSeq(after)) return;
    realChangeCount++;
    magnitudeAll += Math.max(1, tokenDiffMagnitude(oq, rq));
  });

  // Stiffest-sentence prioritization: find the source sentence carrying the most
  // AI-sounding phrasing and confirm the revision actually addressed it. When it
  // was left effectively unchanged, surface an explicit note so the author can
  // re-run or hand-fix the real target (the model's "fix the easy ones" failure
  // the prompt rule 15 also pushes against).
  var stiffTarget = findStiffestSentence(sentences, options);
  var stiffUntouched = null;
  if (stiffTarget && sentences[stiffTarget.index]) {
    var st = sentences[stiffTarget.index];
    var stDealtWith = hasDealtWithStiffness(st.original, st.revised, options);
    // A semantically-flagged sentence WAS touched (that is why it is flagged).
    if (semanticRisks[stiffTarget.index]) stDealtWith = true;
    if (!stDealtWith) stiffUntouched = stiffTarget;
  }

// Deterministic re-banded scoring — the meter is the raw residual measurement,
// then the BAND snaps it onto the honest display scale both providers agree on:
//   - originalScore prints at most 95 UNLESS the source is measured flawless
//     (raw >= 98), which prints 98. A near-perfect source (96/97) still reads 95,
//     so a revision always has visible headroom.
//   - When nothing measurable changed (no real sentence change, no DB rule
//     fired, no spelling/stiffness/grammar improvement) the revision is scored
//     EXACTLY like its source (revised == original) — no phantom credit.
//   - Otherwise the revision earns the measured improvement back on a
//     compressed scale: revised = min(98, original + max(2, round(cleared*0.8)))
//     where cleared = rawRevised - rawSource (the SAME deterministic rubric
//     applied to both texts). The +2 floor guarantees a genuine correction
//     visibly matters; cap 98 keeps a perfect revision from colliding with a
//     hypothetical perfect source.
//   - Residual misspellings still cap BOTH at 80, so a revised text carrying
//     errors can never out-score its source.
//   - Nothing here uses provider identity, temperature, or model — the SAME
//     source always produces the SAME originalScore/revisedScore.
  // Capture the raw meter BEFORE banding so the rubric can explain the two
  // scores honestly: the linear residual 0-100 (source vs revised) and then
  // the band that snaps them onto the display scale.
  var rawOrigScore = origScore;
  var rawRevScore = revScore;
  var clearedRaw = Math.max(0, revScore - origScore);
  var anyChange =
    realChangeCount > 0 ||
    databaseStats.totalMatches > 0 ||
    remainingSpelling < sourceSpelling ||
    revisedStiffAll < sourceStiffAll ||
    revisedGrammarHits < sourceGrammarHits;
  origScore = Math.min(98, Math.max(origScore, 40));
  if (origScore >= 98) origScore = 98;          // flawless source prints 98
  else origScore = Math.min(95, origScore);       // everything else tops at 95
  var boostApplied = 0;
  if (anyChange && clearedRaw > 0) {
    boostApplied = Math.max(2, Math.round(clearedRaw * 0.8));
    revScore = Math.min(98, origScore + boostApplied);
  } else {
    revScore = origScore;
  }
  var spellCapApplied = false;
  if (remainingSpelling > 0) {
    spellCapApplied = true;
    origScore = Math.min(origScore, 80);
    revScore = Math.min(revScore, 80);
  }
  if (revScore < origScore) revScore = origScore;

  // Phase D: the SCORING RUBRIC — a transparent, self-explanatory audit of why
  // the two scores landed where they did. Same deterministic measurement applied
  // to source and revision; the four axes carry raw counts plus a normalized
  // 0-100 health sub-score each; the meter holds the linear residual before
  // banding; banding explains the snap rules. Nothing here can affect the
  // scores (pure description) — it only makes the number fair and explainable.
  function axisHealth(category, count, proseN, dupOnly) {
    if (category === "spelling") return count === 0 ? 100 : Math.max(40, 80 - Math.min(40, (count - 1) * 4));
    if (category === "grammar") return 100 - Math.min(15, count * 3);
    if (category === "stiffness") return 100 - Math.min(40, Math.round((count / Math.max(1, proseN || 1)) * 30));
    if (category === "duplicates") return dupOnly ? 85 : 100;
    return 100;
  }
  var semanticRiskCount = 0;
  for (var _sr in semanticRisks) { if (Object.prototype.hasOwnProperty.call(semanticRisks, _sr)) semanticRiskCount++; }
  var rubric = {
    display: { originalScore: origScore, revisedScore: revScore },
    meter: {
      source: Math.round(rawOrigScore),
      revised: Math.round(rawRevScore),
      cleared: Math.round(clearedRaw),
      note: "Linear residual meter (0-100, clamped 40-100): the SAME deterministic measurement is applied to source and revision, so a score climbs only when a detected defect actually disappears.",
    },
    axes: {
      spelling: {
        source: sourceSpelling, remaining: remainingSpelling,
        sourceHealth: axisHealth("spelling", sourceSpelling, proseSentenceCount),
        remainingHealth: axisHealth("spelling", remainingSpelling, proseSentenceCount),
      },
      grammar: {
        source: sourceGrammarHits, remaining: revisedGrammarHits,
        sourceHealth: axisHealth("grammar", sourceGrammarHits, proseSentenceCount),
        remainingHealth: axisHealth("grammar", revisedGrammarHits, proseSentenceCount),
      },
      stiffness: {
        source: sourceStiffAll, remaining: revisedStiffAll,
        sourceHealth: axisHealth("stiffness", sourceStiffAll, proseSentenceCount),
        remainingHealth: axisHealth("stiffness", revisedStiffAll, proseSentenceCount),
        proseSentenceCount: proseSentenceCount,
        rulesConsumed: nativizedRuleCount,
      },
      duplicates: {
        source: hasDuplicateWords ? 1 : 0, remaining: 0,
        sourceHealth: axisHealth("duplicates", 0, proseSentenceCount, hasDuplicateWords),
        remainingHealth: 100,
      },
    },
    banding: {
      anyChange: !!anyChange,
      realChanges: realChangeCount,
      dbRulesFired: databaseStats.totalMatches,
      boostApplied: boostApplied,
      nativizedRuleCount: nativizedRuleCount,
      spellingCapApplied: spellCapApplied,
      flatByContract: !anyChange || clearedRaw <= 0,
      rule: "No measurable change (or flawless source) scores the revision EXACTLY like its source; otherwise revised = min(98, original + max(2, round(cleared*0.8))). originalScore prints 98 only for a measured-flawless source, otherwise at most 95. Residual misspellings cap both sides at 80.",
    },
    caveats: {
      coverageUncovered: coverage.uncovered.length,
      semanticRiskSentences: semanticRiskCount,
      humanizeSkipped: humanizePass.skippedReason || null,
    },
  };

  var preservedFootnoteCount = 0;
  if (savedFootnotes && savedFootnotes.trim()) {
    preservedFootnoteCount = (savedFootnotes.match(/^\s*(\[\]?\d+\]|\[\d+\]|Ibid\.?)/gim) || []).length ||
      savedFootnotes.split(/\n\n+/).filter(function (l) { return /^\[\d+\]|^Ibid\.?/i.test(l.trim()); }).length;
    if (preservedFootnoteCount === 0 && savedFootnotes.trim()) preservedFootnoteCount = 1;
  }

  // Review notes the Notes tab surfaces on top of the deterministic summary
  // (Fix-P0 semantic flags + Fix-P2 dropped-word warnings).
  var reviewNotes = [];
  var srKeys = Object.keys(semanticRisks || {}).map(Number).sort(function (a, b) { return a - b; });
  srKeys.slice(0, 5).forEach(function (ridx) {
    var risk = semanticRisks[ridx];
    reviewNotes.push("Note — Sentence " + (ridx + 1) + ": " + risk.detail + " (the revision may have changed the meaning; review to confirm intent).");
  });
  if (droppedWords.length > 0) {
    reviewNotes.push("Note — words dropped during tightening were not linked to a nativizing rewrite: " + droppedWords.join(", ") + (droppedWords.length === 6 ? " (and more)" : "") + ". Confirm the simplification preserves intent.");
  }
  if (restoredQuoteCount > 0) {
    reviewNotes.push("Note — " + restoredQuoteCount + " quoted passage" + (restoredQuoteCount === 1 ? " was" : "s were") + " modified during processing and restored to the original wording.");
  }
  if (epistemicRestoreCount > 0) {
    reviewNotes.push("Note — " + epistemicRestoreCount + " revision" + (epistemicRestoreCount === 1 ? "" : "s") + " hardened the author's epistemic stance (e.g. suggests \u2192 shows, may \u2192 will) and " + (epistemicRestoreCount === 1 ? "was" : "were") + " restored to the original hedging under the voice-preservation rule.");
  }
  if (addedWords.length > 0) {
    reviewNotes.push("Note — the revision adds words that appear nowhere in the source (possibly invented detail): " + addedWords.join(", ") + (addedWords.length === 8 ? " (and more)" : "") + ". Confirm the added detail is intended.");
  }
  if (stiffUntouched) {
    reviewNotes.push("Note — Sentence " + (stiffUntouched.index + 1) + " reads the stiffest (the source crowds " + stiffUntouched.phraseCount + " AI-sounding phrase" + (stiffUntouched.phraseCount === 1 ? "" : "s") + " here) but the revision left it effectively unchanged. It is the sentence to fix first — re-run or nativize it by hand.");
  }

  var suggestions = postProcessSuggestions(
    Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    originalText,
    finalVersion,
    sentences,
    preservedFootnoteCount,
    reviewNotes
  );

  // Surface the deterministic nativization work as the FIRST summary line so the
  // panel text can never contradict the applied transformations.
  if (nativizedRuleCount > 0) {
    suggestions.unshift(nativizedRuleCount + " stiff/AI-sounding phrase(s) nativized using IdiomOptima's nativization rules.");
  } else if (databaseStats.totalMatches > 0) {
    suggestions.unshift(databaseStats.totalMatches + " stiff/AI-sounding phrase(s) nativized using IdiomOptima's nativization rules.");
  }

  // Deterministic summary, derived from the SAME real-change/spelling signals the
  // scores use, so the panel text can never contradict the score delta (fixes the
  // "70->77" + "No corrections needed" desync: the model's free-text explanation
  // disagreed with our scoring, so we stop trusting it entirely).
  var summary;
  var flaggedCount = Object.keys(semanticRisks || {}).length;
  if (remainingSpelling > 0) {
    summary = "The revision corrected several issues, but " + remainingSpelling + " spelling error(s) remain in the output.";
  } else if (revisedGrammarHits > 0 || revisedStiffAll > 0) {
    var remainBits = [];
    if (revisedGrammarHits > 0) remainBits.push(revisedGrammarHits + " grammar issue" + (revisedGrammarHits === 1 ? "" : "s"));
    if (revisedStiffAll > 0) remainBits.push(revisedStiffAll + " stiff/AI-sounding phrase instance" + (revisedStiffAll === 1 ? "" : "s"));
    summary = "The revision fixed the detectable issues, but " + remainBits.join(" and ") + " would still benefit from a second pass.";
  } else if (realChangeCount > 0) {
    summary = "The revision made " + realChangeCount + " real improvement" + (realChangeCount === 1 ? "" : "s") +
      ", nativizing and refining the writing to native-level English.";
  } else if (flaggedCount > 0) {
    summary = "The revision rephrased " + flaggedCount + " sentence" + (flaggedCount === 1 ? "" : "s") +
      " flagged for semantic review — see notes.";
  } else {
    summary = "The original text needed no corrections.";
  }

  // Surface the preserved reference block as explicit sentences so the UI
  // (which renders `sentences` for fulltext/diff/Apply-to-Editor/notes) shows
  // the footnotes too. finalVersion already carries them; the sentence list
  // must match. Entries already present from the derive pass are not re-added.
  if (savedFootnotes && savedFootnotes.trim()) {
    var fnStarPara = 9000;
    var seenFn = {};
    sentences.forEach(function (s) {
      var fk = normalizeSentenceKey((s && (s.original || s.revised)) || "");
      if (fk) seenFn[fk] = true;
    });
    savedFootnotes.split(/\n\n+/).map(function (p) { return p.trim(); }).filter(function (p) { return p; })
      .forEach(function (fnText, fi) {
        var fk = normalizeSentenceKey(fnText);
        if (fk && seenFn[fk]) return;
        if (fk) seenFn[fk] = true;
        sentences.push({
          original: fnText,
          revised: fnText,
          explanation: "No corrections needed.",
          isImmutableFootnote: true,
          paragraphIndex: fnStarPara + fi,
          semanticRisk: undefined,
        });
      });
  }

  // Global curly-apostrophe pass over the REBUILT final text (per-sentence
  // restore already covers the sentence list; this ensures Full-Prose and the
  // finalVersion used by clients carry the original glyphs even when alignment
  // collapsed a re-segmented sentence).
  finalVersion = restoreCurlyApostrophes(bodyOnlyOriginal, finalVersion);

  return {
    originalScore: origScore,
    revisedScore: revScore,
    finalVersion: finalVersion,
    sentences: sentences,
    suggestions: suggestions,
    explanation: summary,
    detectedDialect: dialect,
    databaseStats: databaseStats,
    coverage: coverage,
    // Residual-defect census (the "counts" half of the residual 0-100 + counts
    // contract): unambiguous counts of what was measured in source vs what
    // remains, so the UI can surface "7 stiff, 0 spelling, 0 grammar -> 0 left".
    sourceIssues: { spelling: sourceSpelling, grammar: sourceGrammarHits, stiffness: sourceStiffAll },
    remainingIssues: { spelling: remainingSpelling, grammar: revisedGrammarHits, stiffness: revisedStiffAll },
    // Phase C gated-humanize audit: how many sentences were still stiff enough
    // to be flagged for the nativize model call, how many were actually
    // rewritten, and why the pass was skipped (no API key offline, nothing
    // flagged, or a non-fatal model/parse error).
    humanize: humanizeInfo,
    // Phase D scoring rubric: why the two scores landed where they did (see
    // the rubric construction above the score finals — descriptive only, never
    // consulted by the scores themselves).
    rubric: rubric,
  };
}

// --- Gemini model-reachability probe (diagnostic) -------------------------
// /health?probe=1 live-checks each MODEL_CANDIDATE against the configured key
// so a "changes nothing" symptom is provably a key/model problem, not a code
// bug. Names the model IDs; never echoes keys or user content.
var HEALTH_MODEL_CANDIDATES = ["gemini-3.6-flash"];

async function probeGeminiModels(apiKey) {
  if (!apiKey) return { configured: false, models: [] };
  var results = [];
  for (var i = 0; i < HEALTH_MODEL_CANDIDATES.length; i++) {
    var model = HEALTH_MODEL_CANDIDATES[i];
    var entry = { model: model };
    try {
      var resp = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "ping" }] }],
            generationConfig: { maxOutputTokens: 1, temperature: 0 },
          }),
          signal: AbortSignal.timeout(15000),
        }
      );
      entry.status = resp.status;
      entry.ok = resp.ok;
    } catch (e) {
      entry.status = 0;
      entry.ok = false;
      entry.error = String((e && e.message) || e).substring(0, 120);
    }
    results.push(entry);
  }
  return { configured: true, models: results };
}

// Workers AI reachability probe — the no-key backstop that keeps /health green
// even during a Google-side outage. Probes the same rotation the transform uses
// and reports which model actually answered.
async function probeWorkersAI(ai) {
  if (!ai) return { configured: false };
  for (var wi = 0; wi < WORKERS_AI_MODELS.length; wi++) {
    var model = WORKERS_AI_MODELS[wi];
    try {
      var data = await ai.run(model, {
        messages: [
          { role: "system", content: "Reply with exactly: pong" },
          { role: "user", content: "ping" }
        ],
        temperature: 0,
        max_tokens: 1
      });
      var reply = String((data && data.response) || "pong").substring(0, 40);
      if (reply) return { configured: true, ok: true, model: model, response: reply };
    } catch (e) {
      continue;
    }
  }
  return { configured: true, ok: false, error: "all Workers AI models failed (" + WORKERS_AI_MODELS.length + " tried)" };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    var url = new URL(request.url);
    var path = url.pathname;

    // -- Health ------------------------------------------------------
    if (request.method === "GET" && path === "/health") {
      var health = {
        status: "ok",
        timestamp: Date.now(),
        configuredProviders: {
          gemini: !!env.GEMINI_API_KEY,
          openrouter: !!env.OPENROUTER_API_KEY,
          workersai: !!env.AI,
        },
        contract: "two-pass: gemini grammar-only -> deterministic DB nativization (free fallback chain behind)",
      };
      if (url.searchParams.get("probe") === "1") {
        health.geminiModelProbe = await probeGeminiModels(env.GEMINI_API_KEY);
        health.workersAIProbe = await probeWorkersAI(env.AI);
      }
      return jsonResponse(health);
    }

    // -- Stripe webhook ---------------------------------------------
    if (request.method === "POST" && path === "/stripe-webhook") {
      return handleStripeWebhook(request, env);
    }

    // -- Stripe billing portal (manage subscription) -----------------
    if (request.method === "POST" && path === "/billing-portal") {
      try {
        var portalDomain = env.CLERK_DOMAIN || "";
        var portalUserId = await getUserIdFromRequest(request, portalDomain);
        if (!portalUserId || !env.STRIPE_SECRET_KEY) {
          return jsonResponse({ error: "Authentication required" }, 401);
        }
        var portalCustomerId = null;
        if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
          var portalRows = await supabaseQuery(
            env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, "users",
            "select=stripe_customer_id&clerk_id=eq." + encodeURIComponent(portalUserId) + "&limit=1"
          );
          if (portalRows && portalRows[0]) portalCustomerId = portalRows[0].stripe_customer_id;
        }
        if (!portalCustomerId) {
          return jsonResponse({ error: "No active subscription found for this account." }, 400);
        }
        var portalUrl = await createStripePortal(env.STRIPE_SECRET_KEY, portalCustomerId);
        return jsonResponse({ url: portalUrl });
      } catch (e) {
        console.error("billing-portal: " + String((e && e.message) || e).substring(0, 200));
        return jsonResponse({ error: "Could not open the billing portal. Please try again." }, 500);
      }
    }

    // -- Create Stripe Checkout session -----------------------------
    if (request.method === "POST" && path === "/create-checkout") {
      try {
        var checkoutDomain = env.CLERK_DOMAIN || "";
        var checkoutUserId = await getUserIdFromRequest(request, checkoutDomain);
        if (!checkoutUserId || !env.STRIPE_SECRET_KEY) {
          return jsonResponse({ error: "Authentication required" }, 401);
        }
        if (!env.STRIPE_PRICE_ID) {
          console.error("create-checkout: STRIPE_PRICE_ID env missing on worker");
          return jsonResponse({ error: "Server misconfiguration: checkout pricing is not configured." }, 500);
        }
        var ccBody;
        try {
          ccBody = await request.json();
        } catch (e) {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        var ccEmail = String(ccBody.email || "");
        if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
          await supabaseRpc(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, "upsert_user", {
            p_clerk_id: checkoutUserId,
            p_email: ccEmail,
          });
        }
        var checkout = await createStripeCheckout(
          env.STRIPE_SECRET_KEY,
          env.STRIPE_PRICE_ID,
          checkoutUserId,
          ccEmail,
          env.SUPABASE_URL,
          env.SUPABASE_SERVICE_KEY
        );
        return jsonResponse({ url: checkout.url });
      } catch (e) {
        console.error("create-checkout: " + String((e && e.message) || e).substring(0, 200));
        return jsonResponse({ error: "Could not start the checkout session. Please try again." }, 500);
      }
    }

    // -- Get user tier + usage --------------------------------------
    if (request.method === "GET" && path === "/user-tier") {
      var clerkDomain = env.CLERK_DOMAIN || "";
      var userId = await getUserIdFromRequest(request, clerkDomain);
      if (!userId) return jsonResponse({ tier: "free", usage: 0, limit: 4, wordLimit: 800 });

      var tier = "free";
      var usage = 0;
      if (userId) {
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
          return jsonResponse({ error: "Server misconfiguration: usage storage is not configured on this worker." }, 500);
        }
        tier = await getUserTier(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, userId);
        usage = await getDailyUsage(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, userId);
      }
      var limit = tier === "pro" || tier === "enterprise" ? 9999 : 4;
      var wordLimit = tier === "pro" || tier === "enterprise" ? null : 800;
      return jsonResponse({ tier: tier, usage: usage, limit: limit, wordLimit: wordLimit });
    }

    // -- Main transformation (POST) ---------------------------------
    if (request.method !== "POST" || path !== "/") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    try {
      var payload = await request.json();
      var text = String(payload.text || "").trim();
      // Count "honest words" the same way the client badge/pre-gate does:
      // strip ** markdown, drop footnote-reference lines, then count tokens.
      // (Otherwise prose under 800 but with footnotes would 429 a real user.)
      var wordCount = 0;
      if (text.length > 0) {
        var countText = text
          .replace(/\*\*/g, " ")
          .split(/\r?\n/)
          .filter(function (line) {
            return line.trim() && !/^\s*(\[\d+\]|Ibid\.?)(?:\s|$)/i.test(line);
          })
          .join(" ");
        wordCount = countText.trim().split(/\s+/).filter(Boolean).length;
      }

      // English-only guard: block non-English input for everyone (including
      // anonymous callers) before any provider work or usage accounting.
      if (text.length > 0 && looksNonEnglish(text)) {
        return jsonResponse({ error: ENGLISH_ONLY_MESSAGE, notEnglish: true }, 400);
      }

      var options = {
        domain: String(payload.domain || "general"),
        tone: String(payload.tone || "neutral"),
        forcedDialect: String(payload.forcedDialect || ""),
        mode: String(payload.mode || "hybrid"),
      };

      // Databases the client loaded (idioms / AI-phrases / domain lexical maps).
      // Used to nativize deterministically AND to inject compact DB rules into
      // the provider prompts. If the client shipped nothing usable (empty arrays
      // / absent payload — e.g. a transform clicked before the DB fetches
      // resolved), fall back to the server-side DEFAULT_DATABASES so the
      // deterministic layer still fires real transformations.
      var clientDb = payload.databases && typeof payload.databases === "object" ? payload.databases : null;
      var anyLex = false;
      if (clientDb && clientDb.lexicalDb && typeof clientDb.lexicalDb === "object" && !Array.isArray(clientDb.lexicalDb)) {
        for (var dk in clientDb.lexicalDb) {
          if (Array.isArray(clientDb.lexicalDb[dk]) && clientDb.lexicalDb[dk].length > 0) { anyLex = true; break; }
        }
      }
      var hasAnyDb = clientDb && ((Array.isArray(clientDb.aiDb) && clientDb.aiDb.length > 0) ||
        (Array.isArray(clientDb.idiomDb) && clientDb.idiomDb.length > 0) || anyLex);
      options.databases = hasAnyDb ? clientDb : DEFAULT_DATABASES;

      if (!text) {
        return jsonResponse({ error: "No text provided" }, 400);
      }

      // -- Pre-process: extract footnotes, normalize titles ----------
      var extracted = extractFootnoteBlock(text);
      var bodyText = normalizeFootnoteRefs(normalizeTitleBreaks(extracted.body));
      var savedFootnotes = extracted.footnotes;

      // -- Phase C stage 1: deterministic DB sweep on the SOURCE ----------
      // Nativization rules fire on the author's text BEFORE the grammar model
      // sees it, so the swaps are embedded in what the model parses (grammar
      // pass never restores them, per the grammar-only contract). Because
      // deriveSentencesFromTexts re-builds each sentence's .original from the
      // AUTHOR text, the residual meter still measures the true source, and the
      // DB counts travel via parsed._preSweepStats.
      var originalBodyText = bodyText;
      var preSweep = nativizeSourceText(bodyText, options.databases, options.domain);
      bodyText = preSweep.text;

      // -- Auth + tier check ----------------------------------------
      var clerkDomain = env.CLERK_DOMAIN || "";
      var userId = await getUserIdFromRequest(request, clerkDomain);
      var tier = "free";
      var usage = 0;

      if (userId) {
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
          console.error("transform: authenticated request but Supabase env missing — refusing instead of silently bypassing limits");
          return jsonResponse({ error: "Server misconfiguration: usage storage is not configured on this worker." }, 500);
        }
        tier = await getUserTier(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, userId);
        usage = await getDailyUsage(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, userId);

        var limit = tier === "pro" || tier === "enterprise" ? 9999 : 4;
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
        if (tier === "free" && wordCount > 800) {
          return jsonResponse({
            error: "The free plan allows up to 800 words per transformation. Upgrade to Pro for unlimited length.",
            wordLimitReached: true,
            tier: tier,
            usage: usage,
            limit: limit,
            wordLimit: 800,
          }, 429);
        }
      }

      // -- Provider routing ------------------------------------------
      // Gemini is the ONLY primary provider (all tiers): temperature 0 + no
      // thinkingConfig + forced JSON keeps output deterministic, and the
      // deterministic DB nativization layer runs after in ensureValidResult.
      // Behind Gemini sits a free fallback chain (OpenRouter free -> Workers
      // AI) that engages ONLY after Gemini exhausts its own model rotation.
      // A missing key/binding skips that provider.
      var attempts = buildProviderAttempts(bodyText, options, pushLine, env);

      var parsed = null;
      var provider = "none";
      var lastParsed = null;
      var lastParsedProvider = "";
      var answeredOk = false;
      var providerErrors = [];
var rescueUsed = false;
      var attemptTimes = [];
      var providerStartMs = Date.now();
      var streamEncoder = new TextEncoder();
      var controllerRef = null;
      var streamErrors = [];
      function pushLine(obj) {
        try {
          controllerRef.enqueue(streamEncoder.encode(JSON.stringify(obj) + "\n"));
        } catch (e) {
          streamErrors.push("pushLine(" + (obj && obj.ev) + "): " + String((e && e.message) || e));
        }
      }

      var streamBody = new ReadableStream({
        start: async function (controller) {
          controllerRef = controller;
          try {
          pushLine({ ev: "phase", pct: 12, phase: "Loaded grammar, dialect & nativization rules" });

          for (var ai = 0; ai < attempts.length; ai++) {
            var attempt = attempts[ai];
            var attemptName = attempt[0];
            var attemptFn = attempt[1];
            provider = attemptName;
            if (!attemptFn) {
              providerErrors.push(attemptName + ": skipped (not configured)");
              attemptTimes.push({ provider: attemptName, ms: 0, ok: false, skipped: true });
              continue;
            }
            var attemptStartMs = Date.now();
            pushLine({ ev: "tick", pct: Math.min(84, 18 + attemptTimes.length * 6), phase: "Contacting " + attemptName + " — this can take up to 45–90s" });
            try {
              // Keep the NDJSON stream alive during long provider waits: edge
              // proxies have torn down idle responses, surfacing as a silent
              // "Stream ended without a final result". Same pct as the
              // "Contacting" tick, so the client never advances progress from
              // these pings (progress is monotonic, never fabricated).
              var heartbeat = setInterval(function () {
                pushLine({ ev: "tick", pct: Math.min(84, 18 + attemptTimes.length * 6), phase: attemptName + " is still working — this can take up to 45–90s" });
              }, 12000);
              var rawA = await attemptFn();
              parsed = parseJsonFromModel(rawA);
              if (parsed && (parsed.finalVersion === "[object Object]" ||
                  (Array.isArray(parsed.sentences) && parsed.sentences.some(function (s) { return s && (s.original === "[object Object]" || s.revised === "[object Object]"); })))) {
                parsed = null;
              }
              if (parsed && Array.isArray(parsed.sentences)) {
                parsed.sentences = parsed.sentences.map(function (s) {
                  if (s && typeof s.original !== "string") s.original = String(s.original || "");
                  if (s && typeof s.revised !== "string") s.revised = String(s.revised || "");
                  if (s && s.original === "[object Object]") s.original = "";
                  if (s && s.revised === "[object Object]") s.revised = "";
                  return s;
                });
              }
              if (!parsed) {
                var unparseableMsg = attemptName + ": unparseable model output (length " + String(rawA).length + ")";
                providerErrors.push(unparseableMsg);
                console.error(unparseableMsg);
                attemptTimes.push({ provider: attemptName, ms: Date.now() - attemptStartMs, ok: false });
                pushLine({ ev: "tick", pct: Math.min(88, 22 + attemptTimes.length * 6), phase: attemptName + " could not be parsed — trying the next provider" });
                continue;
              }
              if (Array.isArray(parsed.sentences) && parsed.sentences.length > 0) {
                var outTxt = parsed.sentences.map(function (ss) { return (ss && ss.revised) || ""; }).join(" ");
                if (outTxt.trim().length > 0) {
                  var fwd = contentCoverage(outTxt, bodyText);
                  var back = contentCoverage(bodyText, outTxt);
                  // Gemini is the Pass-1 grammar authority (two-pass contract):
                  // its corrections legitimately replace source tokens with
                  // inflected/spelled forms ("buyed"->"bought", "go"->"went"),
                  // which the invention axis (fwd) cannot distinguish from
                  // fabrication. The primary model is held only to the
                  // drop/cover axis (back) so truncation still rotates;
                  // fallbacks keep both axes and the 0.5 floors. Added-word
                  // Notes still surface genuinely odd additions for the author.
                  if (back < 0.5 || (attemptName !== "gemini" && fwd < 0.5)) {
                    var fidMsg = attemptName + ": response dropped or invented too much content (forward " + fwd.toFixed(2) + ", backward " + back.toFixed(2) + ") — rotating";
                    providerErrors.push(fidMsg);
                    console.error(fidMsg);
                    attemptTimes.push({ provider: attemptName, ms: Date.now() - attemptStartMs, ok: false });
                    pushLine({ ev: "tick", pct: Math.min(88, 22 + attemptTimes.length * 6), phase: attemptName + " response lost or invented content — trying next provider" });
                    continue;
                  }
                }
              }
              // No-content-change guard (provider rotation): a provider whose
              // output contains no word-level content edit (verbatim echo,
              // "saw nothing", or cosmetic-only punctuation/quote/case/bolding
              // padding) is not a success while stronger providers remain —
              // otherwise the request silently returns a flat, unchanged score.
              // We deliberately do NOT gate this on our deterministic phrase DB
              // hitting: a text can be stiff in ways our rules do not cover, and
              // only a stronger model can fix those. After every configured
              // provider has been tried, the last parseable no-op is accepted and
              // scored honestly (flat = correct) via parsedHasRealChanges.
              if (!hasRealContentChange(parsed, bodyText) && ai < attempts.length - 1) {
                if (!lastParsed) { lastParsed = parsed; lastParsedProvider = attemptName; }
                providerErrors.push(attemptName + ": returned the text without any edits — rotating to next provider");
                console.error(attemptName + " returned the text without any edits — rotating to the next provider");
                attemptTimes.push({ provider: attemptName, ms: Date.now() - attemptStartMs, ok: false, noop: true });
                pushLine({ ev: "tick", pct: Math.min(88, 22 + attemptTimes.length * 6), phase: attemptName + " returned no edits — trying next provider" });
                continue;
              }
              attemptTimes.push({ provider: attemptName, ms: Date.now() - attemptStartMs, ok: true });
              answeredOk = true;
              pushLine({ ev: "tick", pct: 86, phase: "Model returned from " + attemptName + " — running deterministic nativization rules" });
              break;
            } catch (e) {
              var failureMsg = attemptName + ": " + String((e && e.message) || e).substring(0, 300);
              providerErrors.push(failureMsg);
              console.error(attemptName + " failed:", e && e.message);
              attemptTimes.push({ provider: attemptName, ms: Date.now() - attemptStartMs, ok: false });
              pushLine({ ev: "tick", pct: Math.min(88, 22 + attemptTimes.length * 6), phase: "Trying next model provider (" + attemptName + " failed)" });
            } finally {
              clearInterval(heartbeat);
            }
          }

          if (!answeredOk && lastParsed) {
            // Every provider returned no edits / failed; return the last
            // parseable result so the request still completes with an honest
            // (flat) outcome.
            parsed = lastParsed;
            provider = lastParsedProvider || provider;
            attemptTimes.push({ provider: provider || "last", ms: 0, ok: true });
            pushLine({ ev: "tick", pct: 86, phase: "All providers returned no edits — using last parseable result" });
          }
          if (!parsed) {
            // Rescue: every provider failed to produce a usable parse. Return the
            // original text unchanged so users always get a response instead of an
            // error — the deterministic nativization backstop below still applies
            // its safe rules, so the result stays honest and never "zero".
            parsed = deriveSentencesFromTexts(originalBodyText, bodyText);
            provider = "none";
            rescueUsed = true;
            attemptTimes.push({ provider: "none", ms: 0, ok: true });
            pushLine({ ev: "tick", pct: 86, phase: "No provider produced a usable result — returning the original text unchanged" });
          }

          if (savedFootnotes) parsed._originalFootnotes = savedFootnotes;
          if (preSweep) parsed._preSweepStats = preSweep.stats;

          var result = await ensureValidResult(parsed, text, options, env);
          if (!result) {
            pushLine({ ev: "error", message: "Invalid response from AI model" });
            try { controller.close(); } catch (e) {}
            return;
          }

          if (userId && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY && !rescueUsed) {
            await incrementUsage(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, userId);
            usage += 1;
          }

          result.provider = provider;
          result.tier = tier;
          result.usage = usage;
          if (rescueUsed) {
            result.rescued = true;
            result.providerErrors = providerErrors;
          }
          result.timing = {
            provider: provider,
            totalMs: Date.now() - providerStartMs,
            attempts: attemptTimes,
          };

          var dbMatches = result.databaseStats && typeof result.databaseStats.totalMatches === "number" ? result.databaseStats.totalMatches : 0;
          pushLine({ ev: "phase", pct: 90, phase: "Applied " + dbMatches + (dbMatches === 1 ? " deterministic nativization rule" : " deterministic nativization rules") + " backstop" });

          if (attemptTimes && attemptTimes.length > 0) {
            var accInflight = 0;
            for (var pi = 0; pi < attemptTimes.length; pi++) {
              var at = attemptTimes[pi];
              var totalKnown = Date.now() - providerStartMs;
              var share = totalKnown > 0 ? Math.round((at.ms / totalKnown) * 4) : 2;
              accInflight = Math.min(96, accInflight + Math.max(1, share));
              pushLine({
                ev: "tick",
                pct: 90 + accInflight,
                phase: at.skipped
                  ? "Model provider skipped (not configured)"
                  : at.ok
                    ? "Model returned from " + (at.provider || "") + " — finalizing"
                    : "Trying next model provider (" + (at.provider || "") + ")",
              });
            }
          }

          pushLine({ ev: "phase", pct: 98, phase: "Finalizing output..." });
          pushLine({ ev: "final", pct: 100, result: result });
          } catch (err) {
            streamErrors.push("body: " + String((err && err.stack) || (err && err.message) || err));
            pushLine({ ev: "error", message: "Transform pipeline failed: " + String((err && err.message) || err), detail: streamErrors.join(" | ") });
          } finally {
            try { controller.close(); } catch (e) {}
          }
        },
      });

      return new Response(streamBody, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Transform-Stream": "ndjson",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Expose-Headers": "X-Transform-Stream",
        },
      });

    } catch (error) {
      console.error("Worker error: " + String((error && error.message) || error).substring(0, 300));
      return jsonResponse({ error: String(error.message || error || "Unknown error").substring(0, 300) }, 500);
    }
  },
};
