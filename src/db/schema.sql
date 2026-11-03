-- PostgreSQL Roles for Strict Database-Level Privilege & Tenant Separation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_instance_admin') THEN
    CREATE ROLE app_instance_admin NOLOGIN;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS families (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  passkey_enrolled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_name TEXT NOT NULL DEFAULT 'Passkey',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  csrf_token TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'instance_admin', 'guest', 'assignment')),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  guest_link_id UUID,
  assignment_link_id UUID,
  mfa_verified BOOLEAN NOT NULL DEFAULT FALSE,
  webauthn_challenge TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant-Isolated Tables (Every table below enforces PostgreSQL Row-Level Security)

CREATE TABLE IF NOT EXISTS family_members (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('family_admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(family_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('family_admin', 'member')),
  token_hash TEXT UNIQUE NOT NULL,
  invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  is_assisted_enrollment BOOLEAN NOT NULL DEFAULT FALSE,
  target_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guest_links (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  guest_first_name TEXT NOT NULL,
  allowed_list_ids JSONB,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assignment_links (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  assignee_first_name TEXT NOT NULL,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lists (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  event_date DATE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  recipient_first_name TEXT NOT NULL,
  thank_you_revealed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS images (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  width INT NOT NULL,
  height INT NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  store_url TEXT NOT NULL DEFAULT '',
  store_name TEXT NOT NULL DEFAULT '',
  price_cents INT,
  image_url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'nice_to_have' CHECK (priority IN ('really_want', 'nice_to_have')),
  quantity INT NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  allow_duplicates BOOLEAN NOT NULL DEFAULT FALSE,
  is_catch_all BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_by_recipient BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claims (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  claimer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  claimer_guest_link_id UUID REFERENCES guest_links(id) ON DELETE SET NULL,
  assignment_id UUID,
  claimer_first_name TEXT NOT NULL,
  quantity INT NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  bought BOOLEAN NOT NULL DEFAULT FALSE,
  thank_you_sent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pledges (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  pledger_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  pledger_guest_link_id UUID REFERENCES guest_links(id) ON DELETE SET NULL,
  pledger_first_name TEXT NOT NULL,
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  note TEXT NOT NULL DEFAULT '',
  thank_you_sent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assignments (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  assigner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_link_id UUID REFERENCES assignment_links(id) ON DELETE SET NULL,
  assignee_first_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'bought', 'couldnt_get_it')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  target_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  target_guest_link_id UUID REFERENCES guest_links(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  target_recipient_user_id UUID,
  is_surprise_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Grant permissions to app_tenant
GRANT USAGE ON SCHEMA public TO app_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  families, users, passkey_credentials, recovery_codes, sessions,
  family_members, invites, guest_links, assignment_links,
  lists, images, items, claims, pledges, assignments, notifications, audit_logs
TO app_tenant;

-- Grant strictly limited permissions to app_instance_admin (CANNOT SELECT family content!)
GRANT USAGE ON SCHEMA public TO app_instance_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON families TO app_instance_admin;
GRANT INSERT ON invites TO app_instance_admin;
GRANT INSERT ON audit_logs TO app_instance_admin;
REVOKE SELECT, UPDATE, DELETE ON lists, items, claims, pledges, assignments, guest_links, assignment_links, notifications, images, audit_logs FROM app_instance_admin;

-- Enable & Force Row-Level Security (RLS) on all family-scoped tables
ALTER TABLE family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_family_members ON family_members;
CREATE POLICY tenant_isolation_family_members ON family_members
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_invites ON invites;
CREATE POLICY tenant_isolation_invites ON invites
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);
DROP POLICY IF EXISTS instance_admin_bootstrap_invites ON invites;
CREATE POLICY instance_admin_bootstrap_invites ON invites
  FOR INSERT TO app_instance_admin
  WITH CHECK (true);

ALTER TABLE guest_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_guest_links ON guest_links;
CREATE POLICY tenant_isolation_guest_links ON guest_links
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);

ALTER TABLE assignment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_assignment_links ON assignment_links;
CREATE POLICY tenant_isolation_assignment_links ON assignment_links
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);

ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE lists FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_lists ON lists;
CREATE POLICY tenant_isolation_lists ON lists
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);

ALTER TABLE images ENABLE ROW LEVEL SECURITY;
ALTER TABLE images FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_images ON images;
CREATE POLICY tenant_isolation_images ON images
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);

ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_items ON items;
CREATE POLICY tenant_isolation_items ON items
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);

ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_claims ON claims;
CREATE POLICY tenant_isolation_claims ON claims
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);

ALTER TABLE pledges ENABLE ROW LEVEL SECURITY;
ALTER TABLE pledges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_pledges ON pledges;
CREATE POLICY tenant_isolation_pledges ON pledges
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);

ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_assignments ON assignments;
CREATE POLICY tenant_isolation_assignments ON assignments
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_notifications ON notifications;
CREATE POLICY tenant_isolation_notifications ON notifications
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_audit_logs ON audit_logs;
CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  FOR ALL TO app_tenant
  USING (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (family_id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);
DROP POLICY IF EXISTS instance_admin_insert_audit_logs ON audit_logs;
CREATE POLICY instance_admin_insert_audit_logs ON audit_logs
  FOR INSERT TO app_instance_admin
  WITH CHECK (true);
