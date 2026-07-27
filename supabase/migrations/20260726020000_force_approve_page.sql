-- Every unresolved_warnings entry that reaches a 'needs_review' page is, by
-- definition, a warning rather than a hard error — a page whose extraction
-- genuinely failed never reaches 'needs_review' at all (it's marked
-- 'failed' with no approvable content). So "no approval while warnings
-- exist" was too strict: the admin should be able to look at a warning,
-- judge it as acceptable, and approve anyway — just with that decision
-- recorded, not silently.

alter table public.page_extractions
  add column if not exists approved_with_warnings boolean not null default false,
  add column if not exists approval_override_reason text;

create or replace function public.approve_page_extraction(
  p_page_extraction_id uuid,
  p_force boolean default false,
  p_override_reason text default null
)
returns public.page_extractions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.page_extractions;
  v_import_id uuid;
  v_all_approved boolean;
  v_has_warnings boolean;
begin
  select pe.* into v_row
  from public.page_extractions pe
  join public.import_pages ip on ip.id = pe.page_id
  join public.imports i on i.id = ip.import_id
  where pe.id = p_page_extraction_id and i.user_id = auth.uid() and public.is_admin()
  for update of pe;

  if not found then
    raise exception 'page extraction not found, or you do not have permission to approve it';
  end if;

  v_has_warnings := jsonb_array_length(coalesce(v_row.unresolved_warnings, '[]'::jsonb)) > 0;

  if v_has_warnings and not p_force then
    raise exception 'cannot approve a page extraction with unresolved warnings without force=true';
  end if;

  if v_has_warnings and p_force and (p_override_reason is null or btrim(p_override_reason) = '') then
    raise exception 'a reason is required to approve a page with unresolved warnings';
  end if;

  update public.page_extractions
  set
    status = 'approved',
    reviewed_at = now(),
    reviewed_by = auth.uid(),
    updated_at = now(),
    approved_with_warnings = v_has_warnings,
    approval_override_reason = case when v_has_warnings then p_override_reason else null end
  where id = p_page_extraction_id
  returning * into v_row;

  select ip.import_id into v_import_id
  from public.import_pages ip
  where ip.id = v_row.page_id;

  -- "current extraction" per page = max version; approved only if every
  -- page's current extraction is itself approved.
  select not exists (
    select 1
    from public.import_pages ip
    join lateral (
      select pe2.status
      from public.page_extractions pe2
      where pe2.page_id = ip.id
      order by pe2.version desc
      limit 1
    ) current_pe on true
    where ip.import_id = v_import_id and current_pe.status <> 'approved'
  ) into v_all_approved;

  if v_all_approved then
    update public.imports set status = 'completed', updated_at = now() where id = v_import_id;
  end if;

  return v_row;
end;
$$;

grant execute on function public.approve_page_extraction(uuid, boolean, text) to authenticated;

-- The old two-argument-less signature is replaced, not overloaded — drop it
-- explicitly so PostgREST doesn't have two ambiguous approve_page_extraction
-- entries to choose between.
drop function if exists public.approve_page_extraction(uuid);
