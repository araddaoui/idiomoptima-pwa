export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { text } = await req.json();

    // Static test response (no API call)
    const testResponse = {
      finalVersion: `[Test] ${text}`,
      originalScore: 50,
      revisedScore: 85,
      detectedDialect: 'US',
      suggestions: ["This is a test response."],
      explanation: "Serverless function is working.",
      sentences: [{
        original: text,
        native: `[Test] ${text}`,
        isNativeMatch: false,
        isEndOfParagraph: true,
        isHeading: false,
      }],
    };

    return new Response(JSON.stringify(testResponse), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}