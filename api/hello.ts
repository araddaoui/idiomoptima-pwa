export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { text } = await req.json();

    // Mock response that matches your TransformationResult interface
    const mockResponse = {
      finalVersion: `[Mock] ${text}`,
      originalScore: 45,
      revisedScore: 98,
      detectedDialect: 'US',
      suggestions: ["Your text now sounds more natural."],
      explanation: "Mock response from serverless function",
      sentences: [{
        original: text,
        native: `[Mock] ${text}`,
        isNativeMatch: false,
        isEndOfParagraph: true,
        isHeading: false,
      }],
    };

    return new Response(JSON.stringify(mockResponse), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}