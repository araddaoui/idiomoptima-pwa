export default async function handler(req: Request) {
  return new Response(
    JSON.stringify({ finalVersion: "Test response from serverless function" }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}