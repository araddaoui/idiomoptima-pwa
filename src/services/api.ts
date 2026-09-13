import { WORKER_URL } from "./geminiService";

export interface UserTierInfo {
  tier: "free" | "pro" | "enterprise";
  usage: number;
  limit: number;
  wordLimit?: number | null;
}

export const FREE_RUN_LIMIT = 4;
export const FREE_WORD_LIMIT = 800;

export function limitForTier(tier?: string): number {
  return tier === "pro" || tier === "enterprise" ? 9999 : FREE_RUN_LIMIT;
}

export async function getUserTier(authToken?: string): Promise<UserTierInfo | null> {
  try {
    const res = await fetch(`${WORKER_URL}/user-tier`, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as UserTierInfo;
  } catch {
    return null;
  }
}

export async function createCheckout(authToken: string, email?: string): Promise<string | null> {
  try {
    const res = await fetch(`${WORKER_URL}/create-checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ email: email || "" }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.url || null;
  } catch {
    return null;
  }
}

export async function createBillingPortal(authToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${WORKER_URL}/billing-portal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.url || null;
  } catch {
    return null;
  }
}