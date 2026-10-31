"""Row-level security: grants, helper functions, policies and triggers.

Everything here is raw SQL kept inline so the migration stays immutable once applied.
Design: the reviewed RLS spec (roles §1, helpers §4, policies §5, triggers §7). Four RunSQL steps, applied in this order and reversed in the opposite order:

1. base       preconditions, privileges, ENABLE + FORCE RLS, read/insert policies for rls_definer
2. functions  schema rls helper and trigger functions, created AS rls_definer
3. policies   per-table policies for app_runtime (one RESTRICTIVE "tenant" policy each)
4. triggers   immutable columns, monotonic revocation, claim guard, last admin, outbox

Prerequisites (db/init/02-rls-roles.sql, run once as the bootstrap superuser): roles
app_runtime and rls_definer, schema rls owned by rls_definer, and the migrator holding
SET on rls_definer. Run this migration as the role that owns the tables, never as the
app role. Note FORCE RLS applies to the owner too and no policy targets the owner, so
later data migrations that touch tenant rows must wrap their writes in
ALTER TABLE ... NO FORCE ROW LEVEL SECURITY / FORCE ROW LEVEL SECURITY.
"""

from django.db import migrations

# --------------------------------------------------------------------------- tables

FAMILY_TABLE = "families_family"
TENANT_TABLES = [
    "families_membership",
    "families_person",
    "families_wishlist",
    "families_item",
    "families_claim",
    "families_pledge",
    "families_assignment",
    "families_guestlink",
    "families_guestlinklist",
    "families_assignmentlink",
    "families_invite",
    "families_auditlog",
    "families_claimnotification",
]
ALL_TABLES = [FAMILY_TABLE] + TENANT_TABLES

# Tables rls_definer functions read (SECURITY DEFINER helpers and triggers).
DEFINER_READ_TABLES = [
    "families_membership",
    "families_person",
    "families_wishlist",
    "families_item",
    "families_claim",
    "families_pledge",
    "families_assignment",
    "families_guestlink",
    "families_guestlinklist",
    "families_assignmentlink",
    "families_invite",
]

# Exactly what app_runtime may do. Everything else (TRUNCATE, REFERENCES, TRIGGER and
# the commands left out here) is revoked, regardless of what default privileges granted.
APP_GRANTS = {
    "families_family": "SELECT, INSERT, UPDATE",
    "families_membership": "SELECT, UPDATE, DELETE",
    "families_person": "SELECT, INSERT, UPDATE, DELETE",
    "families_wishlist": "SELECT, INSERT, UPDATE, DELETE",
    "families_item": "SELECT, INSERT, UPDATE, DELETE",
    "families_claim": "SELECT, INSERT, DELETE",
    "families_pledge": "SELECT, INSERT, UPDATE, DELETE",
    "families_assignment": "SELECT, INSERT, UPDATE, DELETE",
    "families_guestlink": "SELECT, INSERT, UPDATE",
    "families_guestlinklist": "SELECT, INSERT, DELETE",
    "families_assignmentlink": "SELECT, INSERT, UPDATE",
    "families_invite": "SELECT, INSERT, UPDATE",
    "families_auditlog": "SELECT",
    "families_claimnotification": "",
}

# ---------------------------------------------------------------- 1. base (as owner)

PRECONDITIONS = """
DO $$
DECLARE owner_name name; is_super boolean;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO owner_name
    FROM pg_catalog.pg_class c WHERE c.oid = 'public.families_family'::pg_catalog.regclass;
  IF current_user <> owner_name THEN
    RAISE EXCEPTION 'RLS migration must run as the table owner (% owns families_family, current_user is %)',
      owner_name, current_user;
  END IF;
  IF current_user IN ('app_runtime', 'rls_definer') THEN
    RAISE EXCEPTION 'RLS migration must not run as %', current_user;
  END IF;
  IF pg_catalog.to_regrole('app_runtime') IS NULL OR pg_catalog.to_regrole('rls_definer') IS NULL THEN
    RAISE EXCEPTION 'roles app_runtime / rls_definer are missing: run db/init/02-rls-roles.sql as the bootstrap superuser first';
  END IF;
  SELECT r.rolsuper INTO is_super FROM pg_catalog.pg_roles r WHERE r.rolname = current_user;
  IF NOT is_super AND pg_catalog.pg_has_role(current_user, 'app_runtime', 'MEMBER') THEN
    RAISE EXCEPTION 'the migrator role must not be a member of app_runtime';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'rls_definer', 'SET') THEN
    RAISE EXCEPTION 'the migrator role needs SET on rls_definer (db/init/02-rls-roles.sql)';
  END IF;
END $$
"""

# A brand-new database (for example a test database cloned from template1) has no schema rls
# yet. Only a privileged migrator can create it; everyone else must run 02-rls-roles.sql.
SCHEMA_BOOTSTRAP = """
DO $$
BEGIN
  IF pg_catalog.to_regnamespace('rls') IS NULL THEN
    BEGIN
      CREATE SCHEMA rls AUTHORIZATION rls_definer;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'schema rls is missing and this role cannot create it: run db/init/02-rls-roles.sql as the bootstrap superuser';
    END;
    REVOKE ALL ON SCHEMA rls FROM PUBLIC;
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA rls TO app_runtime, %I', current_user);
    GRANT USAGE ON SCHEMA public TO rls_definer;
  END IF;
  IF (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'rls')
       <> 'rls_definer' THEN
    RAISE EXCEPTION 'schema rls must be owned by rls_definer';
  END IF;
  IF NOT pg_catalog.has_schema_privilege('app_runtime', 'rls', 'USAGE') THEN
    RAISE EXCEPTION 'app_runtime lacks USAGE on schema rls (db/init/02-rls-roles.sql)';
  END IF;
END $$
"""


