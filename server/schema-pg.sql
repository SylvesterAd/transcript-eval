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
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transcripts (
  id SERIAL PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  type TEXT NOT NULL CHECK (type IN ('raw', 'human_edited')),
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
