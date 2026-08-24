-- IdiomOptima Supabase Schema
-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard)

-- Users table
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  clerk_id text unique not null,
  email text not null,
  subscription_tier text not null default 'free',
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamp with time zone default now()
);

-- Daily usage tracking
create table if not exists usage (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(clerk_id) on delete cascade,
  date date not null default current_date,
  request_count integer not null default 0,
  unique(user_id, date)
);

-- Auto-create user on signup (via Clerk webhook or manual)
-- This function upserts a user row
create or replace function upsert_user(
  p_clerk_id text,
  p_email text
) returns void as $$
begin
  insert into users (clerk_id, email)
  values (p_clerk_id, p_email)
  on conflict (clerk_id) do update
    set email = excluded.email;
end;
$$ language plpgsql;

-- Increment daily usage (atomic)
create or replace function increment_usage(
  p_user_id text,
  p_date date
) returns void as $$
begin
  insert into usage (user_id, date, request_count)
  values (p_user_id, p_date, 1)
  on conflict (user_id, date)
  do update set request_count = usage.request_count + 1;
end;
$$ language plpgsql;

-- Get user tier (for worker use)
create or replace function get_user_tier(
  p_clerk_id text
) returns text as $$
declare
  tier text;
begin
  select subscription_tier into tier
  from users
  where clerk_id = p_clerk_id;

  return coalesce(tier, 'free');
end;
$$ language plpgsql;

-- Get daily usage count (for worker use)
create or replace function get_daily_usage(
  p_user_id text,
  p_date date
) returns integer as $$
declare
  cnt integer;
begin
  select request_count into cnt
  from usage
  where user_id = p_user_id and date = p_date;

  return coalesce(cnt, 0);
end;
$$ language plpgsql;

-- Index for fast lookups
create index if not exists idx_users_clerk_id on users(clerk_id);
create index if not exists idx_usage_user_date on usage(user_id, date);

-- Enable Row Level Security (optional, for direct client access)
alter table users enable row level security;
alter table usage enable row level security;