def _base_sql():
    sql = [PRECONDITIONS, SCHEMA_BOOTSTRAP]
    tables = ", ".join(f"public.{t}" for t in ALL_TABLES)
    sql.append(f"REVOKE ALL ON {tables} FROM app_runtime")
    sql.append(f"REVOKE ALL ON {tables} FROM rls_definer")
    for table, privileges in APP_GRANTS.items():
        if privileges:
            sql.append(f"GRANT {privileges} ON public.{table} TO app_runtime")
    sql.append(f"GRANT SELECT ON {', '.join('public.' + t for t in DEFINER_READ_TABLES)} TO rls_definer")
    sql.append("GRANT INSERT ON public.families_auditlog, public.families_claimnotification TO rls_definer")
    sql.append("GRANT DELETE ON public.families_claim TO rls_definer")
    for table in ALL_TABLES:
        sql.append(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
        sql.append(f"ALTER TABLE public.{table} FORCE ROW LEVEL SECURITY")
    # rls_definer policies: the ONLY unconditional policies. They target a NOLOGIN role
    # that holds no app privileges; app_runtime never gets USING (true).
    for table in DEFINER_READ_TABLES:
        sql.append(f"CREATE POLICY rls_definer_read ON public.{table} FOR SELECT TO rls_definer USING (true)")
    sql.append("CREATE POLICY rls_definer_ins ON public.families_auditlog FOR INSERT TO rls_definer WITH CHECK (true)")
    sql.append(
        "CREATE POLICY rls_definer_ins ON public.families_claimnotification FOR INSERT TO rls_definer WITH CHECK (true)"
    )
    sql.append("CREATE POLICY rls_definer_del ON public.families_claim FOR DELETE TO rls_definer USING (true)")
    return sql


def _base_reverse_sql():
    sql = []
    for table in DEFINER_READ_TABLES:
        sql.append(f"DROP POLICY IF EXISTS rls_definer_read ON public.{table}")
    sql.append("DROP POLICY IF EXISTS rls_definer_ins ON public.families_auditlog")
    sql.append("DROP POLICY IF EXISTS rls_definer_ins ON public.families_claimnotification")
    sql.append("DROP POLICY IF EXISTS rls_definer_del ON public.families_claim")
    for table in ALL_TABLES:
        sql.append(f"ALTER TABLE public.{table} NO FORCE ROW LEVEL SECURITY")
        sql.append(f"ALTER TABLE public.{table} DISABLE ROW LEVEL SECURITY")
    tables = ", ".join(f"public.{t}" for t in ALL_TABLES)
    sql.append(f"REVOKE ALL ON {tables} FROM rls_definer")
    # Back to what default privileges granted before this migration.
    sql.append(f"REVOKE ALL ON {tables} FROM app_runtime")
    sql.append(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {tables} TO app_runtime")
    return sql


# -------------------------------------------------------- 2. functions (as rls_definer)

ASSERT_DEFINER = """
DO $$
BEGIN
  IF current_user <> 'rls_definer' THEN
    RAISE EXCEPTION 'helper functions must be created as rls_definer, current_user is %', current_user;
  END IF;
END $$
"""

STABLE_DEFINER = "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp"
PLPGSQL_DEFINER = "LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp"

# Session-setting readers are SECURITY INVOKER and touch no tables. A malformed value
# raises on the bigint cast: noisy but fail-closed. Unset and '' both read as NULL.
FUNCTIONS = [
    """
CREATE FUNCTION rls.family_id() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.family_id', true), '')::bigint
$$""",
    """
CREATE FUNCTION rls.principal_type() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE pg_catalog.current_setting('app.principal_type', true)
           WHEN 'user' THEN 'user'
           WHEN 'guest' THEN 'guest'
           WHEN 'assignment_link' THEN 'assignment_link'
           WHEN 'instance_admin' THEN 'instance_admin'
         END
$$""",
    """
CREATE FUNCTION rls.principal_id() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.principal_id', true), '')::bigint
$$""",
    """
CREATE FUNCTION rls.user_id() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN rls.principal_type() = 'user' THEN rls.principal_id() END
$$""",
    f"""
CREATE FUNCTION rls.member_role() RETURNS text
{STABLE_DEFINER} AS $$
  SELECT m.role FROM public.families_membership m
   WHERE m.family_id = rls.family_id() AND m.user_id = rls.user_id()
$$""",
    """
CREATE FUNCTION rls.is_member() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT rls.member_role() IS NOT NULL $$""",
    """
CREATE FUNCTION rls.is_family_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT rls.member_role() IS NOT DISTINCT FROM 'family_admin' $$""",
    # Placeholder until the instance-admin PR defines the authoritative flag. Deny by default.
    """
CREATE FUNCTION rls.is_instance_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false $$""",
    f"""
CREATE FUNCTION rls.guest_link_id() RETURNS bigint
{STABLE_DEFINER} AS $$
  SELECT g.id FROM public.families_guestlink g
   WHERE rls.principal_type() = 'guest'
     AND g.id = rls.principal_id()
     AND g.family_id = rls.family_id()
     AND g.revoked_at IS NULL AND g.expires_at > now()
$$""",
    f"""
CREATE FUNCTION rls.assignment_link_id() RETURNS bigint
{STABLE_DEFINER} AS $$
  SELECT a.id FROM public.families_assignmentlink a
   WHERE rls.principal_type() = 'assignment_link'
     AND a.id = rls.principal_id()
     AND a.family_id = rls.family_id()
     AND a.revoked_at IS NULL AND a.expires_at > now()
$$""",
    f"""
CREATE FUNCTION rls.assignment_link_person_id() RETURNS bigint
{STABLE_DEFINER} AS $$
  SELECT a.person_id FROM public.families_assignmentlink a WHERE a.id = rls.assignment_link_id()
$$""",
    """
CREATE FUNCTION rls.has_family_access() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT rls.is_member() OR rls.guest_link_id() IS NOT NULL OR rls.assignment_link_id() IS NOT NULL
$$""",
    # The actor's Person in the current family (user: own Person; links: bound Person).
    f"""
CREATE FUNCTION rls.actor_person_id() RETURNS bigint
{STABLE_DEFINER} AS $$
  SELECT CASE rls.principal_type()
    WHEN 'user' THEN (SELECT p.id FROM public.families_person p
                       WHERE p.family_id = rls.family_id() AND p.user_id = rls.user_id())
    WHEN 'guest' THEN (SELECT g.person_id FROM public.families_guestlink g
                        WHERE g.id = rls.guest_link_id())
    WHEN 'assignment_link' THEN rls.assignment_link_person_id()
  END
$$""",
    # The human behind the actor, if known (user id, or the link Person's user).
    f"""
CREATE FUNCTION rls.actor_user_id() RETURNS bigint
{STABLE_DEFINER} AS $$
  SELECT CASE WHEN rls.principal_type() = 'user' THEN rls.user_id()
              ELSE (SELECT p.user_id FROM public.families_person p WHERE p.id = rls.actor_person_id())
         END
$$""",
    # Deny-biased identity test: "is this Person me?" by Person id OR by shared user.
    f"""
CREATE FUNCTION rls.is_self_person(p_person_id bigint) RETURNS boolean
{STABLE_DEFINER} AS $$
  WITH me AS (SELECT rls.actor_person_id() AS pid, rls.actor_user_id() AS uid)
  SELECT EXISTS (
    SELECT 1 FROM public.families_person p, me
     WHERE p.id = p_person_id AND p.family_id = rls.family_id()
       AND (p.id = me.pid OR (p.user_id IS NOT NULL AND p.user_id = me.uid)))
$$""",
    # Lists in the current family whose recipient is the actor. The surprise-rule core.
    f"""
CREATE FUNCTION rls.recipient_list_ids() RETURNS bigint[]
{STABLE_DEFINER} AS $$
  WITH me AS (SELECT rls.actor_person_id() AS pid, rls.actor_user_id() AS uid)
  SELECT COALESCE(array_agg(w.id), '{{}}')
    FROM public.families_wishlist w
    JOIN public.families_person r ON r.id = w.recipient_id, me
   WHERE w.family_id = rls.family_id()
     AND (r.id = me.pid OR (r.user_id IS NOT NULL AND r.user_id = me.uid))
$$""",
    f"""
CREATE FUNCTION rls.guest_list_ids() RETURNS bigint[]
{STABLE_DEFINER} AS $$
  SELECT COALESCE(array_agg(gl.list_id), '{{}}')
    FROM public.families_guestlinklist gl
   WHERE gl.guest_link_id = rls.guest_link_id() AND gl.family_id = rls.family_id()
$$""",
    f"""
CREATE FUNCTION rls.can_manage_list(p_list_id bigint) RETURNS boolean
{STABLE_DEFINER} AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.families_wishlist w
     WHERE w.id = p_list_id AND w.family_id = rls.family_id()
       AND (rls.is_family_admin()
            OR (rls.is_member() AND (w.created_by_id = rls.user_id() OR w.managed_by_id = rls.user_id()))))
$$""",
    # Item is in the current family AND not on a list the actor receives.
    f"""
CREATE FUNCTION rls.item_not_on_recipient_list(p_item_id bigint) RETURNS boolean
{STABLE_DEFINER} AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.families_item i
     WHERE i.id = p_item_id AND i.family_id = rls.family_id()
       AND i.list_id <> ALL (rls.recipient_list_ids()))
$$""",
    # Gift state (claims/pledges/assignments) visibility. Phrased positively so NULL means deny.
    f"""
CREATE FUNCTION rls.can_see_gift_state(p_item_id bigint, p_allow_guest boolean) RETURNS boolean
{STABLE_DEFINER} AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.families_item i
     WHERE i.id = p_item_id AND i.family_id = rls.family_id()
       AND i.list_id <> ALL (rls.recipient_list_ids())
       AND (rls.is_member()
            OR (p_allow_guest AND i.list_id = ANY (rls.guest_list_ids()))))
$$""",
    f"""
CREATE FUNCTION rls.is_assigner_or_admin(p_assignment_id bigint) RETURNS boolean
{STABLE_DEFINER} AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.families_assignment a
     WHERE a.id = p_assignment_id AND a.family_id = rls.family_id()
       AND (rls.is_family_admin() OR (rls.is_member() AND a.assigner_id = rls.user_id())))
$$""",
    """
CREATE FUNCTION rls.can_manage_link_issued_by(p_issued_by bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT rls.is_family_admin() OR (rls.is_member() AND p_issued_by = rls.user_id())
$$""",
    f"""
CREATE FUNCTION rls.can_manage_guest_link(p_link_id bigint) RETURNS boolean
{STABLE_DEFINER} AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.families_guestlink g
     WHERE g.id = p_link_id AND g.family_id = rls.family_id()
       AND rls.can_manage_link_issued_by(g.issued_by_id))
$$""",
    # Persons a guest may see: self, recipients of in-scope lists, and claimers/pledgers on
    # in-scope lists that the guest does NOT receive. The visible set must not be derived
    # from claims on the guest's own list, or set membership itself would leak claim state.
    f"""
CREATE FUNCTION rls.guest_visible_person_ids() RETURNS bigint[]
{STABLE_DEFINER} AS $$
  WITH scope AS (SELECT rls.guest_list_ids() AS lists, rls.recipient_list_ids() AS mine)
  SELECT COALESCE(array_agg(DISTINCT pid), '{{}}') FROM (
    SELECT g.person_id AS pid FROM public.families_guestlink g WHERE g.id = rls.guest_link_id()
    UNION
    SELECT w.recipient_id FROM public.families_wishlist w, scope WHERE w.id = ANY (scope.lists)
    UNION
    SELECT c.claimer_id FROM public.families_claim c JOIN public.families_item i ON i.id = c.item_id, scope
     WHERE i.list_id = ANY (scope.lists) AND i.list_id <> ALL (scope.mine)
    UNION
    SELECT pl.pledger_id FROM public.families_pledge pl JOIN public.families_item i ON i.id = pl.item_id, scope
     WHERE i.list_id = ANY (scope.lists) AND i.list_id <> ALL (scope.mine)
  ) s
$$""",
    # Audit rows are written ONLY here (the app role has SELECT on the table, nothing else).
    # Actor and principal come from the session settings, so callers cannot forge them, and
    # the INSERT has no RETURNING, so the admin-only SELECT policy is never consulted.
    f"""
CREATE FUNCTION rls.audit_append(
  p_action text, p_target_type text, p_target_id bigint, p_recipient_person_id bigint,
  p_metadata jsonb DEFAULT '{{}}'::jsonb) RETURNS void
{PLPGSQL_DEFINER} AS $$
BEGIN
  IF rls.family_id() IS NULL OR NOT rls.has_family_access() THEN
    RAISE EXCEPTION 'audit_append: no family access' USING ERRCODE = '42501';
  END IF;
  p_metadata := COALESCE(p_metadata, '{{}}'::jsonb);
  IF pg_catalog.jsonb_path_exists(p_metadata, 'lax $.**.keyvalue() ? (@.key like_regex "token" flag "i")') THEN
    RAISE EXCEPTION 'audit metadata must not contain tokens' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.families_auditlog
    (family_id, actor_id, principal_type, principal_id, recipient_person_id,
     action, target_type, target_id, metadata, created_at)
  VALUES
    (rls.family_id(), rls.actor_user_id(), rls.principal_type(), rls.principal_id(), p_recipient_person_id,
     p_action, COALESCE(p_target_type, ''), p_target_id, p_metadata, now());
END
$$""",
    # ---- trigger functions ----------------------------------------------------------
    # Immutable columns. SECURITY INVOKER: it only compares OLD and NEW.
    """
CREATE FUNCTION rls.tg_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE col text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(NEW) -> col) IS DISTINCT FROM (to_jsonb(OLD) -> col) THEN
      RAISE EXCEPTION 'immutable column' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END $$""",
    """
CREATE FUNCTION rls.tg_revoke_monotonic() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'revocation is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$""",
    # Person.user_id is only bindable NULL -> value, and only by rls_definer (the future
    # accept_invite entry point). Runtime roles (non-superuser members of app_runtime) can
    # never change it. Maintenance roles (superuser, migrator) are unrestricted so that the
    # ON DELETE SET NULL of an account deletion keeps working.
    """
CREATE FUNCTION rls.tg_person_user_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE runtime_role boolean;
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    IF current_user = 'rls_definer' THEN
      IF OLD.user_id IS NOT NULL THEN
        RAISE EXCEPTION 'person.user is not editable' USING ERRCODE = '42501';
      END IF;
    ELSE
      SELECT NOT r.rolsuper AND pg_has_role(r.rolname, 'app_runtime', 'MEMBER') INTO runtime_role
        FROM pg_roles r WHERE r.rolname = current_user;
      IF runtime_role THEN
        RAISE EXCEPTION 'person.user is not editable' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$""",
    """
CREATE FUNCTION rls.tg_assignment_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT (NEW.status = OLD.status
          OR (OLD.status = 'assigned' AND NEW.status IN ('bought', 'couldnt_get'))) THEN
    RAISE EXCEPTION 'invalid transition' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$""",
    # couldnt_get releases the claim. Link principals cannot see claims, so this is DB-side.
    f"""
CREATE FUNCTION rls.tg_assignment_release() RETURNS trigger
{PLPGSQL_DEFINER} AS $$
BEGIN
  DELETE FROM public.families_claim WHERE assignment_id = NEW.id;
  RETURN NULL;
END $$""",
    # Claim guard: capacity + "the recipient never claims". Runs AFTER INSERT on purpose:
    # a BEFORE trigger runs before the WITH CHECK policy, so a recipient (who cannot see
    # gift state) would get quantity_exhausted (P0001) for a claimed item and 42501 for an
    # unclaimed one. AFTER row triggers only fire once RLS has accepted the row, so the
    # guard's errors are only ever visible to someone allowed to see the item's gift state.
    # The advisory lock is the same one services.create_claim takes, so concurrent claims
    # serialise; the count then runs on a fresh READ COMMITTED snapshot.
    f"""
CREATE FUNCTION rls.tg_claim_guard() RETURNS trigger
{PLPGSQL_DEFINER} AS $$
DECLARE q int; dup boolean; n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('item-claims:' || NEW.item_id::text, 0));
  IF EXISTS (
      SELECT 1 FROM public.families_item i
        JOIN public.families_wishlist w ON w.id = i.list_id
        JOIN public.families_person r ON r.id = w.recipient_id
        JOIN public.families_person c ON c.id = NEW.claimer_id
       WHERE i.id = NEW.item_id
         AND (r.id = c.id OR (r.user_id IS NOT NULL AND r.user_id = c.user_id))) THEN
    RAISE EXCEPTION 'is_recipient' USING ERRCODE = 'P0001';
  END IF;
  SELECT i.quantity, i.allow_duplicates INTO q, dup FROM public.families_item i WHERE i.id = NEW.item_id;
  IF NOT dup THEN
    SELECT count(*) INTO n FROM public.families_claim WHERE item_id = NEW.item_id;
    IF n > q THEN
      RAISE EXCEPTION 'quantity_exhausted' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END $$""",
    # Recipient-only guard for pledge (pledger_id) and assignment (assignee_id): TG_ARGV[0]
    # names the Person column. AFTER INSERT for the same reason as the claim guard.
    f"""
CREATE FUNCTION rls.tg_recipient_guard() RETURNS trigger
{PLPGSQL_DEFINER} AS $$
BEGIN
  IF EXISTS (
      SELECT 1 FROM public.families_item i
        JOIN public.families_wishlist w ON w.id = i.list_id
        JOIN public.families_person r ON r.id = w.recipient_id
        JOIN public.families_person c ON c.id = (to_jsonb(NEW) ->> TG_ARGV[0])::bigint
       WHERE i.id = NEW.item_id
         AND (r.id = c.id OR (r.user_id IS NOT NULL AND r.user_id = c.user_id))) THEN
    RAISE EXCEPTION 'is_recipient' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$""",
    # not_last_admin: an aggregate, so RLS cannot express it. The advisory lock stops two
    # admins demoting each other concurrently from both committing.
    f"""
CREATE FUNCTION rls.tg_last_admin() RETURNS trigger
{PLPGSQL_DEFINER} AS $$
BEGIN
  IF OLD.role = 'family_admin' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('family-admins:' || OLD.family_id::text, 0));
    IF NOT EXISTS (SELECT 1 FROM public.families_membership
                    WHERE family_id = OLD.family_id AND role = 'family_admin') THEN
      RAISE EXCEPTION 'not_last_admin' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END $$""",
    # Rule 5 outbox. Written by the database so the recipient's own request never reads claims.
    # A claim released by its own claimer does not notify them; a claim removed because the
    # item was deleted always does.
    f"""
CREATE FUNCTION rls.tg_claim_notify() RETURNS trigger
{PLPGSQL_DEFINER} AS $$
DECLARE k text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.families_item i WHERE i.id = OLD.item_id) THEN
    k := 'item_deleted';
  ELSIF rls.actor_person_id() IS DISTINCT FROM OLD.claimer_id THEN
    k := 'released';
  ELSE
    RETURN NULL;
  END IF;
  INSERT INTO public.families_claimnotification (family_id, claim_id, item_id, claimer_id, kind, created_at)
  VALUES (OLD.family_id, OLD.id, OLD.item_id, OLD.claimer_id, k, now());
  RETURN NULL;
END $$""",
    f"""
CREATE FUNCTION rls.tg_item_notify() RETURNS trigger
{PLPGSQL_DEFINER} AS $$
BEGIN
  INSERT INTO public.families_claimnotification (family_id, claim_id, item_id, claimer_id, kind, created_at)
  SELECT NEW.family_id, c.id, c.item_id, c.claimer_id, 'item_changed', now()
    FROM public.families_claim c
   WHERE c.item_id = NEW.id AND c.claimer_id IS DISTINCT FROM rls.actor_person_id();
  RETURN NULL;
END $$""",
]

TRIGGER_FUNCTIONS = [
    "tg_immutable()",
    "tg_revoke_monotonic()",
    "tg_person_user_binding()",
    "tg_assignment_status()",
    "tg_assignment_release()",
    "tg_claim_guard()",
    "tg_recipient_guard()",
    "tg_last_admin()",
    "tg_claim_notify()",
    "tg_item_notify()",
]

# Trigger functions are only checked for EXECUTE when the trigger is created (by the owner),
# so app_runtime gets no EXECUTE on them. Everything else is callable by app_runtime.
GRANT_EXECUTE = """
DO $$
DECLARE r record; migrator text := pg_catalog.current_setting('rls_migration.owner');
BEGIN
  FOR r IN SELECT p.oid::pg_catalog.regprocedure AS f, p.proname
             FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'rls'::pg_catalog.regnamespace LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.f);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO %I', r.f, migrator);
    IF r.proname NOT LIKE 'tg\\_%' THEN
      EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO app_runtime', r.f);
    END IF;
  END LOOP;
END $$
"""

FUNCTIONS_SQL = (
    ["SELECT pg_catalog.set_config('rls_migration.owner', current_user, true)", "SET LOCAL ROLE rls_definer", ASSERT_DEFINER]
    + FUNCTIONS
    + [GRANT_EXECUTE, "RESET ROLE"]
)

FUNCTIONS_REVERSE_SQL = [
    "SET LOCAL ROLE rls_definer",
    ASSERT_DEFINER,
    """
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::pg_catalog.regprocedure AS f
             FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'rls'::pg_catalog.regnamespace LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s', r.f);
  END LOOP;
END $$
""",
    "RESET ROLE",
]

# ------------------------------------------------------------ 3. policies (app_runtime)

FAM = "(SELECT rls.family_id())"
USER = "(SELECT rls.user_id())"
MEMBER = "(SELECT rls.is_member())"
ADMIN = "(SELECT rls.is_family_admin())"
ACTOR = "(SELECT rls.actor_person_id())"
LINK_PERSON = "(SELECT rls.assignment_link_person_id())"
# ANY ((SELECT f())) would parse as ANY (subquery) and fail with "bigint = bigint[]", hence the
# cast: it keeps the once-per-query scalar subquery and forces an array expression.
GUEST_LISTS = "((SELECT rls.guest_list_ids())::bigint[])"
GUEST_PERSONS = "((SELECT rls.guest_visible_person_ids())::bigint[])"

IN_FAMILY = f"family_id = {FAM}"
MANAGES_LIST = f"({ADMIN} OR ({MEMBER} AND (created_by_id = {USER} OR managed_by_id = {USER})))"
ASSIGNER_OR_ADMIN = f"({ADMIN} OR assigner_id = {USER})"
ASSIGNEE_VIA_LINK = f"(assignee_id = {LINK_PERSON} AND rls.item_not_on_recipient_list(item_id))"
ASSIGNMENT_WRITE = (
    f"{IN_FAMILY} AND ((rls.can_see_gift_state(item_id, false) AND {ASSIGNER_OR_ADMIN}) OR {ASSIGNEE_VIA_LINK})"
)
CAN_MANAGE_ISSUER = "rls.can_manage_link_issued_by(issued_by_id)"

# (name, table, command, USING, WITH CHECK). Every policy is TO app_runtime. Commands
# with no permissive policy are denied.
POLICIES = [
    # families_family
    (
        "family_select", "families_family", "SELECT",
        f"((id = {FAM} AND (SELECT rls.has_family_access())) OR (SELECT rls.is_instance_admin()))", None,
    ),
    ("family_insert", "families_family", "INSERT", None, "(SELECT rls.is_instance_admin())"),
    (
        "family_update", "families_family", "UPDATE",
        f"id = {FAM} AND {ADMIN}", f"id = {FAM} AND {ADMIN}",
    ),
    # membership (no INSERT: joining only via a future definer entry point)
    ("membership_select", "families_membership", "SELECT", f"{IN_FAMILY} AND {MEMBER}", None),
    (
        "membership_update", "families_membership", "UPDATE",
        f"{IN_FAMILY} AND {ADMIN}", f"{IN_FAMILY} AND {ADMIN}",
    ),
    ("membership_delete", "families_membership", "DELETE", f"{IN_FAMILY} AND ({ADMIN} OR user_id = {USER})", None),
    # person
    (
        "person_select", "families_person", "SELECT",
        f"{IN_FAMILY} AND ({MEMBER} OR id = ANY ({GUEST_PERSONS}) OR id = {LINK_PERSON})", None,
    ),
    ("person_insert", "families_person", "INSERT", None, f"{IN_FAMILY} AND {MEMBER} AND user_id IS NULL"),
    ("person_update", "families_person", "UPDATE", f"{IN_FAMILY} AND {MEMBER}", f"{IN_FAMILY} AND {MEMBER}"),
    ("person_delete", "families_person", "DELETE", f"{IN_FAMILY} AND {ADMIN}", None),
    # wishlist
    (
        "wishlist_select", "families_wishlist", "SELECT",
        f"{IN_FAMILY} AND ({MEMBER} OR id = ANY ({GUEST_LISTS}))", None,
    ),
    (
        "wishlist_insert", "families_wishlist", "INSERT", None,
        f"{IN_FAMILY} AND {MEMBER} AND created_by_id = {USER}",
    ),
    (
        "wishlist_update", "families_wishlist", "UPDATE",
        f"{IN_FAMILY} AND {MANAGES_LIST}", f"{IN_FAMILY} AND {MANAGES_LIST}",
    ),
    ("wishlist_delete", "families_wishlist", "DELETE", f"{IN_FAMILY} AND rls.can_manage_list(id)", None),
    # item (never filtered by claim state)
    (
        "item_select", "families_item", "SELECT",
        f"{IN_FAMILY} AND ({MEMBER} OR list_id = ANY ({GUEST_LISTS}))", None,
    ),
    ("item_insert", "families_item", "INSERT", None, f"{IN_FAMILY} AND rls.can_manage_list(list_id)"),
    (
        "item_update", "families_item", "UPDATE",
        f"{IN_FAMILY} AND rls.can_manage_list(list_id)", f"{IN_FAMILY} AND rls.can_manage_list(list_id)",
    ),
    ("item_delete", "families_item", "DELETE", f"{IN_FAMILY} AND rls.can_manage_list(list_id)", None),
    # claim (surprise rule). No UPDATE: release = DELETE, reassign = DELETE + INSERT.
    ("claim_select", "families_claim", "SELECT", f"{IN_FAMILY} AND rls.can_see_gift_state(item_id, true)", None),
    (
        "claim_insert", "families_claim", "INSERT", None,
        f"{IN_FAMILY} AND rls.can_see_gift_state(item_id, true) AND (claimer_id = {ACTOR} "
        "OR (assignment_id IS NOT NULL AND rls.is_assigner_or_admin(assignment_id)))",
    ),
    (
        "claim_delete", "families_claim", "DELETE",
        f"{IN_FAMILY} AND rls.can_see_gift_state(item_id, true) AND (claimer_id = {ACTOR} OR {ADMIN} "
        "OR (assignment_id IS NOT NULL AND rls.is_assigner_or_admin(assignment_id)))",
        None,
    ),
    # pledge (surprise rule)
    ("pledge_select", "families_pledge", "SELECT", f"{IN_FAMILY} AND rls.can_see_gift_state(item_id, true)", None),
    (
        "pledge_insert", "families_pledge", "INSERT", None,
        f"{IN_FAMILY} AND rls.can_see_gift_state(item_id, true) AND pledger_id = {ACTOR}",
    ),
    (
        "pledge_update", "families_pledge", "UPDATE",
        f"{IN_FAMILY} AND rls.can_see_gift_state(item_id, true) AND pledger_id = {ACTOR}",
        f"{IN_FAMILY} AND rls.can_see_gift_state(item_id, true) AND pledger_id = {ACTOR}",
    ),
    (
        "pledge_delete", "families_pledge", "DELETE",
        f"{IN_FAMILY} AND rls.can_see_gift_state(item_id, true) AND (pledger_id = {ACTOR} OR {ADMIN})", None,
    ),
    # assignment (surprise rule)
    (
        "assignment_select", "families_assignment", "SELECT",
        f"{IN_FAMILY} AND (rls.can_see_gift_state(item_id, false) OR {ASSIGNEE_VIA_LINK})", None,
    ),
    (
        "assignment_insert", "families_assignment", "INSERT", None,
        f"{IN_FAMILY} AND rls.can_see_gift_state(item_id, false) AND assigner_id = {USER} AND status = 'assigned'",
    ),
    ("assignment_update", "families_assignment", "UPDATE", ASSIGNMENT_WRITE, ASSIGNMENT_WRITE),
    (
        "assignment_delete", "families_assignment", "DELETE",
        f"{IN_FAMILY} AND rls.can_see_gift_state(item_id, false) AND {ASSIGNER_OR_ADMIN}", None,
    ),
    # guest link (no DELETE; revocation is monotonic, see triggers)
    ("guestlink_select", "families_guestlink", "SELECT", f"{IN_FAMILY} AND {CAN_MANAGE_ISSUER}", None),
    (
        "guestlink_insert", "families_guestlink", "INSERT", None,
        f"{IN_FAMILY} AND {MEMBER} AND issued_by_id = {USER} AND revoked_at IS NULL "
        "AND expires_at <= now() + interval '365 days'",
    ),
    (
        "guestlink_update", "families_guestlink", "UPDATE",
        f"{IN_FAMILY} AND {CAN_MANAGE_ISSUER}", f"{IN_FAMILY} AND {CAN_MANAGE_ISSUER}",
    ),
    # guest link scope (no UPDATE)
    (
        "gll_select", "families_guestlinklist", "SELECT",
        f"{IN_FAMILY} AND rls.can_manage_guest_link(guest_link_id)", None,
    ),
    (
        "gll_insert", "families_guestlinklist", "INSERT", None,
        f"{IN_FAMILY} AND rls.can_manage_guest_link(guest_link_id)",
    ),
    (
        "gll_delete", "families_guestlinklist", "DELETE",
        f"{IN_FAMILY} AND rls.can_manage_guest_link(guest_link_id)", None,
    ),
    # assignment link: same shape as guest link
    ("alink_select", "families_assignmentlink", "SELECT", f"{IN_FAMILY} AND {CAN_MANAGE_ISSUER}", None),
    (
        "alink_insert", "families_assignmentlink", "INSERT", None,
        f"{IN_FAMILY} AND {MEMBER} AND issued_by_id = {USER} AND revoked_at IS NULL "
        "AND expires_at <= now() + interval '365 days'",
    ),
    (
        "alink_update", "families_assignmentlink", "UPDATE",
        f"{IN_FAMILY} AND {CAN_MANAGE_ISSUER}", f"{IN_FAMILY} AND {CAN_MANAGE_ISSUER}",
    ),
    # invite (no DELETE; acceptance only via a future definer entry point)
    ("invite_select", "families_invite", "SELECT", f"{IN_FAMILY} AND {ADMIN}", None),
    (
        "invite_insert", "families_invite", "INSERT", None,
        f"{IN_FAMILY} AND {ADMIN} AND created_by_id = {USER} AND used_at IS NULL AND revoked_at IS NULL "
        "AND expires_at <= now() + interval '7 days' AND email = lower(email)",
    ),
    ("invite_update", "families_invite", "UPDATE", f"{IN_FAMILY} AND {ADMIN}", f"{IN_FAMILY} AND {ADMIN}"),
    # audit log: admins read it, minus rows about lists they receive. Writes: rls.audit_append only.
    (
        "auditlog_select", "families_auditlog", "SELECT",
        f"{IN_FAMILY} AND {ADMIN} AND (recipient_person_id IS NULL OR NOT rls.is_self_person(recipient_person_id))",
        None,
    ),
]


def _policy_sql(name, table, command, using, check):
    sql = f"CREATE POLICY {name} ON public.{table} FOR {command} TO app_runtime"
    if using:
        sql += f" USING ({using})"
    if check:
        sql += f" WITH CHECK ({check})"
    return sql


def _policies_sql():
    sql = []
    for table in TENANT_TABLES:
        # RESTRICTIVE: any permissive policy added later is still ANDed with this one, so it
        # can never widen access across families. Covers USING (old row) and WITH CHECK (new
        # row), which also makes family_id effectively immutable. The outbox has no
        # permissive policy and no app grants, so app_runtime cannot touch it at all.
        sql.append(
            f"CREATE POLICY tenant ON public.{table} AS RESTRICTIVE FOR ALL TO app_runtime "
            f"USING (family_id = {FAM}) WITH CHECK (family_id = {FAM})"
        )
    sql.extend(_policy_sql(*policy) for policy in POLICIES)
    return sql


def _policies_reverse_sql():
    sql = [f"DROP POLICY IF EXISTS tenant ON public.{table}" for table in TENANT_TABLES]
    sql.extend(f"DROP POLICY IF EXISTS {name} ON public.{table}" for name, table, *_ in POLICIES)
    return sql


# ------------------------------------------------------------------- 4. triggers (owner)

# (trigger name, table, timing/event clause, function call)
IMMUTABLE = [
    ("membership_immutable", "families_membership", "'user_id'"),
    ("wishlist_immutable", "families_wishlist", "'recipient_id', 'created_by_id'"),
    ("item_immutable", "families_item", "'list_id'"),
    ("pledge_immutable", "families_pledge", "'item_id', 'pledger_id'"),
    ("assignment_immutable", "families_assignment", "'item_id', 'assignee_id', 'assigner_id'"),
    ("guestlink_immutable", "families_guestlink", "'person_id', 'issued_by_id', 'token_hash', 'expires_at', 'created_at'"),
    ("alink_immutable", "families_assignmentlink", "'person_id', 'issued_by_id', 'token_hash', 'expires_at', 'created_at'"),
    (
        "invite_immutable", "families_invite",
        "'token_hash', 'email', 'role', 'created_by_id', 'expires_at', 'person_id'",
    ),
]
REVOKE_MONOTONIC = [
    ("guestlink_revoke_monotonic", "families_guestlink"),
    ("alink_revoke_monotonic", "families_assignmentlink"),
    ("invite_revoke_monotonic", "families_invite"),
]

TRIGGERS = (
    [
        f"CREATE TRIGGER {name} BEFORE UPDATE ON public.{table} FOR EACH ROW EXECUTE FUNCTION rls.tg_immutable({cols})"
        for name, table, cols in IMMUTABLE
    ]
    + [
        f"CREATE TRIGGER {name} BEFORE UPDATE ON public.{table} FOR EACH ROW EXECUTE FUNCTION rls.tg_revoke_monotonic()"
        for name, table in REVOKE_MONOTONIC
    ]
    + [
        "CREATE TRIGGER person_user_binding BEFORE UPDATE ON public.families_person "
        "FOR EACH ROW EXECUTE FUNCTION rls.tg_person_user_binding()",
        "CREATE TRIGGER assignment_status BEFORE UPDATE ON public.families_assignment "
        "FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION rls.tg_assignment_status()",
        "CREATE TRIGGER assignment_release AFTER UPDATE OF status ON public.families_assignment "
        "FOR EACH ROW WHEN (NEW.status = 'couldnt_get' AND OLD.status IS DISTINCT FROM NEW.status) "
        "EXECUTE FUNCTION rls.tg_assignment_release()",
        "CREATE TRIGGER claim_guard AFTER INSERT ON public.families_claim "
        "FOR EACH ROW EXECUTE FUNCTION rls.tg_claim_guard()",
        "CREATE TRIGGER pledge_guard AFTER INSERT ON public.families_pledge "
        "FOR EACH ROW EXECUTE FUNCTION rls.tg_recipient_guard('pledger_id')",
        "CREATE TRIGGER assignment_guard AFTER INSERT ON public.families_assignment "
        "FOR EACH ROW EXECUTE FUNCTION rls.tg_recipient_guard('assignee_id')",
        "CREATE CONSTRAINT TRIGGER membership_last_admin AFTER UPDATE OR DELETE ON public.families_membership "
        "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rls.tg_last_admin()",
        "CREATE TRIGGER claim_notify AFTER DELETE ON public.families_claim "
        "FOR EACH ROW EXECUTE FUNCTION rls.tg_claim_notify()",
        "CREATE TRIGGER item_notify AFTER UPDATE ON public.families_item FOR EACH ROW "
        "WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.notes IS DISTINCT FROM NEW.notes "
        "OR OLD.store_name IS DISTINCT FROM NEW.store_name OR OLD.store_url IS DISTINCT FROM NEW.store_url "
        "OR OLD.price IS DISTINCT FROM NEW.price OR OLD.quantity IS DISTINCT FROM NEW.quantity) "
        "EXECUTE FUNCTION rls.tg_item_notify()",
    ]
)

TRIGGERS_REVERSE_SQL = (
    [f"DROP TRIGGER IF EXISTS {name} ON public.{table}" for name, table, _ in IMMUTABLE]
    + [f"DROP TRIGGER IF EXISTS {name} ON public.{table}" for name, table in REVOKE_MONOTONIC]
    + [
        "DROP TRIGGER IF EXISTS person_user_binding ON public.families_person",
        "DROP TRIGGER IF EXISTS assignment_status ON public.families_assignment",
        "DROP TRIGGER IF EXISTS assignment_release ON public.families_assignment",
        "DROP TRIGGER IF EXISTS claim_guard ON public.families_claim",
        "DROP TRIGGER IF EXISTS pledge_guard ON public.families_pledge",
        "DROP TRIGGER IF EXISTS assignment_guard ON public.families_assignment",
        "DROP TRIGGER IF EXISTS membership_last_admin ON public.families_membership",
        "DROP TRIGGER IF EXISTS claim_notify ON public.families_claim",
        "DROP TRIGGER IF EXISTS item_notify ON public.families_item",
    ]
)


class Migration(migrations.Migration):

    dependencies = [
        ("families", "0002_schema_integrity"),
    ]

    operations = [
        migrations.RunSQL(sql=_base_sql(), reverse_sql=_base_reverse_sql()),
        migrations.RunSQL(sql=FUNCTIONS_SQL, reverse_sql=FUNCTIONS_REVERSE_SQL),
        migrations.RunSQL(sql=_policies_sql(), reverse_sql=_policies_reverse_sql()),
        migrations.RunSQL(sql=TRIGGERS, reverse_sql=TRIGGERS_REVERSE_SQL),
    ]
