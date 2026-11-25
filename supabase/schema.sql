-- Hive-Notes 0.1.0 – Supabase schema
-- Run once in the Supabase SQL editor (Project → SQL Editor → New query → paste → Run).
-- Safe to run again: it only creates what is missing and replaces functions and policies.

-- ---------------------------------------------------------------- tables
create table if not exists public.hn_staff (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique check (username ~ '^[a-z0-9._-]{2,40}$'),
  full_name   text not null,
  email       text not null unique,
  role        text not null default 'staff' check (role in ('staff','admin')),
  is_pm       boolean not null default false,
  title       text,
  phone       text,
  active      boolean not null default true,
  invited_at  timestamptz,
  joined_at   timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists public.hn_config (
  key         text primary key,          -- library, register, templates, emergency, texts
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.hn_staff(id)
);

create table if not exists public.hn_notes (
  id           uuid primary key,
  section      text not null default 'safety',            -- safety, hazmat, esa … (future sections)
  kind         text not null default 'hazard_assessment',
  owner        uuid not null references public.hn_staff(id),
  pm           uuid references public.hn_staff(id),
  status       text not null default 'draft' check (status in ('draft','submitted','reviewed')),
  title        text,
  project_no   text,
  data         jsonb not null default '{}'::jsonb,
  pdf_path     text,
  submitted_at timestamptz,
  emailed_at   timestamptz,
  email_error  text,
  reviewed_at  timestamptz,
  reviewed_by  uuid references public.hn_staff(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists hn_notes_owner on public.hn_notes(owner);
create index if not exists hn_notes_pm on public.hn_notes(pm);

-- ---------------------------------------------------------------- helpers
create or replace function public.hn_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.hn_staff where id = auth.uid() and active
$$;
create or replace function public.hn_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.hn_staff where id = auth.uid() and active), false)
$$;
create or replace function public.hn_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.hn_staff where id = auth.uid() and active)
$$;

-- Sign in with a user name: returns the email for an active user name (or null).
create or replace function public.hn_login_email(p_username text) returns text
language sql stable security definer set search_path = public as $$
  select email from public.hn_staff where username = lower(trim(p_username)) and active
$$;

-- Records the first time someone signs in (shows "Active" instead of "Invited" on the staff list).
create or replace function public.hn_touch() returns void
language sql security definer set search_path = public as $$
  update public.hn_staff set joined_at = coalesce(joined_at, now()) where id = auth.uid()
$$;

-- Bootstrap: the first signed-in user becomes admin, but only while hn_staff is empty.
create or replace function public.hn_claim_first_admin(p_username text, p_full_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  perform pg_advisory_xact_lock(4711);
  if exists (select 1 from public.hn_staff) then raise exception 'Hive-Notes already has staff. Ask an admin to add you.'; end if;
  select email into v_email from auth.users where id = auth.uid();
  insert into public.hn_staff (id, username, full_name, email, role, is_pm, joined_at)
  values (auth.uid(), lower(trim(p_username)), trim(p_full_name), lower(v_email), 'admin', true, now());
end $$;

-- ---------------------------------------------------------------- note rules
-- Owners edit their own drafts and submit them. The PM (or an admin) can only mark a submitted plan reviewed.
-- Nobody but the owner or an admin can change what a plan says.
create or replace function public.hn_note_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); adm boolean := public.hn_is_admin();
begin
  if me is null then return new; end if;              -- service role (edge functions)
  if tg_op = 'INSERT' then
    if new.owner <> me then raise exception 'You can only create your own plans'; end if;
    if new.status = 'reviewed' then raise exception 'A new plan cannot start as reviewed'; end if;
    new.reviewed_at := null; new.reviewed_by := null; new.emailed_at := null; new.email_error := null;
    return new;
  end if;
  -- UPDATE
  if new.owner <> old.owner or new.id <> old.id then raise exception 'Owner cannot change'; end if;
  new.emailed_at := old.emailed_at; new.email_error := old.email_error;   -- only the server sets these
  if old.owner = me or adm then
    if old.status = 'reviewed' and not adm then raise exception 'This plan has been reviewed and is locked'; end if;
    if new.status = 'reviewed' and old.status <> 'reviewed' and old.pm is distinct from me and not adm then raise exception 'Only the PM can mark a plan reviewed'; end if;
    if new.status = 'reviewed' and old.status <> 'reviewed' then new.reviewed_at := now(); new.reviewed_by := me; end if;
    if new.status <> 'reviewed' then new.reviewed_at := null; new.reviewed_by := null; end if;
    if new.status = 'submitted' and old.status = 'draft' then new.submitted_at := coalesce(new.submitted_at, now()); end if;
    return new;
  end if;
  if old.pm = me then
    if old.status <> 'submitted' or new.status <> 'reviewed'
       or new.data is distinct from old.data or new.pm is distinct from old.pm or new.title is distinct from old.title
       or new.project_no is distinct from old.project_no or new.pdf_path is distinct from old.pdf_path
       or new.submitted_at is distinct from old.submitted_at then
      raise exception 'As the PM you can only mark a submitted plan reviewed';
    end if;
    new.reviewed_at := now(); new.reviewed_by := me;
    return new;
  end if;
  raise exception 'Not allowed';
