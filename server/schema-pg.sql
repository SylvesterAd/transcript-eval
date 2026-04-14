-- Transcript Workflow Evaluation System - PostgreSQL Schema
-- All migration columns are inlined into table definitions

CREATE TABLE IF NOT EXISTS video_groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  assembly_status TEXT,
  assembly_error TEXT,
  assembled_transcript TEXT,
  assembly_details_json TEXT,
  upload_batch_id TEXT,
  timeline_json TEXT,
  rough_cut_config_json TEXT,
  sync_mode TEXT,
  editor_state_json TEXT,
  classification_json TEXT,
  parent_group_id INTEGER REFERENCES video_groups(id),
  annotations_json TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  youtube_url TEXT,
  duration_seconds INTEGER,
  metadata_json TEXT DEFAULT '{}',
  file_path TEXT,
  thumbnail_path TEXT,
  video_type TEXT DEFAULT 'raw',
  group_id INTEGER REFERENCES video_groups(id),
  transcription_status TEXT,
  transcription_error TEXT,
  media_type TEXT DEFAULT 'video',
  frames_status TEXT,
  media_info_json TEXT,
  cf_stream_uid TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transcripts (
  id SERIAL PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  type TEXT NOT NULL CHECK (type IN ('raw', 'human_edited', 'rough_cut_adjusted')),
  content TEXT NOT NULL,
  word_timestamps_json TEXT,
  alignment_json TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(video_id, type)
);

CREATE TABLE IF NOT EXISTS strategies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_main INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id SERIAL PRIMARY KEY,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id),
  version_number INTEGER NOT NULL,
  stages_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(strategy_id, version_number)
);

CREATE TABLE IF NOT EXISTS experiments (
  id SERIAL PRIMARY KEY,
  strategy_version_id INTEGER NOT NULL REFERENCES strategy_versions(id),
  name TEXT NOT NULL,
  notes TEXT,
  video_ids_json TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS experiment_runs (
  id SERIAL PRIMARY KEY,
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  video_id INTEGER NOT NULL REFERENCES videos(id),
  run_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'failed', 'partial')),
  total_score REAL,
  score_breakdown_json TEXT,
  total_tokens INTEGER,
  total_cost REAL,
  total_runtime_ms INTEGER,
  error_message TEXT,
  stages_snapshot_json TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS run_stage_outputs (
  id SERIAL PRIMARY KEY,
  experiment_run_id INTEGER NOT NULL REFERENCES experiment_runs(id),
  stage_index INTEGER NOT NULL,
  stage_name TEXT NOT NULL,
  input_text TEXT NOT NULL,
  output_text TEXT NOT NULL,
  prompt_used TEXT,
  system_instruction_used TEXT,
  model TEXT,
  params_json TEXT DEFAULT '{}',
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost REAL,
  runtime_ms INTEGER,
  llm_response_raw TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metrics (
  id SERIAL PRIMARY KEY,
  run_stage_output_id INTEGER NOT NULL REFERENCES run_stage_outputs(id),
  comparison_type TEXT NOT NULL CHECK (comparison_type IN ('raw_vs_human', 'raw_vs_current', 'human_vs_current')),
  diff_percent REAL,
  similarity_percent REAL,
  delta_vs_previous_stage REAL,
  timecode_preservation_score REAL,
  pause_marker_preservation_score REAL,
  formatting_score REAL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deletion_annotations (
  id SERIAL PRIMARY KEY,
  run_stage_output_id INTEGER REFERENCES run_stage_outputs(id),
  video_id INTEGER REFERENCES videos(id),
  comparison_type TEXT NOT NULL CHECK (comparison_type IN ('raw_vs_human', 'raw_vs_current', 'human_vs_current')),
  deleted_text TEXT NOT NULL,
  position_start INTEGER,
  position_end INTEGER,
  reason TEXT NOT NULL DEFAULT 'unclassified' CHECK (reason IN ('filler_word', 'false_start', 'meta_commentary', 'unclassified')),
  in_human_edit INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analysis_records (
  id SERIAL PRIMARY KEY,
  experiment_run_id INTEGER REFERENCES experiment_runs(id),
  run_stage_output_id INTEGER,
  analysis_type TEXT NOT NULL CHECK (analysis_type IN ('stage', 'cross_stage', 'cross_video')),
  content TEXT NOT NULL,
  model_used TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  system_instruction TEXT,
  model TEXT,
  params_json TEXT DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS diff_cache (
  id SERIAL PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  result_json TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spending_log (
  id SERIAL PRIMARY KEY,
  total_cost REAL DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_runtime_ms INTEGER DEFAULT 0,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- B-Roll Strategies
CREATE TABLE IF NOT EXISTS broll_strategies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  strategy_kind TEXT,
  bundle_key TEXT,
  bundle_name TEXT,
  hook_strategy_id INTEGER,
  main_strategy_id INTEGER,
  analysis_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  analysis_system_prompt TEXT NOT NULL DEFAULT '',
  analysis_prompt TEXT NOT NULL DEFAULT '',
  analysis_params_json TEXT NOT NULL DEFAULT '{}',
  plan_model TEXT NOT NULL DEFAULT 'gpt-5.4',
  plan_system_prompt TEXT NOT NULL DEFAULT '',
  plan_prompt TEXT NOT NULL DEFAULT '',
  plan_params_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broll_strategy_versions (
  id SERIAL PRIMARY KEY,
  strategy_id INTEGER NOT NULL REFERENCES broll_strategies(id),
  name TEXT NOT NULL,
  notes TEXT,
  hook_prompt TEXT NOT NULL DEFAULT '',
  main_prompt TEXT NOT NULL DEFAULT '',
  plan_prompt TEXT NOT NULL DEFAULT '',
  hook_params_json TEXT NOT NULL DEFAULT '{}',
  main_params_json TEXT NOT NULL DEFAULT '{}',
  plan_params_json TEXT NOT NULL DEFAULT '{}',
  stages_json TEXT NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broll_runs (
  id SERIAL PRIMARY KEY,
  strategy_id INTEGER NOT NULL REFERENCES broll_strategies(id),
  video_id INTEGER NOT NULL REFERENCES videos(id),
  step_name TEXT NOT NULL CHECK (step_name IN ('analysis', 'plan')),
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'failed')),
  transcript_source TEXT NOT NULL DEFAULT 'best_available' CHECK (transcript_source IN ('best_available', 'raw', 'human_edited', 'group_assembled')),
  resolved_transcript_source TEXT,
  analysis_run_id INTEGER REFERENCES broll_runs(id),
  input_text TEXT,
  output_text TEXT,
  prompt_used TEXT,
  system_instruction_used TEXT,
  model TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  runtime_ms INTEGER DEFAULT 0,
  error_message TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Outgoing API request log
CREATE TABLE IF NOT EXISTS api_logs (
  id SERIAL PRIMARY KEY,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  request_headers TEXT,
  request_body TEXT,
  response_status INTEGER,
  response_body TEXT,
  error TEXT,
  duration_ms INTEGER,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- B-Roll Example Sets (per video group)
CREATE TABLE IF NOT EXISTS broll_example_sets (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES video_groups(id),
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broll_example_sources (
  id SERIAL PRIMARY KEY,
  example_set_id INTEGER NOT NULL REFERENCES broll_example_sets(id),
  kind TEXT NOT NULL CHECK (kind IN ('upload', 'yt_video', 'yt_channel')),
  source_url TEXT,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
