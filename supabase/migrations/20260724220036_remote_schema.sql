


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "deck_id" "uuid",
    "type" "text" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "result" "jsonb",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "jobs_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'processing'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."jobs" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_jobs"("p_type" "text", "p_limit" integer DEFAULT 5) RETURNS SETOF "public"."jobs"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  update public.jobs
  set status = 'processing', started_at = now(), attempt_count = attempt_count + 1
  where id in (
    select id from public.jobs
    where type = p_type and status = 'queued' and user_id = auth.uid()
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning *;
$$;


ALTER FUNCTION "public"."claim_jobs"("p_type" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_job"("p_job_id" "uuid", "p_result" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "public"."jobs"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  update public.jobs
  set status = 'completed', result = p_result, completed_at = now()
  where id = p_job_id and user_id = auth.uid() and status = 'processing'
  returning *;
$$;


ALTER FUNCTION "public"."complete_job"("p_job_id" "uuid", "p_result" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_job"("p_job_id" "uuid", "p_error" "text") RETURNS "public"."jobs"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  update public.jobs
  set status = 'failed', error = p_error, completed_at = now()
  where id = p_job_id and user_id = auth.uid() and status = 'processing'
  returning *;
$$;


ALTER FUNCTION "public"."fail_job"("p_job_id" "uuid", "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_deck_tags"("p_deck_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql"
    AS $$
  select coalesce(
    jsonb_agg(jsonb_build_object('tag', tag, 'count', cnt) order by cnt desc, tag asc),
    '[]'::jsonb
  )
  from (
    select t as tag, count(*) as cnt
    from public.notes n, unnest(n.tags) as t
    where n.user_id = auth.uid()
      and n.deck_id = p_deck_id
    group by t
  ) x;
$$;


ALTER FUNCTION "public"."get_deck_tags"("p_deck_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_stats"("p_deck_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
declare
  result jsonb;
  now_ts timestamptz := now();
begin
  select jsonb_build_object(
    'cards', jsonb_build_object(
      'total', count(*),
      'new', count(*) filter (where state = 'new'),
      'learning', count(*) filter (where state = 'learning'),
      'review', count(*) filter (where state = 'review'),
      'relearning', count(*) filter (where state = 'relearning')
    ),
    'due', jsonb_build_object(
      'now', count(*) filter (where state <> 'new' and due <= now_ts),
      'tomorrow', count(*) filter (where state <> 'new' and due <= now_ts + interval '1 day'),
      'week', count(*) filter (where state <> 'new' and due <= now_ts + interval '7 days'),
      'month', count(*) filter (where state <> 'new' and due <= now_ts + interval '30 days')
    ),
    'avgStability', avg(stability) filter (where state = 'review'),
    'avgDifficulty', avg(difficulty) filter (where state = 'review')
  )
  into result
  from public.cards
  where user_id = auth.uid()
    and (p_deck_id is null or deck_id = p_deck_id);

  select result || jsonb_build_object(
    'reviews', jsonb_build_object(
      'today', count(*) filter (where reviewed_at >= date_trunc('day', now_ts)),
      'week', count(*) filter (where reviewed_at >= date_trunc('day', now_ts) - interval '6 days'),
      'all', count(*)
    ),
    'ratingsAll', jsonb_build_object(
      'again', count(*) filter (where rating = 1),
      'hard', count(*) filter (where rating = 2),
      'good', count(*) filter (where rating = 3),
      'easy', count(*) filter (where rating = 4)
    ),
    'ratingsToday', jsonb_build_object(
      'again', count(*) filter (where rating = 1 and reviewed_at >= date_trunc('day', now_ts)),
      'hard', count(*) filter (where rating = 2 and reviewed_at >= date_trunc('day', now_ts)),
      'good', count(*) filter (where rating = 3 and reviewed_at >= date_trunc('day', now_ts)),
      'easy', count(*) filter (where rating = 4 and reviewed_at >= date_trunc('day', now_ts))
    )
  )
  into result
  from public.review_log r
  join public.cards c on c.id = r.card_id
  where r.user_id = auth.uid()
    and (p_deck_id is null or c.deck_id = p_deck_id);

  return result;
end;
$$;


ALTER FUNCTION "public"."get_stats"("p_deck_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_streak"() RETURNS "jsonb"
    LANGUAGE "sql"
    AS $$
  with days as (
    select distinct (reviewed_at at time zone 'utc')::date as d
    from public.review_log
    where user_id = auth.uid()
  ),
  grp as (
    select d, d - (row_number() over (order by d))::int as grp
    from days
  ),
  runs as (
    select grp, count(*) as len, max(d) as last_day
    from grp
    group by grp
  )
  select jsonb_build_object(
    'longest', coalesce((select max(len) from runs), 0),
    'current', coalesce((
      select len from runs
      where last_day >= (current_date - (case when exists(select 1 from days where d = current_date) then 0 else 1 end))
      order by last_day desc
      limit 1
    ), 0),
    'studiedToday', exists(select 1 from days where d = current_date)
  );
$$;


ALTER FUNCTION "public"."get_streak"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'student')
  on conflict (id) do nothing;
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


-- Not captured by `supabase db dump --schema public` (it's a trigger on
-- auth.users, outside the public schema) but confirmed present on remote via
-- direct inspection — without it, new signups never get a profiles row and
-- every is_admin()/role check for that user silently fails.
DROP TRIGGER IF EXISTS "on_auth_user_created" ON "auth"."users";
CREATE TRIGGER "on_auth_user_created" AFTER INSERT ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_user"();


CREATE OR REPLACE FUNCTION "public"."is_admin"("check_user_id" "uuid" DEFAULT "auth"."uid"()) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.profiles
    where id = check_user_id and role = 'admin'
  );
$$;


ALTER FUNCTION "public"."is_admin"("check_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."book_lessons" (
    "id" "text" NOT NULL,
    "unit" integer NOT NULL,
    "lesson_number" integer,
    "title" "text" NOT NULL,
    "subtitle" "text",
    "order_index" integer NOT NULL,
    "content" "jsonb" NOT NULL,
    "deck_id" "uuid" NOT NULL
);


ALTER TABLE "public"."book_lessons" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "note_id" "uuid" NOT NULL,
    "deck_id" "uuid" NOT NULL,
    "state" "text" DEFAULT 'new'::"text" NOT NULL,
    "step" integer DEFAULT 0 NOT NULL,
    "stability" double precision,
    "difficulty" double precision,
    "due" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_review" timestamp with time zone,
    "reps" integer DEFAULT 0 NOT NULL,
    "lapses" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."decks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "name" "text" NOT NULL,
    "source" "text" DEFAULT 'manual'::"text",
    "desired_retention" double precision DEFAULT 0.9 NOT NULL,
    "new_per_day" integer DEFAULT 20 NOT NULL,
    "review_per_day" integer DEFAULT 200 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "visibility" "text" DEFAULT 'personal'::"text" NOT NULL,
    "status" "text" DEFAULT 'published'::"text" NOT NULL,
    CONSTRAINT "decks_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text"]))),
    CONSTRAINT "decks_visibility_check" CHECK (("visibility" = ANY (ARRAY['shared'::"text", 'personal'::"text"])))
);


ALTER TABLE "public"."decks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."import_files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_id" "uuid" NOT NULL,
    "source_type" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "filename" "text" NOT NULL,
    "mime_type" "text",
    "size_bytes" bigint,
    "status" "text" DEFAULT 'idle'::"text" NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "import_files_source_type_check" CHECK (("source_type" = ANY (ARRAY['textbook'::"text", 'corrige'::"text", 'transcription'::"text"]))),
    CONSTRAINT "import_files_status_check" CHECK (("status" = ANY (ARRAY['idle'::"text", 'uploading'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."import_files" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."import_pages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_id" "uuid" NOT NULL,
    "import_file_id" "uuid",
    "source_type" "text" NOT NULL,
    "filename" "text" NOT NULL,
    "page_number" integer,
    "chunk_index" integer NOT NULL,
    "text" "text",
    "extraction_status" "text" DEFAULT 'extracted'::"text" NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "import_pages_extraction_status_check" CHECK (("extraction_status" = ANY (ARRAY['extracted'::"text", 'empty'::"text", 'unreadable'::"text"]))),
    CONSTRAINT "import_pages_source_type_check" CHECK (("source_type" = ANY (ARRAY['textbook'::"text", 'corrige'::"text", 'transcription'::"text"])))
);


ALTER TABLE "public"."import_pages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."imports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "deck_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."imports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "deck_id" "uuid" NOT NULL,
    "note_type" "text" DEFAULT 'basic'::"text" NOT NULL,
    "fields" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "review_status" "text" DEFAULT 'approved'::"text" NOT NULL,
    "confidence" "text" DEFAULT 'high'::"text" NOT NULL,
    "review_reasons" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "source_evidence" "jsonb",
    "extraction_diagnostics" "jsonb",
    CONSTRAINT "notes_confidence_check" CHECK (("confidence" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"]))),
    CONSTRAINT "notes_review_status_check" CHECK (("review_status" = ANY (ARRAY['approved'::"text", 'needs_review'::"text"])))
);


ALTER TABLE "public"."notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'student'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'student'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."review_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "card_id" "uuid" NOT NULL,
    "rating" integer NOT NULL,
    "state_before" "text" NOT NULL,
    "stability" double precision,
    "difficulty" double precision,
    "elapsed_days" double precision,
    "reviewed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."review_log" OWNER TO "postgres";


ALTER TABLE ONLY "public"."book_lessons"
    ADD CONSTRAINT "book_lessons_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cards"
    ADD CONSTRAINT "cards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."decks"
    ADD CONSTRAINT "decks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_files"
    ADD CONSTRAINT "import_files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_pages"
    ADD CONSTRAINT "import_pages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."imports"
    ADD CONSTRAINT "imports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."review_log"
    ADD CONSTRAINT "review_log_pkey" PRIMARY KEY ("id");



CREATE INDEX "book_lessons_deck_idx" ON "public"."book_lessons" USING "btree" ("deck_id", "order_index");



CREATE INDEX "cards_due_idx" ON "public"."cards" USING "btree" ("user_id", "deck_id", "due");



CREATE INDEX "cards_state_idx" ON "public"."cards" USING "btree" ("user_id", "deck_id", "state");



CREATE INDEX "import_files_import_idx" ON "public"."import_files" USING "btree" ("import_id");



CREATE INDEX "import_pages_import_idx" ON "public"."import_pages" USING "btree" ("import_id", "source_type", "chunk_index");



CREATE INDEX "jobs_user_status_idx" ON "public"."jobs" USING "btree" ("user_id", "status", "created_at");



CREATE INDEX "review_log_card_idx" ON "public"."review_log" USING "btree" ("card_id");



CREATE INDEX "review_log_user_time_idx" ON "public"."review_log" USING "btree" ("user_id", "reviewed_at");



ALTER TABLE ONLY "public"."book_lessons"
    ADD CONSTRAINT "book_lessons_deck_id_fkey" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cards"
    ADD CONSTRAINT "cards_deck_id_fkey" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cards"
    ADD CONSTRAINT "cards_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cards"
    ADD CONSTRAINT "cards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."decks"
    ADD CONSTRAINT "decks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."import_files"
    ADD CONSTRAINT "import_files_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."import_pages"
    ADD CONSTRAINT "import_pages_import_file_id_fkey" FOREIGN KEY ("import_file_id") REFERENCES "public"."import_files"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."import_pages"
    ADD CONSTRAINT "import_pages_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."imports"
    ADD CONSTRAINT "imports_deck_id_fkey" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."imports"
    ADD CONSTRAINT "imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_deck_id_fkey" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_deck_id_fkey" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notes"
    ADD CONSTRAINT "notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."review_log"
    ADD CONSTRAINT "review_log_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."review_log"
    ADD CONSTRAINT "review_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."book_lessons" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "book_lessons_delete" ON "public"."book_lessons" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "book_lessons"."deck_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "book_lessons_insert" ON "public"."book_lessons" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "book_lessons"."deck_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "book_lessons_select" ON "public"."book_lessons" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "book_lessons"."deck_id") AND (("d"."user_id" = "auth"."uid"()) OR (("d"."visibility" = 'shared'::"text") AND ("d"."status" = 'published'::"text")))))));



CREATE POLICY "book_lessons_update" ON "public"."book_lessons" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "book_lessons"."deck_id") AND ("d"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "book_lessons"."deck_id") AND ("d"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."cards" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cards_own" ON "public"."cards" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."decks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "decks_delete" ON "public"."decks" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "decks_insert" ON "public"."decks" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND (("visibility" = 'personal'::"text") OR (("visibility" = 'shared'::"text") AND "public"."is_admin"()))));



CREATE POLICY "decks_select" ON "public"."decks" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (("visibility" = 'shared'::"text") AND ("status" = 'published'::"text"))));



CREATE POLICY "decks_update" ON "public"."decks" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK ((("user_id" = "auth"."uid"()) AND (("visibility" = 'personal'::"text") OR (("visibility" = 'shared'::"text") AND "public"."is_admin"()))));



ALTER TABLE "public"."import_files" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "import_files_own" ON "public"."import_files" USING (("public"."is_admin"() AND (EXISTS ( SELECT 1
   FROM "public"."imports" "i"
  WHERE (("i"."id" = "import_files"."import_id") AND ("i"."user_id" = "auth"."uid"())))))) WITH CHECK (("public"."is_admin"() AND (EXISTS ( SELECT 1
   FROM "public"."imports" "i"
  WHERE (("i"."id" = "import_files"."import_id") AND ("i"."user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."import_pages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "import_pages_own" ON "public"."import_pages" USING (("public"."is_admin"() AND (EXISTS ( SELECT 1
   FROM "public"."imports" "i"
  WHERE (("i"."id" = "import_pages"."import_id") AND ("i"."user_id" = "auth"."uid"())))))) WITH CHECK (("public"."is_admin"() AND (EXISTS ( SELECT 1
   FROM "public"."imports" "i"
  WHERE (("i"."id" = "import_pages"."import_id") AND ("i"."user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."imports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "imports_own" ON "public"."imports" USING ((("user_id" = "auth"."uid"()) AND "public"."is_admin"())) WITH CHECK ((("user_id" = "auth"."uid"()) AND "public"."is_admin"()));



ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "jobs_delete" ON "public"."jobs" FOR DELETE USING ((("user_id" = "auth"."uid"()) AND "public"."is_admin"()));



CREATE POLICY "jobs_insert" ON "public"."jobs" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND "public"."is_admin"() AND (("deck_id" IS NULL) OR (EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "jobs"."deck_id") AND ("d"."user_id" = "auth"."uid"())))))));



CREATE POLICY "jobs_select" ON "public"."jobs" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "jobs_update" ON "public"."jobs" FOR UPDATE USING ((("user_id" = "auth"."uid"()) AND "public"."is_admin"())) WITH CHECK ((("user_id" = "auth"."uid"()) AND "public"."is_admin"()));



ALTER TABLE "public"."notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notes_delete" ON "public"."notes" FOR DELETE USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "notes"."deck_id") AND ("d"."user_id" = "auth"."uid"()))))));



CREATE POLICY "notes_insert" ON "public"."notes" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "notes"."deck_id") AND ("d"."user_id" = "auth"."uid"()))))));



