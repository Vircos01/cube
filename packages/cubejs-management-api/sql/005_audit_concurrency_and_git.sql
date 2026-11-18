-- Migration 005: Audit Log Compliance, Optimistic Concurrency & Git Tracking

-- 1. Add version column to semantic_models for optimistic concurrency control
ALTER TABLE semantic_models 
ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

-- 2. Add git_commit_hash to model_revisions for traceability between Git and database metadata
ALTER TABLE model_revisions
ADD COLUMN IF NOT EXISTS git_commit_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_model_revisions_git_hash ON model_revisions(git_commit_hash);

-- 3. Extend audit_logs table with required audit compliance fields:
-- actor, timestamp (created_at), source, model, revision, and result
ALTER TABLE audit_logs
ADD COLUMN IF NOT EXISTS model_id UUID REFERENCES semantic_models(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS previous_revision_id UUID REFERENCES model_revisions(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS source VARCHAR(64) NOT NULL DEFAULT 'management_api',
ADD COLUMN IF NOT EXISTS result VARCHAR(32) NOT NULL DEFAULT 'SUCCESS',
ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_logs_model_id ON audit_logs(model_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_source ON audit_logs(source);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor);
CREATE INDEX IF NOT EXISTS idx_audit_logs_result ON audit_logs(result);
