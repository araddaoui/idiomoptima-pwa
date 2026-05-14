export const config = {
  runtime: 'nodejs18',
};

export default async function handler(req: Request) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { text, domain, tone, dialect } = await req.json();

    // For now, return a mock response (replace with real API later)
    const mockTransformed = `[Mock] ${text} (This would be the nativized version using ${dialect || 'US'} English, ${tone} tone, for ${domain} context.)`;

    return new Response(
      JSON.stringify({
        finalVersion: mockTransformed,
        originalScore: 45,
        revisedScore: 98,
        detectedDialect: dialect || 'US',
        suggestions: ["Your text now sounds more natural."],
        explanation: "Improved fluency and word choice."
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Handler error:', error);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}