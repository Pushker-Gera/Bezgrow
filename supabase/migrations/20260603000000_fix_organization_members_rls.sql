-- Fix organization membership RLS recursion and align membership checks with
-- the organization_members table used by the application.

create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members om
    join public.profiles p on p.id = om.user_id
    where om.user_id = auth.uid()
      and om.organization_id = target_org_id
      and coalesce(p.approved, false) = true
      and coalesce(p.is_suspended, false) = false
  );
$$;

alter table if exists public.organization_members enable row level security;

drop policy if exists "members can read own memberships" on public.organization_members;
drop policy if exists "members can insert own memberships" on public.organization_members;
drop policy if exists "members can update own memberships" on public.organization_members;
drop policy if exists "admins can manage organization members" on public.organization_members;
drop policy if exists "organization members can read memberships" on public.organization_members;
drop policy if exists "organization members can write memberships" on public.organization_members;

create policy "members can read own memberships"
  on public.organization_members
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_platform_admin());

create policy "members can insert own memberships"
  on public.organization_members
  for insert
  to authenticated
  with check (user_id = auth.uid() or public.is_platform_admin());

create policy "members can update own memberships"
  on public.organization_members
  for update
  to authenticated
  using (user_id = auth.uid() or public.is_platform_admin())
  with check (user_id = auth.uid() or public.is_platform_admin());

create policy "admins can manage organization members"
  on public.organization_members
  for delete
  to authenticated
  using (public.is_platform_admin());
