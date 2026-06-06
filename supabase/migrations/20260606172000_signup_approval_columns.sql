-- Ensure approval-based signup has the columns used by the app and admin panel.

create table if not exists public.pending_users (
  id uuid primary key,
  email text not null,
  full_name text,
  business_name text,
  phone text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.profiles
  add column if not exists full_name text,
  add column if not exists role text not null default 'user',
  add column if not exists approved boolean not null default false,
  add column if not exists business_created boolean not null default false,
  add column if not exists is_suspended boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.pending_users
  add column if not exists full_name text,
  add column if not exists business_name text,
  add column if not exists phone text,
  add column if not exists status text not null default 'pending',
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists pending_users_email_unique
  on public.pending_users (lower(email));

alter table if exists public.pending_users enable row level security;

drop policy if exists "public can request approval" on public.pending_users;
create policy "public can request approval"
  on public.pending_users
  for insert
  with check (status = 'pending');

drop policy if exists "admins can manage pending users" on public.pending_users;
create policy "admins can manage pending users"
  on public.pending_users
  for all
  using (public.is_platform_admin())
  with check (public.is_platform_admin());
