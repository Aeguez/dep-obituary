-- supabase/schema.sql
-- Run this in your Supabase SQL editor

-- Stores cached package scan results (avoids re-hitting APIs for 24h)
CREATE TABLE IF NOT EXISTS package_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  package_name TEXT NOT NULL,
  ecosystem TEXT NOT NULL DEFAULT 'npm', -- 'npm' | 'pypi'
  score INTEGER NOT NULL,
  risk_level TEXT NOT NULL,
  metrics JSONB NOT NULL,
  breakdown JSONB NOT NULL,
  summary TEXT,
  alternative_suggestion TEXT,
  cached_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours',
  UNIQUE(package_name, ecosystem)
);

CREATE INDEX idx_package_cache_name ON package_cache(package_name, ecosystem);
CREATE INDEX idx_package_cache_expires ON package_cache(expires_at);

-- Migration guard for earlier schemas that cached by package_name only.
ALTER TABLE package_cache DROP CONSTRAINT IF EXISTS package_cache_package_name_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'package_cache_package_name_ecosystem_key'
  ) THEN
    ALTER TABLE package_cache
      ADD CONSTRAINT package_cache_package_name_ecosystem_key UNIQUE (package_name, ecosystem);
  END IF;
END $$;

-- Stores full scan sessions (for sharing and history)
CREATE TABLE IF NOT EXISTS scans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scan_id TEXT NOT NULL UNIQUE,
  user_id TEXT, -- null for anonymous
  file_name TEXT,
  total_packages INTEGER NOT NULL,
  critical_count INTEGER DEFAULT 0,
  high_count INTEGER DEFAULT 0,
  results JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_scans_user ON scans(user_id);
CREATE INDEX idx_scans_created ON scans(created_at DESC);

-- Stores monitored repos (Week 3: alerts feature)
CREATE TABLE IF NOT EXISTS monitored_repos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,
  last_scan_at TIMESTAMPTZ,
  last_score_snapshot JSONB,
  alert_on_change BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, repo_url)
);

-- Historical score snapshots for trend graphs (Week 3)
CREATE TABLE IF NOT EXISTS score_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT,
  repo_id UUID REFERENCES monitored_repos(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL,
  score INTEGER NOT NULL,
  risk_level TEXT NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_score_history_package ON score_history(package_name, recorded_at DESC);

ALTER TABLE score_history ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE score_history ADD COLUMN IF NOT EXISTS repo_id UUID REFERENCES monitored_repos(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_score_history_repo ON score_history(repo_id, recorded_at DESC);

-- RLS Policies (enable Row Level Security)
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitored_repos ENABLE ROW LEVEL SECURITY;

-- Anonymous scans are readable by anyone with the scan_id
CREATE POLICY "scans_public_read" ON scans
  FOR SELECT USING (true);

CREATE POLICY "scans_insert" ON scans
  FOR INSERT WITH CHECK (true);

-- Monitored repos only accessible by owner
CREATE POLICY "monitored_repos_owner" ON monitored_repos
  FOR ALL USING (auth.uid()::text = user_id);
