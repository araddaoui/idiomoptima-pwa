export default async function handler(req: Request) {
  return new Response(
    JSON.stringify({ message: "Hello from Vercel!" }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}