import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function getUserTier(clerkId: string): Promise<string> {
  const { data } = await supabase
    .from("users")
    .select("subscription_tier")
    .eq("clerk_id", clerkId)
    .single();
  return data?.subscription_tier || "free";
}

export async function getUsageCount(clerkId: string): Promise<number> {
  const today = new Date().toISOString().split("T")[0];
  const { data } = await supabase
    .from("usage")
    .select("request_count")
    .eq("user_id", clerkId)
    .eq("date", today)
    .single();
  return data?.request_count || 0;
}

export async function incrementUsage(clerkId: string): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const { error } = await supabase.rpc("increment_usage", {
    p_user_id: clerkId,
    p_date: today,
  });
  if (error) {
    console.error("Failed to increment usage:", error);
  }
}
