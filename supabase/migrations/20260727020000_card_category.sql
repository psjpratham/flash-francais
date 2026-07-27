-- Card-recipe extraction, step 3: a semantic category tag per card, used
-- purely to drive icon/accent-color decoration the frontend fully controls
-- (see src/lib/readModeRenderers.ts) — never raw CSS from the model, which
-- was considered and rejected (CSS is a real injection/exfiltration
-- surface: background: url(...), @import, attribute-selector sniffing, and
-- un-scoped rules can reach outside their own element). The model only
-- picks a closed category label; we own every pixel of what that label
-- looks like.

alter table public.page_blocks
  add column if not exists category text;
