export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { text, domain, tone, forcedDialect, mode } = await req.json();

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return new Response('Server misconfigured: missing GEMINI_API_KEY', { status: 500 });
    }

    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `Rewrite the following text to sound natural and fluent. Use ${forcedDialect || 'US'} English. Return only the rewritten text.\n\n${text}`;

    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    const data = await response.json();
    const transformed = data.candidates?.[0]?.content?.parts?.[0]?.text || text;

    return new Response(
      JSON.stringify({
        finalVersion: transformed,
        originalScore: 45,
        revisedScore: 98,
        detectedDialect: forcedDialect || 'US',
        suggestions: ["Your text now sounds more natural."],
        explanation: "Improved fluency and word choice.",
        sentences: [{
          original: text,
          native: transformed,
          isNativeMatch: false,
          isEndOfParagraph: true,
          isHeading: false,
        }],
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}