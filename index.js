const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Cache-Control, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
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

// --- Main fetch handler ----------------------------------------------
const SYSTEM_PROMPT = [
  "You are IdiomOptima, a native-English editing engine for non-native writers.",
  "You fix clear grammar, punctuation, and spelling errors AND nativize stiff,",
  "stilted, clunky, or formulaic (AI-sounding) phrasing into natural native English.",
  "You never change the author's meaning, intent, or voice.",
  "",
  "RULES:",
  "1. Return the COMPLETE text. Every word, every paragraph, every line. Nothing dropped.",
  "2. Return the title exactly as it appears in the input.",
  "3. Do NOT modify text inside quotation marks — leave quoted passages exactly as-is.",
  "4. ACTIVELY NATIVIZE. Rework stiff, wordy, formulaic, non-native, or AI-sounding",
  "   phrasing into natural, fluent native English. Tighten wordiness and redundancy.",
  "   Improve readability and flow. When the NATIVIZATION RULES list a natural native",
  "   equivalent for a phrase, use it. Never change meaning; keep the register",
  "   (academic/business/creative/general), tone, and voice.",
  "5. Do NOT use em dashes in your output.",
  "6. Preserve footnote markers [1], [2], citations, and bibliography entries exactly.",
  "7. Preserve paragraph breaks exactly as in the input — do NOT merge or split paragraphs.",
  "8. Rephrase any sentence that is stiff, awkward, redundant, informal for its register,",
  "   or reads like it was written by an AI or a non-native writer. Only leave a sentence",
  "   identical when its wording is already clear, natural, and native.",
  "9. On formal or academic text, convert informal/conversational constructions to a",
  "   formal register (e.g. 'It is like saying' -> 'It is akin to saying', 'some sort of'",
  "   -> a specific or measured quantifier) and cut filler words.",
  "10. HARD RULE: never swap a standard, correct, idiomatic construction for a mere",
  "    synonym or stylistic variant (e.g. do NOT rewrite 'in general ... in particular'",
  "    to 'generally ... especially'). Every change must be a genuine improvement, not a",
  "    cosmetic rewrite. When in doubt, leave the sentence unchanged.",
  "11. Do NOT change 'In additional to' to anything other than 'In addition to'.",
  "12. NEVER invent, append, or echo content that is not in the input — do not pad the",
  "    output or repeat sentences the model already produced.",
  "",
  "SENTENCES: Break the text into logical sentences or lines.",
  "For each sentence, return:",
  "- 'original': the sentence exactly as in the input",
  "- 'revised': the nativized/improved sentence. Polish stiff phrasing, tighten wording,",
  "  and fix errors. Identical only if the sentence is already perfectly natural.",
  "- 'explanation': For CHANGED sentences ONLY — state the improvement",
  "  (e.g. 'Nativized stiff phrasing', 'Tightened wordiness', 'Fixed subject-verb agreement').",
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
  "revisedScore (0-100): Rate the text AFTER your edits. Must be >= originalScore.",
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
  text = text.replace(/^[^A-Za-z\u00C0-\u024F\*\[]*/, "");
  text = text.replace(/\bIn additional to\b/g, "In addition to");
  return text;
}

function addQuestionMark(text) {
  if (!text) return text;
  return String(text).replace(/\b(who)\s+(knows)(\s*)[.!](\s|$)/gi, function(m, w, k, sp, tail) {
    return w + " " + k + sp + "?" + tail;
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
    // Never touch footnotes / citations / Ibid lines.
    if (/^\s*\[\d+\]/.test(s) || /^\s*Ibid\.?/i.test(s) || /\(\d{4}\)/.test(s)) return s;
    var out = s;
    // AI-ese filler removal (quote-safe). High-confidence filler a native
    // editor would cut or tighten. Each rule is sized to keep the sentence
    // grammatical; see the unit test for before/after on every case.
    out = replaceOutsideQuotes(out, function (seg) {
      // Drop the whole "It is important to note that X" / "It is worth noting
      // that X" frame, keeping its payload subject intact.
      seg = seg.replace(/\(?[Ii]t is (?:important|worth (?:noting|mentioning)|also important|interesting) (?:to note|to mention)?\s*that\s+/i, "");
      seg = seg.replace(/\(?[Ii]t is clear (?:that )?/i, "");
      seg = seg.replace(/\(?[Ii]t should be noted (?:that )?/i, "");
      // "begs the question" misuses the idiom (it means "avoids", not "raises").
      seg = seg.replace(/\bbegs the question\b/gi, "raises the question");
      // Wordy connectors -> tight native alternatives.
      seg = seg.replace(/\bat the end of the day\s*,?/gi, "ultimately,");
      seg = seg.replace(/\bwhen it comes to\s*/gi, "regarding ");
      seg = seg.replace(/\bin the realm of\s+/gi, "in ");
      seg = seg.replace(/\bdue to the fact that\s+/gi, "because ");
      seg = seg.replace(/\bon a daily basis\s*,?/gi, "daily,");
      seg = seg.replace(/\bin order to\s+/gi, "to ");
      seg = seg.replace(/\ba number of\s+/gi, "several ");
      seg = seg.replace(/\bthe fact that\s+/gi, "that ");
      // Clean a doubled separator a drop may leave ("ultimately, ," / "that ,").
      seg = seg.replace(/\s*,+\s*,/g, ", ");
      seg = seg.replace(/\s+,\s*[,;:,]/g, " ");
      return seg;
    });
    // Clean up any awkward "could be able to" / residual before/after overlaps.
    out = out.replace(/\b(?:in a) manner\s*of\b/gi, "");
    out = out.replace(/\s+/g, " ").replace(/\s,/, ",").replace(/\s+\./, ".");
    // Rule: fix a singular/plural agreement slip in a "not merely ... but ..."
    // parallelism ("not merely explanation ... but explanations ...") by
    // normalising to a parallel VERB form ("not merely to explain ... but to
    // explain ..."), which is what a native editor writes and reads naturally.
    var toVerb = {
      "explanation": "explain", "analysis": "analyse", "description": "describe",
      "interpretation": "interpret", "discussion": "discuss"
    };
    out = out.replace(
      /\bnot merely\s+(explanation|analysis|description|interpretation|discussion)s?\b(.*?)\bbut\s+(explanation|analysis|description|interpretation|discussion)s\b(.*)$/gi,
      function (mm, noun1, mid, noun2, tail) {
        var v = toVerb[noun1.toLowerCase()] || noun1;
        // The noun headed an "of"-phrase ("explanation of patterns"); the verb
        // form takes the object directly ("explain patterns"), so drop a
        // following "of" right after the verb.
        var midFixed = mid.replace(/^\s+of\b/, " ").replace(/\s+/g, " ");
        var tailFixed = tail.replace(/^\s+of\b/, " ").replace(/\s+/g, " ");
        return "not merely to " + v + midFixed + "but to " + v + tailFixed;
      }
    );
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
  // Split on non-word boundaries and restore 』' belongs to words that had 』 in
  // the ORIGINAL. Map each straight apostrophe back only for the same word base.
  var origWords = original.split(/(\s+)/);
  var revWords = revised.split(/(\s+)/);
  var revIdx = 0;
  var out = [];
  for (var i = 0; i < revWords.length; i++) {
    var rw = revWords[i];
    if (/\s+/.test(rw) || rw === "") { out.push(rw); continue; }
    // Find the earliest not-yet-mapped original word that matches this revised
    // word modulo apostrophe style, to pick up "'s" churn ("Nonneman's" vs "Nonneman’s").
    var replaced = rw;
    while (revIdx < origWords.length) {
      var ow = origWords[revIdx];
      revIdx++;
      if (/\s+/.test(ow) || ow === "") continue;
      var owNorm = ow.replace(/[\u2018\u2019]/g, "'");
      var rwNorm = rw.replace(/[\u2018\u2019]/g, "'");
      if (owNorm === rwNorm) {
        // Same word ignoring apostrophe style: reuse the original's glyph.
        replaced = ow;
        break;
      }
    }
    out.push(replaced);
  }
  return out.join("");
}

function protectQuotes(original, revised) {
  // Find all quoted text in original and restore them in revised if changed.
  // Matches double and curly single/double quotes.
  var quoteRegex = /[""\u201C\u2018]([^""\u201D\u2019]+)[""\u201D\u2019]/g;
  var result = revised;

  function extractQuotes(t) {
    var out = [];
    var re = /[""\u201C\u2018]([^""\u201D\u2019]+)[""\u201D\u2019]/g;
    var m;
    while ((m = re.exec(t)) !== null) {
      var c = m[1];
      // Skip very short or heading-like fragments.
      if (c.length < 4) continue;
      if (/^['"]?[A-Z][a-z]+:/.test(c)) continue;
      out.push({ index: m.index, content: c, full: m[0] });
    }
    return out;
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
    var oWords = words(oq.full);
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
      var restored = result.substring(0, target.index) + oq.full + result.substring(target.index + target.full.length);
      result = restored;
      used[i] = true;
    } else if (target === resQuotes[i]) {
      used[i] = true;
    }
  }
  return result;
}

function postProcessSuggestions(suggestions, originalText, finalText, sentences, preservedFootnoteCount) {
  var suggs = [];

  var changedSentences = [];
  var unchangedCount = 0;
  var footnoteCount = preservedFootnoteCount || 0;
  var correctionTypes = { grammar: 0, punctuation: 0, spelling: 0, structure: 0, other: 0 };

  if (sentences && sentences.length > 0) {
    for (var i = 0; i < sentences.length; i++) {
      var orig = (sentences[i].original || "").trim();
      var rev = (sentences[i].revised || "").trim();

      if (sentences[i].isImmutableFootnote || /^\[\d+\]/.test(orig) || /^\([A-Z][a-z]+,\s*\d{4}\)/.test(orig) || /^\s*Ibid\.?/i.test(orig)) {
        footnoteCount++;
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

  return suggs;
}

function detectDialect(text) {
  var lower = (text || "").toLowerCase();
  if (/\b(colour|behaviour|favour|flavour|harbour|labour|behaviour|colour|towards|amongst|whilst|analyse[sd]?|analysing|organisation|organise[sd]?|prioritise[sd]?|recognise[sd]?|defence|offence|licence|practise|behaviour|cheque|programme|centre|theatre|metre|fibre)\b/i.test(lower)) return "UK";
  if (/\bcanada\b|\bcanadian\b/.test(lower)) return "CA";
  if (/\baustralia\b|\baustralian\b/.test(lower)) return "AU";
  return "US";
}

async function callGemini(text, options, apiKey) {
  var dialect = options.forcedDialect || "the most likely";
  var prompt = "Domain: " + options.domain + "\nTone: " + options.tone + "\nMode: " + options.mode + "\nDialect: " + dialect + "\n\n" +
    "TASK: Fix grammar, punctuation, and spelling errors in the text below AND ACTIVELY NATIVIZE — " +
    "rework any stiff, wordy, formulaic, non-native, or AI-sounding phrasing into natural, fluent native " +
    "English, tighten unnecessary words, and improve flow, while never changing meaning, register, tone, or voice. " +
    "CRITICAL RULES: " +
    "Return the COMPLETE text from title to final footnote. Do NOT drop any content. " +
    "Do NOT modify text inside quotation marks. " +
    "Preserve footnote markers [N], citations, and bibliography entries exactly. " +
    "Rephrase any sentence that is stiff, awkward, redundant, or AI/non-native-sounding; " +
    "leave a sentence identical only when it is already perfectly natural. " +
    "Do NOT merge or split paragraphs — preserve paragraph breaks exactly. " +
    "Replace em dashes with commas. " +
    "Use '\\n\\n' between paragraphs in finalVersion. " +
    "The suggestions array MUST contain at least 3 categorized items. " +
    (options.nativizationInstruction || "") +
    "\nText:\n" + text;

  // Model candidates rotate so stale model IDs (e.g. a shut-down preview) never
  // make Gemini a fatal stop in the provider chain. A 404 / "not found" / 429
  // on one candidate moves on to the next; real auth failures still surface.
  var MODEL_CANDIDATES = ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-flash-latest"];
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
          generationConfig: { temperature: 0.4, topP: 0.9, responseMimeType: "application/json", maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 0 } },
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
      if (response.status === 404 || response.status === 429 || /not found|unavailable|does not exist/i.test(errBody)) continue;
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

var OPENROUTER_FREE_MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openai/gpt-oss-20b:free",
  "poolside/laguna-xs.2:free",
  "openrouter/free",
];

async function callOpenRouter(text, options, apiKey) {
  var dialect = options.forcedDialect || detectDialect(text);
  var prompt = "Domain: " + options.domain + "\nTone: " + options.tone + "\nMode: " + options.mode + "\nDialect: " + dialect + "\n\nTASK: Fix grammar, punctuation, and spelling errors AND ACTIVELY NATIVIZE — rework any stiff, wordy, formulaic, non-native, or AI-sounding phrasing into natural, fluent native English, tighten unnecessary words, and improve flow, while never changing meaning, register, tone, or voice. CRITICAL: Return COMPLETE text, preserve footnote markers [N], citations, quoted passages, and headings exactly, preserve paragraph breaks exactly (use \\n\\n), never invent or echo content. Return ONLY valid JSON.\n" + (options.nativizationInstruction || "") + "\nText:\n" + text;

  var queue = OPENROUTER_FREE_MODELS.slice();
  var tried = {};
  var lastError = "";
  while (queue.length > 0) {
    var model = queue.shift();
    if (tried[model]) continue;
    tried[model] = true;
    // Per-model timeout so a hanging/rate-limited free model rotates to the
    // next instead of blocking the request for minutes (client was stuck at 90%).
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 45000);
    var response;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey,
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          temperature: 0.4,
          max_tokens: 16384,
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      lastError = model + " timed out (" + String((e && e.message) || e).substring(0, 60) + ")";
      continue;
    }
    clearTimeout(timer);

    // Free models are shared and often rate-limited upstream; rotate to the
    // next one instead of failing the whole provider.
    if (response.status === 429) {
      lastError = model + " rate-limited upstream";
      continue;
    }
    if (!response.ok) {
      var errText = await response.text();
      errText = errText.substring(0, 400);
      lastError = model + ": " + errText;
      // Model moved to paid / renamed: OpenRouter tells us the replacement
      // slug ("use this slug instead: z-ai/glm-5.2"). Retry with that hint.
      var hint = /use this slug instead[:\s]+([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._:-]+)/i.exec(errText);
      if (hint && hint[1] && hint[1] !== model) {
        queue.unshift(hint[1]);
        continue;
      }
      // Other "model unavailable / not found / no such" errors: try the next model.
      var isModelIssue = /model|not found|unavailable|does not exist|deployed|slug|no such|expired/i.test(errText);
      if (isModelIssue) continue;
      throw new Error("OpenRouter error: " + errText);
    }

    var data = await response.json();
    var content = String((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "");
    if (!content) {
      lastError = model + " returned empty content";
      continue;
    }
    return content;
  }
  throw new Error("OpenRouter error: all free models unavailable. Last: " + lastError);
}

async function callDeepSeek(text, options, apiKey) {
  var dialect = options.forcedDialect || detectDialect(text);
  var prompt = "Domain: " + options.domain + "\nTone: " + options.tone + "\nMode: " + options.mode + "\nDialect: " + dialect + "\n\nTASK: Fix grammar, punctuation, and spelling errors AND ACTIVELY NATIVIZE — rework any stiff, wordy, formulaic, non-native, or AI-sounding phrasing into natural, fluent native English, tighten unnecessary words, and improve flow, while never changing meaning, register, tone, or voice. CRITICAL: Return COMPLETE text, preserve footnote markers [N], citations, quoted passages, and headings exactly, preserve paragraph breaks exactly (use \\n\\n), never invent or echo content. Return ONLY valid JSON.\n" + (options.nativizationInstruction || "") + "\nText:\n" + text;

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
      temperature: 0.4,
      max_tokens: 16384,
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!response.ok) {
    var err = await response.text();
    throw new Error("DeepSeek error: " + err.substring(0, 200));
  }

  var data = await response.json();
  return String((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "");
}

async function callCloudflareAI(text, options, ai) {
  var dialect = options.forcedDialect || detectDialect(text);
  var prompt =
    "You are IdiomOptima, a native-English editing engine. Fix grammar, punctuation, spelling, and nativize stiff/AI-sounding or clunky phrasing into natural native English per the NATIVIZATION RULES.\n" +
    "Dialect: " + dialect + " English. Domain: " + options.domain + " Tone: " + options.tone + "\n\n" +
    "RULES:\n" +
    "- Return COMPLETE text from title to final footnote — nothing dropped.\n" +
    "- Preserve footnote markers [N], citations, bibliography exactly — verbatim.\n" +
    "- Preserve paragraph breaks exactly — use \\n\\n between paragraphs.\n" +
    "- Preserve headings exactly — do NOT merge with body.\n" +
    "- ACTIVELY NATIVIZE: rework any stiff, wordy, formulaic, non-native, or AI-sounding phrasing\n" +
    "  into natural, fluent native English; tighten wordiness; improve flow. Never change meaning,\n" +
    "  register, tone, or voice. Leave a sentence identical only when it is already natural.\n" +
    "- HARD ANTI-COSMETIC RULE: NEVER swap a standard, correct, idiomatic English construction for a\n" +
    "  mere synonym just to make the text look 'edited'. In particular NEVER touch standard native\n" +
    "  academic idioms such as: in general / in particular / on the other hand / such as / as well as /\n" +
    "  in terms of / in this regard / it is important to / the majority of / in the future / the fact\n" +
    "  that / a number of / in order to. Rewriting those exact phrases cosmetically is strictly\n" +
    "  FORBIDDEN — leave them verbatim. A StiffnessRating only rises (+1..+3) when a sentence of\n" +
    "  genuinely stiff or wordy prose was ACTIVELY converted into natural fluent English (its words\n" +
    "  measurably moved), NEVER for a bare synonym/phrase swap, and NEVER when the sentence was\n" +
    "  already clean. When a sentence already is natural, keep it identical and do not invent a delta.\n" +
    "- Never gain credit or length by editing footnote markers [N], citations, or quoted passages.\n" +
    "- Do NOT use em dashes.\n" +
    "- Do NOT invent citations.\n" +
    "- Return ONLY valid JSON. No markdown fences.\n\n" +
    (options.nativizationInstruction || "") + "\n\n" +
    "JSON shape: {\"originalScore\":0-100,\"revisedScore\":0-100,\"finalVersion\":\"full text\",\"sentences\":[{\"original\":\"...\",\"revised\":\"...\",\"suggestions\":[],\"explanation\":\"note\",\"isImmutableFootnote\":false}],\"suggestions\":[],\"explanation\":\"note\",\"detectedDialect\":\"US|UK|CA|AU\"}\n\n" +
    "Text to fix:\n" + text;

  var response = await Promise.race([
    ai.run("@cf/openai/gpt-oss-20b", {
      messages: [
        { role: "system", content: "You are IdiomOptima. Return only valid JSON." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 16384,
    }),
    new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error("Cloudflare AI timed out after 60s")); }, 60000);
    }),
  ]);

  var result;
  if (typeof response === "string") {
    result = response;
  } else if (response instanceof ArrayBuffer) {
    result = new TextDecoder("utf-8").decode(response);
  } else {
    result = response && (response.response || (response.result && response.result.response) || (response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content) || JSON.stringify(response));
  }
  if (typeof result === "object" && result !== null) {
    try { result = JSON.stringify(result); } catch(e) { result = String(result); }
  }
  return String(result || "");
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
  return !!t && (/^\[\d+\]\s*/.test(t) || /^Ibid\.?/i.test(t));
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
      footnotes = gluedSplit.refs;
      body = body.substring(0, body.length - mBody[2].length).trimEnd();
      if (gluedSplit.trailing) body = (body + "\n\n" + gluedSplit.trailing).trim();
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
      result.push({
        original: orig,
        revised: rev,
        explanation: "",
        isImmutableFootnote: /^\[\d+\]/.test(orig) || /^\([A-Z][a-z]+,\s*\d{4}\)/.test(orig) || /^\s*Ibid\.?/i.test(orig),
        paragraphIndex: p,
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
        result.push({ original: "", revised: addText, explanation: "", isImmutableFootnote: false, paragraphIndex: p });
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
        && !/[.!?]$/.test(trimmed)
        && !/[,;:?!]$/.test(trimmed)
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
    var firstIdx = -1;
    for (var w = 0; w < words.length; w++) {
      var wordIdx = textLower.indexOf(words[w].toLowerCase(), searchFrom);
      if (wordIdx === -1) return -1;
      if (w === 0) firstIdx = wordIdx;
      searchFrom = wordIdx + words[w].length;
    }
    return firstIdx;
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

// Reduces a sentence to its UNDERLYING content words: citation markers ([1]),
// quote marks, and punctuation are removed so marker moves / spacing / case-only
// rewrites compare equal. Used to keep scoring and explanations honest (a moved
// "[1]" or a collapsed double space is NOT a "real improvement").
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
  aiDb: [],
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
function boldHeadingSentences(sentences) {
  if (!Array.isArray(sentences)) return sentences;
  return sentences.map(function (s) {
    if (!s) return s;
    var txt = (s.revised || "").trim();
    if (!txt) return s;
    if (s.isImmutableFootnote) return s;
    if (/^\[\d+\]/.test(txt) || /^\s*Ibid\.?/i.test(txt) || /^\([A-Z]/.test(txt)) return s;
    if (/^\*\*/.test(txt)) return s;
    if (/[.!?,;:]$/.test(txt)) return s;
    if (txt.split(/\s+/).length > 15) return s;
    if (txt.length < 1 || txt.length > 140) return s;
    if (!/^[A-Z]/.test(txt)) return s;
    if (/["'\u201C\u201D\u2018\u2019]/.test(txt.slice(0, 1)) || txt.indexOf("\n") !== -1 || txt.indexOf("  ") !== -1) return s;
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

// A compact, prompt-safe version of the DB rules so the MODEL also nativizes
// during generation (the deterministic pass below catches the rest). Cap at 250
// of the longest, clearly-AI-style phrase entries.
function buildNativizationInstruction(dbs, domain) {
  var maps = buildNativizationMaps(dbs, domain);
  var lines = [];
  for (var i = 0; i < maps.phraseList.length && lines.length < 250; i++) {
    var p = maps.phraseList[i];
    if (p.src.length >= 8) lines.push("- '" + p.src + "' -> '" + p.tgt + "'");
  }
  if (!lines.length) return "";
  return "NATIVIZATION RULES (IdiomOptima database):\n" +
    "When the text uses one of these stiff, formulaic, AI-sounding, or clunky phrases verbatim, " +
    "reword it into its natural native English equivalent ('source' -> 'target'). " +
    "Keep the meaning and the register (academic/business/creative/general) of the surrounding text. " +
    "Never apply these rules inside quotation marks, footnotes, citations, headings, or numbers. " +
    "Only apply a rule when the exact phrase appears; do not hunt for loose paraphrases.\n" +
    lines.join("\n");
}

// Built-in nativization rules that ALWAYS run (quote-safe via replaceOutsideQuotes,
// never on footnotes/citations/Ibid lines), so a real transformation happens even
// when the client database ships no matching phrases or the model is conservative.
// Only unambiguous constructions: clear misuse ("Despite of"), wordy filler
// ("due to the fact that"), and safe register swaps ("utilize" -> "use") that can
// never change the intended meaning.
var BUILTIN_NATIVIZATION = [
  { re: /\bdespite\s+of\b/gi, lower: "despite" },
  { re: /\bin\s+spite\s+of\s+the\s+fact\s+that\b/gi, lower: "although" },
  { re: /\bdue\s+to\s+the\s+fact\s+that\b/gi, lower: "because" },
  { re: /\bthe\s+reason\s+is\s+because\b/gi, lower: "the reason is that" },
  { re: /\butilize\b/gi, lower: "use" },
  { re: /\butilizes\b/gi, lower: "uses" },
  { re: /\butilized\b/gi, lower: "used" },
  { re: /\butilizing\b/gi, lower: "using" },
  { re: /\butilises\b/gi, lower: "uses" },
  { re: /\butilised\b/gi, lower: "used" },
  { re: /\butilising\b/gi, lower: "using" },
  { re: /\butilisation\b/gi, lower: "use" },
  { re: /\butilization\b/gi, lower: "use" },
  { re: /\bin\s+additional\s+to\b/gi, lower: "in addition to" },
];

// Deterministic enforcement layer: applies the exact DB replacements to each
// sentence (recap-safe via replaceOutsideQuotes, footnote/citation-safe), then
// applies the built-in nativization rules, and reports honest statistics for the
// suggestions and score.
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
    // citation when, with a leading [N] stripped, it is author-year shaped,
    // an "Ibid.", or carries a URL/DOI.
    var stripped = orig.replace(/^\s*\[\d+\]\s*/, "");
    var isCitation = stripped.length > 0 && (
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

    // 3) Built-in always-on nativization rules (quote-safe, counted as AI-style
    //    phrasing so the stats and diagnostics reflect the real transformation,
    //    even when the client DB had no matches).
    s.revised = replaceOutsideQuotes(s.revised, function (seg) {
      var out = seg;
      for (var b = 0; b < BUILTIN_NATIVIZATION.length; b++) {
        var rule = BUILTIN_NATIVIZATION[b];
        var res;
        while ((res = rule.re.exec(out)) !== null) {
          var first = res[0].charAt(0);
          var startCap = first === first.toUpperCase() && first !== first.toLowerCase();
          var rep = startCap ? rule.lower.charAt(0).toUpperCase() + rule.lower.slice(1) : rule.lower;
          out = out.substring(0, res.index) + rep + out.substring(res.index + res[0].length);
          rule.re.lastIndex = res.index + rep.length;
          bump("ai");
          changedHere = true;
        }
      }
      return out;
    });

    if (changedHere) stats.sentencesChanged++;
  });

  return { sentences: sentences, stats: stats };
}

function ensureValidResult(parsed, originalText, options) {
  if (!parsed || typeof parsed !== "object") return null;

  var finalVersion = parsed.finalVersion || parsed.final || parsed.text || "";
  if ((!finalVersion || finalVersion.length < 10) && Array.isArray(parsed.sentences) && parsed.sentences.length > 0) {
    finalVersion = parsed.sentences.map(function(s) { return s.revised || s.native || s.original || s.source || ""; }).filter(function(s) { return s.length > 0; }).join(" ");
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
    return "**" + (p1 + p2).replace(/\*\*/g, "").replace(/\s+/g, " ").trim() + "**";
  });
  // Fix concatenated bold headings with no break (e.g., "**Chapter...**Introduction**" -> two paras)
  finalVersion = finalVersion.replace(/(\*\*[^*]+\*\*)\s*(?=\*\*[A-Z])/g, "$1\n\n");
  // Also fix case where second heading lost its opening ** (e.g., "**Chapter...**Introduction**" without opening on second)
  finalVersion = finalVersion.replace(/(\*\*[^*]+\*\*)([A-Z][a-z]+[^*]*\*\*)/g, function(m, p1, p2){
    var inner = p2.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
    if(inner.length < 80 && !/[.!?]$/.test(inner)){
      return p1 + "\n\n**" + inner + "**";
    }
    return m;
  });
  // Fix single-newline between headings (e.g., "**Introduction**\nCore puzzle" -> two bold paras)
  finalVersion = finalVersion.replace(/(\*\*[^*]+\*\*)\n([A-Z][^\n]{1,80})\n/g, function(m, p1, p2){
    var t=p2.trim();
    if(t.length<80 && !/[.!?]$/.test(t) && !/^\[\d+\]/.test(t)){
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
      if(clean.length>0 && clean.length<80 && !/[.!?]$/.test(clean) && !/[,;:?!]$/.test(clean) && !cw.test(clean) && /^[A-Z]/.test(clean) && !/^\[\d+\]/.test(clean) && !/^\([A-Z]/.test(clean)){
        if(t === "**"+clean+"**") return para;
        return "**"+clean+"**";
      }
      return para;
    }).join("\n\n");
  })();

  // No-shorten guard for overall text (correct, don't bridge)
  if (finalVersion.length > 0 && originalText.length > 100 && finalVersion.length < originalText.length * 0.7) {
    finalVersion = originalText;
  }

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
    // Normalize footnote separation for the single append at the end.
    var normalizedFootnotes = savedFootnotes.replace(/\r?\n(?=\[\d+\])/g, "\n\n").replace(/\r?\n(?=\s*Ibid)/gi, "\n\n");
    // Recompute the body-only original (strip the trailing footnote block).
    var origFoot = extractFootnoteBlock(originalText);
    bodyOnlyOriginal = origFoot.body || originalText;
    // Headings the user typed WITHOUT a blank line ("Literature Review\nWith this...")
    // must still be promoted to their own paragraph, so the derive/rebuild steps
    // treat them as standalone elements instead of welding them onto the body
    // sentence (which previously DROPPED the heading from the output).
    bodyOnlyOriginal = normalizeTitleBreaks(bodyOnlyOriginal);
    // Re-strip any footnotes the model echoed inside the body (defensive).
    finalVersion = finalVersion.split(normalizedFootnotes.trim()).filter(function (p) { return p && p.trim(); }).join("\n\n");
  }

  // Re-derive sentences from paragraph-matched diff
  // First, repair any newline that falls mid-word (from the model or from
  // fuzzy paragraph-break reinsertion). "remarkable \n\nresults" -> "remarkable results".
  finalVersion = finalVersion.replace(/([A-Za-z0-9'\u2019\u2018])\r?\n\r?\n(?=[a-z])/g, function(m, c) { return c + " "; });
  finalVersion = finalVersion.replace(/([A-Za-z0-9'\u2019\u2018])\r?\n(?=[a-z])/g, function(m, c) { return c + " "; });
  var derivedS = deriveSentencesFromTexts(bodyOnlyOriginal, finalVersion);
  var sentences = derivedS.sentences;
  finalVersion = derivedS.finalVersion;
  finalVersion = addQuestionMark(finalVersion);

  // Post-process each sentence
  sentences = sentences.map(function(s) {
    s.revised = postProcessText(s.revised);
    if (s.original && s.revised && s.original !== s.revised) {
      s.revised = protectQuotes(s.original, s.revised);
      s.revised = protectAcademicRegister(s.original, s.revised);
      s.revised = restoreStructuralMarkers(s.original, s.revised);
      s.revised = protectInvariantIdioms(s.original, s.revised);
      s.revised = restoreDroppedSentence(s.original, s.revised);
      s.revised = restoreCurlyApostrophes(s.original, s.revised);
      s.revised = restoreLeadingEllipsis(s.original, s.revised);
    }
    s.revised = nativePolish(s.revised);
    s.revised = fixCommonMisspellingsSafe(s.revised);
    s.revised = capitalizeEnhanced(s.revised);
    s.revised = addQuestionMark(s.revised);
    return s;
  });

  // Database-backed nativization (deterministic enforcement layer): applies the
  // exact idiom / AI-ese / lexical replacements from the client DBs to each
  // sentence, then reports honest stats so the diff, suggestions, and score all
  // reflect the nativization instead of double-counting on the client.
  var databaseStats = { totalMatches: 0, sentencesChanged: 0, aiPhrases: 0, idioms: 0, lexical: 0 };
  if (sentences.length) {
    // Always enforced: DB phrase rules (when provided) PLUS the built-in
    // nativization rules, so a real transformation and honest stats are
    // produced even with an empty database or a conservative model.
    var dbPass = applyDatabaseNativization(sentences, options && options.databases, (options && options.domain) || "general");
    sentences = dbPass.sentences;
    databaseStats = dbPass.stats;
  }

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
      var m = /^(\*\*[^*]+\*\*)\s*\r?\n(?=\S)/.exec(r);
      // Only split when the heading is followed by a newline + real body text.
      if (m && m[0].indexOf("\n") !== -1 && r.slice(m[1].length).trim().length > 0) {
        var headKey = m[1].replace(/\*\*/g, "").toLowerCase().trim();
        if (seenHeadings[headKey]) {
          // The heading was already emitted as a standalone prior sentence;
          // keep only the body, so we don't duplicate the heading.
          var bodyOnly = r.slice(m[1].length).replace(/^\s*\r?\n+/, "").trim();
          split.push({
            original: s.original,
            revised: bodyOnly,
            explanation: s.explanation,
            isImmutableFootnote: s.isImmutableFootnote,
            paragraphIndex: s.paragraphIndex,
          });
        } else {
          seenHeadings[headKey] = true;
          split.push({
            original: s.original,
            revised: m[1],
            explanation: s.explanation === "No corrections needed." ? "No corrections needed." : "Formatted as heading.",
            isImmutableFootnote: false,
            paragraphIndex: s.paragraphIndex,
          });
          var bodyText = r.slice(m[1].length).replace(/^\s*\r?\n+/, "").trim();
          split.push({
            original: s.original,
            revised: bodyText,
            explanation: s.explanation,
            isImmutableFootnote: s.isImmutableFootnote,
            paragraphIndex: s.paragraphIndex,
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
    var origContent = orig.split(/\s+/).filter(function(w) { return !stopWords.test(w.replace(/[^a-zA-Z]/g, "")); });
    var revContent = revised.split(/\s+/).filter(function(w) { return !stopWords.test(w.replace(/[^a-zA-Z]/g, "")); });
    var removed = origContent.filter(function(w) { return revContent.indexOf(w) === -1; });
    var added = revContent.filter(function(w) { return origContent.indexOf(w) === -1; });
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

  // Scoring based on text quality
  // origScore reflects the quality of the SOURCE text (from the model's rating,
  // clamped to a sane range and capped if the source shows obvious errors).
  var origScore = safeScore(parsed.originalScore, 85);
  var hasDuplicateWords = /\b(\w+)\s+\1\b/.test(originalText);
  if (hasDuplicateWords) origScore = Math.min(origScore, 85);
  var remainingSpelling = countMisspellings(sentences.map(function (s) { return s.revised || ""; }).join(" "));

  // Count REAL content changes (ignore trivial punctuation/case-only rewrites
  // from the AI echo that padded earlier scores). Also EXCLUDE changes confined
  // to quoted material — the model must never gain score by editing citations or
  // quoted passages (Fix 4).
  function stripQuotes(t) {
    return String(t || "").replace(/[""\u201C\u201D\u2018\u2019][^""\u201C\u201D\u2018\u2019]*[""\u201C\u201D\u2018\u2019]/g, " ");
  }
  // Accumulates BOTH measured signals the honest score below needs:
  //   realChangeCount = how many sentences really changed content (cosmetic
  //     quote/punctuation/case-only echo never counts, and changes confined to
  //     quoted material never count — the model can't gain score by editing
  //     citations or quoted passages, Fix 4).
  //   magnitudeAll = how many content tokens the revision ACTUALLY displaced
  //     across those really-changed sentences (symmetric word-difference), used
  //     to weight the score so a lone cosmetic phrase-swap earns only a tiny
  //     nudge while a genuine multi-sentence rewrite rises fully.
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
  var realChangeCount = 0;
  var magnitudeAll = 0;
  sentences.forEach(function (s) {
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

  // Deterministic, honest scoring anchored to MEASURED quality rather than the
  // provider's per-run "originalScore" guess (which under-rates clean academic
  // text and previously dragged clean output down to the 80s).
  //
  // Rules:
  //  - Residual misspellings in the output => output is NOT high: cap at 80.
  //  - Clean output => it is native-level prose by definition (no detectable
  //    residual defects), so it lands in the 90s, nudging up slightly with how
  //    much the revision actually had to fix.
  //  - The ORIGINAL score honestly reflects the flaws the revision removed:
  //    each real fix deducts from the output score. No real fixes => input and
  //    output are equal (the text already was native).
  // This keeps scores honest (no invented deltas) while never letting a clean
  // corrected text print below the 90s.
  //
  // The bump here is driven by TWO measured signals: how MANY sentences really
  // changed AND how much of their wording actually moved (word magnitude), so a
  // lone cosmetic phrase-swap can no longer manufacture a +11 — it earns a small
  // honest nudge, while a genuine multi-sentence rewrite still rises fully.
  var revScore = origScore;
  if (remainingSpelling > 0) {
    // Output still carries spelling errors: it cannot be rewarded a high score,
    // and neither can the original. Cap BOTH so revScore never dips below
    // origScore (keeps the honest "no improvement claimed" flat or equal line).
    revScore = Math.min(origScore, 80);
    origScore = Math.min(origScore, 80);
  } else if (realChangeCount === 0) {
    // Nothing real changed => input and output are the same native-level prose.
    // Flat line: do NOT invent a delta the edits never earned.
    revScore = origScore;
  } else {
    // Magnitude-weighted honest bump. magnitudeAll is the total number of
    // content words the revision ACTUALLY displaced across the really-changed
    // sentences. We map (magnitudeAll + a per-sentence base) onto a modest band:
    //   weight = clamp(0..9, round((magnitudeAll + 6 * realChangeCount) / 8))
    // so ~8-12 words of real change is worth roughly the same sustained bump as
    // one heavily-rewritten sentence; tiny cosmetic swaps land at +1..+2, and a
    // genuine multi-sentence rewrite (say 6 sentences, ~30 words moved) rises
    // to +8. Deltas stay small and honest in every regime.
    var HONEST_BUMP_DIVISOR = 8;
    var weight = Math.min(9, Math.max(1, Math.round((magnitudeAll + 6 * realChangeCount) / HONEST_BUMP_DIVISOR)));
    revScore = Math.min(98, 91 + weight);
    revScore = Math.max(revScore, origScore);
    if (realChangeCount > 0) {
      // Input carried the defects the output now lacks, so dock it proportionally
      // to how much real editing was required. Floor keeps genuinely-strong prose
      // honest (a barely-touched clean text is not a 50).
      origScore = Math.max(62, Math.min(origScore, revScore - Math.min(8, 2 + realChangeCount * 2)));
    } else {
      // Nothing real needed changing => the original already was native-level.
      origScore = revScore;
    }
  }

  var preservedFootnoteCount = 0;
  if (savedFootnotes && savedFootnotes.trim()) {
    preservedFootnoteCount = (savedFootnotes.match(/^\s*(\[\]?\d+\]|\[\d+\]|Ibid\.?)/gim) || []).length ||
      savedFootnotes.split(/\n\n+/).filter(function (l) { return /^\[\d+\]|^Ibid\.?/i.test(l.trim()); }).length;
    if (preservedFootnoteCount === 0 && savedFootnotes.trim()) preservedFootnoteCount = 1;
  }

  var suggestions = postProcessSuggestions(
    Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    originalText,
    finalVersion,
    sentences,
    preservedFootnoteCount
  );

  // Surface the deterministic nativization work as the FIRST summary line so the
  // panel text can never contradict the applied transformations.
  if (databaseStats.totalMatches > 0) {
    suggestions.unshift(databaseStats.totalMatches + " stiff/AI-sounding phrase(s) nativized using IdiomOptima's nativization rules.");
  }

  // Deterministic summary, derived from the SAME real-change/spelling signals the
  // scores use, so the panel text can never contradict the score delta (fixes the
  // "70->77" + "No corrections needed" desync: the model's free-text explanation
  // disagreed with our scoring, so we stop trusting it entirely).
  var summary;
  if (remainingSpelling > 0) {
    summary = "The revision corrected several issues, but " + remainingSpelling + " spelling error(s) remain in the output.";
  } else if (realChangeCount > 0) {
    summary = "The revision made " + realChangeCount + " real improvement" + (realChangeCount === 1 ? "" : "s") +
      ", nativizing and refining the writing to native-level English.";
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
        });
      });
  }

  return {
    originalScore: origScore,
    revisedScore: revScore,
    finalVersion: finalVersion,
    sentences: sentences,
    suggestions: suggestions,
    explanation: summary,
    detectedDialect: dialect,
    databaseStats: databaseStats,
  };
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
      return jsonResponse({
        status: "ok",
        timestamp: Date.now(),
        configuredProviders: {
          gemini: !!env.GEMINI_API_KEY,
          openrouter: !!env.OPENROUTER_API_KEY,
          deepseek: !!env.DEEPSEEK_API_KEY,
          cloudflare: !!env.AI,
        },
      });
    }

    // -- Stripe webhook ---------------------------------------------
    if (request.method === "POST" && path === "/stripe-webhook") {
      return handleStripeWebhook(request, env);
    }

    // -- Create Stripe Checkout session -----------------------------
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

    // -- Get user tier + usage --------------------------------------
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

    // -- Main transformation (POST) ---------------------------------
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
      options.nativizationInstruction = buildNativizationInstruction(options.databases, options.domain);

      if (!text) {
        return jsonResponse({ error: "No text provided" }, 400);
      }

      // -- Pre-process: extract footnotes, normalize titles ----------
      var extracted = extractFootnoteBlock(text);
      var bodyText = normalizeTitleBreaks(extracted.body);
      var savedFootnotes = extracted.footnotes;

      // -- Auth + tier check ----------------------------------------
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

      // -- Provider routing based on tier ---------------------------
      // Build an ordered attempt chain: [name, fn-or-null].
      // Pro: Gemini (best quality + long docs) -> OpenRouter -> DeepSeek.
      // Free: OpenRouter (cheapest) -> Cloudflare AI -> Gemini -> DeepSeek.
      // Long free texts (>= 8000 chars) skip OpenRouter/Cloudflare and go straight to Gemini/DeepSeek.
      var attempts = [];
      if (tier === "pro" || tier === "enterprise") {
        attempts.push(["gemini", env.GEMINI_API_KEY ? function () { return callGemini(bodyText, options, env.GEMINI_API_KEY); } : null]);
        attempts.push(["openrouter", env.OPENROUTER_API_KEY ? function () { return callOpenRouter(bodyText, options, env.OPENROUTER_API_KEY); } : null]);
        attempts.push(["deepseek", env.DEEPSEEK_API_KEY ? function () { return callDeepSeek(bodyText, options, env.DEEPSEEK_API_KEY); } : null]);
      } else {
        if (bodyText.length < 8000) {
          attempts.push(["openrouter", env.OPENROUTER_API_KEY ? function () { return callOpenRouter(bodyText, options, env.OPENROUTER_API_KEY); } : null]);
          attempts.push(["cloudflare", env.AI ? function () { return callCloudflareAI(bodyText, options, env.AI); } : null]);
        } else {
          attempts.push(["openrouter", null]);
          attempts.push(["cloudflare", null]);
        }
        attempts.push(["gemini", env.GEMINI_API_KEY ? function () { return callGemini(bodyText, options, env.GEMINI_API_KEY); } : null]);
        attempts.push(["deepseek", env.DEEPSEEK_API_KEY ? function () { return callDeepSeek(bodyText, options, env.DEEPSEEK_API_KEY); } : null]);
      }

      var parsed = null;
      var provider = "none";
      var providerErrors = [];
      var attemptTimes = [];
      var providerStartMs = Date.now();

      for (var ai = 0; ai < attempts.length; ai++) {
        var attempt = attempts[ai];
        var attemptName = attempt[0];
        var attemptFn = attempt[1];
        provider = attemptName;
        if (!attemptFn) {
          providerErrors.push(attemptName + ": skipped (not configured" + (bodyText.length >= 8000 && attemptName !== "gemini" && attemptName !== "deepseek" ? " / too long" : "") + ")");
          attemptTimes.push({ provider: attemptName, ms: 0, ok: false, skipped: true });
          continue;
        }
        var attemptStartMs = Date.now();
        try {
          var rawA = await attemptFn();
          parsed = parseJsonFromModel(rawA);
          // Guard against models that stringify nested objects (prevents "[object Object]" corruption)
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
            console.error(unparseableMsg + " | First 200 chars: " + String(rawA).substring(0, 200));
            continue;
          }
          if (!parsed) {
            var unparseableMsg = attemptName + ": unparseable model output (length " + String(rawA).length + ")";
            providerErrors.push(unparseableMsg);
            console.error(unparseableMsg + " | First 200 chars: " + String(rawA).substring(0, 200));
            attemptTimes.push({ provider: attemptName, ms: Date.now() - attemptStartMs, ok: false });
            continue;
          }
          attemptTimes.push({ provider: attemptName, ms: Date.now() - attemptStartMs, ok: true });
          break;
        } catch (e) {
          var failureMsg = attemptName + ": " + String((e && e.message) || e).substring(0, 300);
          providerErrors.push(failureMsg);
          console.error(attemptName + " failed:", e && e.message);
          attemptTimes.push({ provider: attemptName, ms: Date.now() - attemptStartMs, ok: false });
        }
      }

      if (!parsed) {
        var configuredNow = {
          gemini: !!env.GEMINI_API_KEY,
          openrouter: !!env.OPENROUTER_API_KEY,
          deepseek: !!env.DEEPSEEK_API_KEY,
          cloudflare: !!env.AI,
        };
        var configuredList = Object.keys(configuredNow).filter(function (k) { return configuredNow[k]; });
        var message;
        var missingKeys = [];
        if (configuredList.length === 0) {
          missingKeys = ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"];
          message = "No AI provider is configured. Set at least one of " + missingKeys.join(", ") +
            " as a Cloudflare Worker secret (wrangler.toml vars) and redeploy. OpenRouter is recommended for the free tier.";
        } else if (providerErrors.length > 0 && providerErrors.every(function (e) { return e.indexOf("not configured") !== -1; })) {
          message = "No AI provider is reachable for this request tier. Configured but skipped: " + providerErrors.join("; ") + ".";
        } else {
          message = "The AI service is temporarily unavailable. Please try again in a few minutes. If this persists, check that the provider API keys / free-model quotas are valid.";
        }
        return jsonResponse({
          error: message,
          detail: "Attempts: " + providerErrors.join(" | ") + ". Last provider: " + provider + ".",
          configuredProviders: configuredNow,
        }, 502);
      }

      // Pass saved footnotes through for preservation
      if (savedFootnotes) parsed._originalFootnotes = savedFootnotes;

      var result = ensureValidResult(parsed, text, options);
      if (!result) {
        return jsonResponse({ error: "Invalid response from AI model" }, 502);
      }

      // -- Increment usage ------------------------------------------
      if (userId && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
        await incrementUsage(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, userId);
        usage += 1;
      }

      result.provider = provider;
      result.tier = tier;
      result.usage = usage;
      result.timing = {
        provider: provider,
        totalMs: Date.now() - providerStartMs,
        attempts: attemptTimes,
      };
      return jsonResponse(result);

    } catch (error) {
      console.error("Worker error:", error);
      return jsonResponse({ error: String(error.message || error || "Unknown error") }, 500);
    }
  },
};
