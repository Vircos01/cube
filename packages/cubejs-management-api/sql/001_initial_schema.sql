-- Extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Table 1: Semantic Models (metadata and identity of cubes/views)
CREATE TABLE IF NOT EXISTS semantic_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL UNIQUE,
    model_type VARCHAR(32) NOT NULL DEFAULT 'cube',
    file_name VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_semantic_models_name ON semantic_models(name);
CREATE INDEX IF NOT EXISTS idx_semantic_models_is_active ON semantic_models(is_active);

-- Table 2: Model Revisions (full history, draft/active status, YAML/JSON content)
CREATE TABLE IF NOT EXISTS model_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID NOT NULL REFERENCES semantic_models(id) ON DELETE CASCADE,
    revision_number INT NOT NULL,
    content TEXT NOT NULL,
    content_format VARCHAR(16) NOT NULL DEFAULT 'yaml',
    parsed_json JSONB,
    change_summary VARCHAR(255),
    status VARCHAR(32) NOT NULL DEFAULT 'active', -- 'active', 'draft', 'archived'
    created_by VARCHAR(128) NOT NULL DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_model_revision UNIQUE(model_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_model_revisions_model_id ON model_revisions(model_id);
CREATE INDEX IF NOT EXISTS idx_model_revisions_status ON model_revisions(status);
CREATE INDEX IF NOT EXISTS idx_model_revisions_created_at ON model_revisions(created_at DESC);

-- Table 3: Audit Logs (compliance, auditing, history of changes)
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    action VARCHAR(64) NOT NULL, -- 'CREATE', 'UPDATE', 'ROLLBACK', 'DELETE', 'VALIDATE', 'IMPORT', 'EXPORT'
    model_name VARCHAR(128),
    revision_id UUID REFERENCES model_revisions(id) ON DELETE SET NULL,
    details JSONB,
    actor VARCHAR(128) DEFAULT 'system',
    ip_address VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_model_name ON audit_logs(model_name);

-- Table 4: Schema Version Tracker (for Cube schemaVersion hook)
CREATE TABLE IF NOT EXISTS schema_version_tracker (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    version BIGINT NOT NULL DEFAULT 1,
    version_hash VARCHAR(64) NOT NULL DEFAULT 'v1',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed initial version if not present
INSERT INTO schema_version_tracker (id, version, version_hash, updated_at)
VALUES (1, 1, 'initial', NOW())
ON CONFLICT (id) DO NOTHING;

-- Table 5: Data Sources (External & Custom Database Connections for Cube driverFactory)
CREATE TABLE IF NOT EXISTS data_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL UNIQUE,
    db_type VARCHAR(64) NOT NULL DEFAULT 'postgres',
    host VARCHAR(255) NOT NULL,
    port INT NOT NULL DEFAULT 5432,
    database_name VARCHAR(255) NOT NULL,
    username VARCHAR(255) NOT NULL,
    password TEXT,
    schema_name VARCHAR(255) DEFAULT 'public',
    ssl BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_sources_name ON data_sources(name);

