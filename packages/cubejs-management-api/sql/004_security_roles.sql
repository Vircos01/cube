-- Security Roles table
CREATE TABLE IF NOT EXISTS security_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(64) NOT NULL UNIQUE,
    display_name VARCHAR(128) NOT NULL,
    description TEXT,
    is_admin BOOLEAN NOT NULL DEFAULT false,
    can_manage_models BOOLEAN NOT NULL DEFAULT false,
    can_manage_datasources BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_roles_name ON security_roles(name);

-- User Accounts table
CREATE TABLE IF NOT EXISTS user_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(128) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    role_id VARCHAR(64) NOT NULL REFERENCES security_roles(name) ON DELETE RESTRICT,
    claims JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_accounts_username ON user_accounts(username);
CREATE INDEX IF NOT EXISTS idx_user_accounts_role_id ON user_accounts(role_id);

-- Access Policies table (RLS and OLS)
CREATE TABLE IF NOT EXISTS access_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id VARCHAR(64) NOT NULL REFERENCES security_roles(name) ON DELETE CASCADE,
    cube_name VARCHAR(128) NOT NULL,
    policy_type VARCHAR(32) NOT NULL, -- 'RLS' or 'OLS'
    definition JSONB NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_policies_role ON access_policies(role_id);
CREATE INDEX IF NOT EXISTS idx_access_policies_cube ON access_policies(cube_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_policies_unique ON access_policies(role_id, cube_name, policy_type);

-- Seed Default Security Roles
INSERT INTO security_roles (name, display_name, description, is_admin, can_manage_models, can_manage_datasources)
VALUES
  ('admin', 'Global Administrator', 'Volledige ongefilterde toegang tot alle data en het beheer van modellen.', true, true, true),
  ('sales_rep', 'Sales Representative', 'Regionaal gebonden verkoopmedewerker met dynamische RLS en OLS restricties.', false, false, false),
  ('viewer', 'Viewer / Analyst', 'Alleen-lezen toegang tot geaggregeerde rapportages.', false, false, false)
ON CONFLICT (name) DO NOTHING;

-- Seed Default User Accounts
INSERT INTO user_accounts (username, password_hash, display_name, role_id, claims, is_active)
VALUES
  ('admin', 'admin', 'Global Administrator', 'admin', '{"region": "global"}', true),
  ('sales_amsterdam', 'amsterdam123', 'Amsterdam Sales Representative', 'sales_rep', '{"city": "Amsterdam"}', true),
  ('sales_rotterdam', 'rotterdam123', 'Rotterdam Sales Representative', 'sales_rep', '{"city": "Rotterdam"}', true)
ON CONFLICT (username) DO NOTHING;

-- Seed Default Access Policies for sales_rep
INSERT INTO access_policies (role_id, cube_name, policy_type, definition, is_active)
VALUES
  ('sales_rep', 'Orders', 'RLS', '{"member": "Users.city", "operator": "equals", "claimField": "city"}', true),
  ('sales_rep', 'Orders', 'OLS', '{"denyMeasures": ["Orders.avg_amount", "Orders.avg_order_value"], "denyDimensions": []}', true)
ON CONFLICT (role_id, cube_name, policy_type) DO NOTHING;
