export default async function handler(req: Request) {
  return new Response(
    JSON.stringify({ finalVersion: "Hello from serverless function" }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}