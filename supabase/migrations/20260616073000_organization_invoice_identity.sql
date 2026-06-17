-- Adds business identity fields used by invoice print headers.
-- Safe to run multiple times.

alter table if exists public.organizations
  add column if not exists gst_number text,
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists fssai text,
  add column if not exists website text,
  add column if not exists address text,
  add column if not exists branch_name text default 'Main Branch',
  add column if not exists updated_at timestamptz default now();