end $$;
drop trigger if exists hn_note_guard on public.hn_notes;
create trigger hn_note_guard before insert or update on public.hn_notes for each row execute function public.hn_note_guard();

-- Staff rows: admins manage them, but nobody can demote or deactivate the last active admin.
create or replace function public.hn_staff_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.hn_is_admin() then raise exception 'Only admins can change staff'; end if;
  if (tg_op = 'DELETE' and old.role = 'admin') or (tg_op = 'UPDATE' and old.role = 'admin' and old.active and (new.role <> 'admin' or not new.active)) then
    if (select count(*) from public.hn_staff where role = 'admin' and active and id <> old.id) = 0 then
      raise exception 'Hive-Notes needs at least one active admin';
    end if;
  end if;
  if tg_op = 'UPDATE' then new.email := old.email; return new; end if;   -- email changes go through the auth admin
  return old;
end $$;
drop trigger if exists hn_staff_guard on public.hn_staff;
create trigger hn_staff_guard before update or delete on public.hn_staff for each row execute function public.hn_staff_guard();

-- ---------------------------------------------------------------- row level security
alter table public.hn_staff  enable row level security;
alter table public.hn_config enable row level security;
alter table public.hn_notes  enable row level security;

drop policy if exists hn_staff_read on public.hn_staff;
create policy hn_staff_read on public.hn_staff for select to authenticated using (public.hn_is_staff() or id = auth.uid());
drop policy if exists hn_staff_admin_upd on public.hn_staff;
create policy hn_staff_admin_upd on public.hn_staff for update to authenticated using (public.hn_is_admin()) with check (public.hn_is_admin());

drop policy if exists hn_config_read on public.hn_config;
create policy hn_config_read on public.hn_config for select to authenticated using (public.hn_is_staff());
drop policy if exists hn_config_ins on public.hn_config;
create policy hn_config_ins on public.hn_config for insert to authenticated with check (public.hn_is_admin());
drop policy if exists hn_config_upd on public.hn_config;
create policy hn_config_upd on public.hn_config for update to authenticated using (public.hn_is_admin()) with check (public.hn_is_admin());

drop policy if exists hn_notes_read on public.hn_notes;
create policy hn_notes_read on public.hn_notes for select to authenticated
  using (public.hn_is_staff() and (owner = auth.uid() or pm = auth.uid() or public.hn_is_admin()));
drop policy if exists hn_notes_ins on public.hn_notes;
create policy hn_notes_ins on public.hn_notes for insert to authenticated
  with check (public.hn_is_staff() and owner = auth.uid());
drop policy if exists hn_notes_upd on public.hn_notes;
create policy hn_notes_upd on public.hn_notes for update to authenticated
  using (public.hn_is_staff() and (owner = auth.uid() or pm = auth.uid() or public.hn_is_admin()))
  with check (public.hn_is_staff() and (owner = auth.uid() or pm = auth.uid() or public.hn_is_admin()));
drop policy if exists hn_notes_del on public.hn_notes;
create policy hn_notes_del on public.hn_notes for delete to authenticated
  using (public.hn_is_admin() or (owner = auth.uid() and status = 'draft'));

-- ---------------------------------------------------------------- grants (newer Supabase projects need these spelled out)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.hn_notes to authenticated;
grant select, insert, update on public.hn_config to authenticated;
grant select, update on public.hn_staff to authenticated;
grant execute on function public.hn_login_email(text) to anon, authenticated;
grant execute on function public.hn_touch(), public.hn_claim_first_admin(text, text), public.hn_role(), public.hn_is_admin(), public.hn_is_staff() to authenticated;
revoke execute on function public.hn_claim_first_admin(text, text) from anon;

-- ---------------------------------------------------------------- PDF storage (private bucket)
insert into storage.buckets (id, name, public) values ('hn-pdfs', 'hn-pdfs', false) on conflict (id) do nothing;

drop policy if exists hn_pdf_write on storage.objects;
create policy hn_pdf_write on storage.objects for insert to authenticated
  with check (bucket_id = 'hn-pdfs' and (storage.foldername(name))[1] = auth.uid()::text and public.hn_is_staff());
drop policy if exists hn_pdf_update on storage.objects;
create policy hn_pdf_update on storage.objects for update to authenticated
  using (bucket_id = 'hn-pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists hn_pdf_read on storage.objects;
create policy hn_pdf_read on storage.objects for select to authenticated
  using (bucket_id = 'hn-pdfs' and exists (
    select 1 from public.hn_notes n where n.pdf_path = storage.objects.name
      and (n.owner = auth.uid() or n.pm = auth.uid() or public.hn_is_admin())));
