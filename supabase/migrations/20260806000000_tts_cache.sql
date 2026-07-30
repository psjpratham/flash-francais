-- Generate-on-first-click TTS cache: the tts-speak Edge Function is the only
-- writer/reader of this table and its storage bucket, always via a service-
-- role client (bypasses RLS by design — see dispatch-import-work for the
-- same pattern). No client ever queries this table or bucket directly, so
-- RLS is enabled with zero policies: a deliberate default-deny lockout for
-- both anon and authenticated roles.
--
-- Cached by a hash of the exact text spoken (never per-card), so the same
-- word/sentence reused across different cards/decks/users is only ever
-- synthesized once.

create table if not exists public.tts_cache (
  id uuid primary key default gen_random_uuid(),
  text_hash text not null unique,
  source_text text not null,
  storage_path text not null,
  created_at timestamptz not null default now()
);

alter table public.tts_cache enable row level security;

insert into storage.buckets (id, name, public)
values ('tts-cache', 'tts-cache', false)
on conflict (id) do nothing;
