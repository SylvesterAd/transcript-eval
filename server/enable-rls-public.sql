-- ============================================================================
-- Security fix: enable Row Level Security on all public tables
-- ============================================================================
-- Supabase advisor `rls_disabled_in_public` (ERROR): every table in the
-- `public` schema is reachable through the auto-generated PostgREST API with
-- the publishable/anon key. Without RLS, anyone holding that browser-exposed
-- key (VITE_SUPABASE_PUBLISHABLE_KEY) can read/write these tables directly.
--
-- This app does NOT need any public/anon access to tables:
--   * the browser uses Supabase for auth ONLY (supabase.auth.*) — it never
--     calls .from()/.rpc()/.storage on these tables;
--   * all table I/O goes through the Express backend using
--     SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY, which map to the
--     `service_role` (BYPASSRLS) Postgres role and are UNAFFECTED by RLS.
--
-- Therefore: enable RLS with NO policies. anon/authenticated get zero table
-- access via the API; the backend keeps full access. This mirrors the pattern
-- already applied to `images` and `index_tag_cache` (RLS on, 0 policies),
-- which proves the app continues to work.
--
-- Idempotent and safe to re-run. Rollback for any table, if ever needed:
--   ALTER TABLE public.<table> DISABLE ROW LEVEL SECURITY;
-- ============================================================================

ALTER TABLE public.analysis_records          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_logs                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_records           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broll_editor_state        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broll_example_sets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broll_example_sources     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broll_jobs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broll_placement_uuids     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broll_runs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broll_search_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broll_searches            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broll_strategies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broll_strategy_versions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deletion_annotations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diff_cache                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.envato_ip_cooldown        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.envato_stress_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiment_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.experiments               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.export_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exports                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gpu_commands              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gpu_cost_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gpu_machines              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graphics_messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graphics_render_iterations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graphics_renders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.graphics_sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.indexed_videos            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metrics                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitored_folders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_versions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_stage_outputs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spending_log              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategies                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy_versions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.token_transactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcripts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_tokens               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_groups              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.videos                    ENABLE ROW LEVEL SECURITY;