CREATE POLICY "notes_select" ON "public"."notes" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "notes"."deck_id") AND ("d"."visibility" = 'shared'::"text") AND ("d"."status" = 'published'::"text"))))));



CREATE POLICY "notes_update" ON "public"."notes" FOR UPDATE USING ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "notes"."deck_id") AND ("d"."user_id" = "auth"."uid"())))))) WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "notes"."deck_id") AND ("d"."user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_select_own" ON "public"."profiles" FOR SELECT USING (("id" = "auth"."uid"()));



ALTER TABLE "public"."review_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "review_log_own" ON "public"."review_log" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON TABLE "public"."jobs" TO "anon";
GRANT ALL ON TABLE "public"."jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."jobs" TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_jobs"("p_type" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_jobs"("p_type" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_jobs"("p_type" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."complete_job"("p_job_id" "uuid", "p_result" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."complete_job"("p_job_id" "uuid", "p_result" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_job"("p_job_id" "uuid", "p_result" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."fail_job"("p_job_id" "uuid", "p_error" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."fail_job"("p_job_id" "uuid", "p_error" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fail_job"("p_job_id" "uuid", "p_error" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_deck_tags"("p_deck_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_deck_tags"("p_deck_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_deck_tags"("p_deck_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_stats"("p_deck_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_stats"("p_deck_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_stats"("p_deck_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_streak"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_streak"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_streak"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"("check_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"("check_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"("check_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON TABLE "public"."book_lessons" TO "anon";
GRANT ALL ON TABLE "public"."book_lessons" TO "authenticated";
GRANT ALL ON TABLE "public"."book_lessons" TO "service_role";



GRANT ALL ON TABLE "public"."cards" TO "anon";
GRANT ALL ON TABLE "public"."cards" TO "authenticated";
GRANT ALL ON TABLE "public"."cards" TO "service_role";



GRANT ALL ON TABLE "public"."decks" TO "anon";
GRANT ALL ON TABLE "public"."decks" TO "authenticated";
GRANT ALL ON TABLE "public"."decks" TO "service_role";



GRANT ALL ON TABLE "public"."import_files" TO "anon";
GRANT ALL ON TABLE "public"."import_files" TO "authenticated";
GRANT ALL ON TABLE "public"."import_files" TO "service_role";



GRANT ALL ON TABLE "public"."import_pages" TO "anon";
GRANT ALL ON TABLE "public"."import_pages" TO "authenticated";
GRANT ALL ON TABLE "public"."import_pages" TO "service_role";



GRANT ALL ON TABLE "public"."imports" TO "anon";
GRANT ALL ON TABLE "public"."imports" TO "authenticated";
GRANT ALL ON TABLE "public"."imports" TO "service_role";



GRANT ALL ON TABLE "public"."notes" TO "anon";
GRANT ALL ON TABLE "public"."notes" TO "authenticated";
GRANT ALL ON TABLE "public"."notes" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."review_log" TO "anon";
GRANT ALL ON TABLE "public"."review_log" TO "authenticated";
GRANT ALL ON TABLE "public"."review_log" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";


-- Bucket row (data, not schema — a schema-only dump never captures this).
-- Re-added here for local-reset fidelity; the "import-sources" RLS policy on
-- storage.objects that keys off this bucket is added by a later migration.
INSERT INTO "storage"."buckets" ("id", "name", "public")
VALUES ('import-sources', 'import-sources', false)
ON CONFLICT ("id") DO NOTHING;

-- storage.objects RLS policy for the bucket above (schema-only dump of
-- `public` never captures storage-schema policies either — confirmed via
-- direct inspection this is the one and only policy on storage.objects).
DROP POLICY IF EXISTS "import_sources_own" ON "storage"."objects";
CREATE POLICY "import_sources_own" ON "storage"."objects"
  FOR ALL
  USING (
    bucket_id = 'import-sources'
    AND public.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.imports i
      WHERE i.id::text = (storage.foldername(name))[1] AND i.user_id = auth.uid()
    )
  )
  WITH CHECK (
    bucket_id = 'import-sources'
    AND public.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.imports i
      WHERE i.id::text = (storage.foldername(name))[1] AND i.user_id = auth.uid()
    )
  );







