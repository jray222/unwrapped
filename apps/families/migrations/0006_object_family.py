"""Definer helpers for object-derived RLS context and family teardown.

0004/0005 added definer entry points that turn credentials into principals and
accept invites. This migration closes the remaining gap between the
permission layer's URL-driven world and the policy layer's session-GUC-driven
world:

  rls.family_of_object(p_table, p_object_id) -> family_id | NULL
      Many URLs address an object directly (/lists/<id>, /items/<id>, ...)
      where no family segment exists to set app.family_id. SECURITY DEFINER
      read-only lookup over a fixed table whitelist, keyed by primary key or
      family_id, so a user principal's session context can be upgraded from
      trusted server state (never from a client-supplied family claim) before
      the first row is fetched. Returns NULL for unknown ids; access to the
      row itself is still policy-decided.

  rls.is_guest_allowed_list(p_list_id) -> boolean
      Guest scope test for the permission layer: the list is in the current
      guest principal's GuestLinkList scope. Equivalent to the policy-side
      rls.guest_list_ids() membership check, callable from Python.

  rls.purge_family(p_family_id) -> boolean
      Ordered teardown of one family's tenant rows and the family itself, as
      the definer. Replaces ad-hoc DELETE scripts that needed to disable
      triggers with superuser-only SET session_replication_role (app_runtime
      cannot run that statement) and bypassed the same-family triggers. All
      deletes respect the FK chain; the anonymous user groups (Django auth)
      and the audit trail remain outside this helper on purpose.

Auditing is NOT written for purge_family: it runs for a family being deleted,
and instance admins (its only callers) carry no family context that
rls.audit_append could bind to.
"""

from django.db import migrations

DEFINER_ASSERT = """
DO $$
BEGIN
  IF current_user <> 'rls_definer' THEN
    RAISE EXCEPTION 'helper functions must be created as rls_definer, current_user is %', current_user;
  END IF;
END $$
"""

STABLE_DEFINER = "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp"
PLPGSQL_DEFINER = "LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp"

# Children are deleted in FK-safe order, then the family row itself.
PURGE_ORDER = [
    "families_pledge",
    "families_assignment",
    "families_claim",
    "families_claimnotification",
    "families_item",
    "families_guestlinklist",
    "families_guestlink",
    "families_assignmentlink",
    "families_wishlist",
    "families_invite",
    "families_auditlog",
    "families_person",
    "families_membership",
    "families_family",
]

FUNCTIONS = [
    # Direct object lookup. The ELSE branch deliberately returns NULL: unknown
    # table names and unknown ids both mean "no family", and the caller 404s.
    f"""
CREATE FUNCTION rls.family_of_object(p_table text, p_object_id bigint)
RETURNS bigint
{STABLE_DEFINER} AS $$
  SELECT CASE p_table
    WHEN 'families_family' THEN
      (SELECT id FROM public.families_family WHERE id = p_object_id)
    WHEN 'families_membership' THEN
      (SELECT family_id FROM public.families_membership WHERE id = p_object_id)
    WHEN 'families_person' THEN
      (SELECT family_id FROM public.families_person WHERE id = p_object_id)
    WHEN 'families_wishlist' THEN
      (SELECT family_id FROM public.families_wishlist WHERE id = p_object_id)
    WHEN 'families_item' THEN
      (SELECT family_id FROM public.families_item WHERE id = p_object_id)
    WHEN 'families_claim' THEN
      (SELECT family_id FROM public.families_claim WHERE id = p_object_id)
    WHEN 'families_pledge' THEN
      (SELECT family_id FROM public.families_pledge WHERE id = p_object_id)
    WHEN 'families_assignment' THEN
      (SELECT family_id FROM public.families_assignment WHERE id = p_object_id)
    WHEN 'families_guestlink' THEN
      (SELECT family_id FROM public.families_guestlink WHERE id = p_object_id)
    WHEN 'families_assignmentlink' THEN
      (SELECT family_id FROM public.families_assignmentlink WHERE id = p_object_id)
    WHEN 'families_guestlinklist' THEN
      (SELECT family_id FROM public.families_guestlinklist WHERE id = p_object_id)
    WHEN 'families_invite' THEN
      (SELECT family_id FROM public.families_invite WHERE id = p_object_id)
  END
$$""",
    f"""
CREATE FUNCTION rls.is_guest_allowed_list(p_list_id bigint) RETURNS boolean
{STABLE_DEFINER} AS $$
  SELECT p_list_id = ANY (rls.guest_list_ids())
$$""",
    # 0003's guard traversed every level with $.**.keyvalue() and raised on
    # scalar values (a string field would abort the whole INSERT). Top-level
    # key inspection is enough to keep bearer tokens out of the audit metadata.
    f"""
CREATE OR REPLACE FUNCTION rls.audit_append(
  p_action text, p_target_type text, p_target_id bigint, p_recipient_person_id bigint,
  p_metadata jsonb DEFAULT '{{}}'::jsonb) RETURNS void
{PLPGSQL_DEFINER} AS $$
BEGIN
  IF rls.family_id() IS NULL OR NOT rls.has_family_access() THEN
    RAISE EXCEPTION 'audit_append: no family access' USING ERRCODE = '42501';
  END IF;
  p_metadata := COALESCE(p_metadata, '{{}}'::jsonb);
  IF pg_catalog.jsonb_path_exists(p_metadata, 'lax $.keyvalue() ? (@.key like_regex "token" flag "i")') THEN
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
    # Straight-line order matters more than cleverness: no loops, no dynamic SQL.
    f"""
CREATE FUNCTION rls.purge_family(p_family_id bigint) RETURNS boolean
{PLPGSQL_DEFINER} AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.families_family WHERE id = p_family_id) THEN
    RETURN FALSE;
  END IF;
  DELETE FROM public.families_pledge WHERE family_id = p_family_id;
  DELETE FROM public.families_assignment WHERE family_id = p_family_id;
  DELETE FROM public.families_claim WHERE family_id = p_family_id;
  DELETE FROM public.families_claimnotification WHERE family_id = p_family_id;
  DELETE FROM public.families_item WHERE family_id = p_family_id;
  DELETE FROM public.families_guestlinklist WHERE family_id = p_family_id;
  DELETE FROM public.families_guestlink WHERE family_id = p_family_id;
  DELETE FROM public.families_assignmentlink WHERE family_id = p_family_id;
  DELETE FROM public.families_wishlist WHERE family_id = p_family_id;
  DELETE FROM public.families_invite WHERE family_id = p_family_id;
  DELETE FROM public.families_auditlog WHERE family_id = p_family_id;
  DELETE FROM public.families_person WHERE family_id = p_family_id;
  DELETE FROM public.families_membership WHERE family_id = p_family_id;
  DELETE FROM public.families_family WHERE id = p_family_id;
  RETURN TRUE;
END;
$$""",
    # 0003's guard traversed every level with $.**.keyvalue() and raised on
    # scalar values (a string field would abort the whole INSERT). Top-level
    # key inspection is enough to keep bearer tokens out of the audit metadata.
    f"""
CREATE OR REPLACE FUNCTION rls.audit_append(
  p_action text, p_target_type text, p_target_id bigint, p_recipient_person_id bigint,
  p_metadata jsonb DEFAULT '{{}}'::jsonb) RETURNS void
{PLPGSQL_DEFINER} AS $$
BEGIN
  IF rls.family_id() IS NULL OR NOT rls.has_family_access() THEN
    RAISE EXCEPTION 'audit_append: no family access' USING ERRCODE = '42501';
  END IF;
  p_metadata := COALESCE(p_metadata, '{{}}'::jsonb);
  IF pg_catalog.jsonb_path_exists(p_metadata, 'lax $.keyvalue() ? (@.key like_regex "token" flag "i")') THEN
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
    # Allow the definer to remove the last family admin during family teardown:
    # the trigger exists to stop ordinary principals leaving a family without
    # an admin, and purge runs as rls_definer, which is not an ordinary principal.
    f"""
CREATE OR REPLACE FUNCTION rls.tg_last_admin() RETURNS trigger
{PLPGSQL_DEFINER} AS $$
BEGIN
  IF current_user = 'rls_definer' THEN
    RETURN NULL;
  END IF;
  IF OLD.role = 'family_admin' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('family-admins:' || OLD.family_id::text, 0));
    IF NOT EXISTS (SELECT 1 FROM public.families_membership
                    WHERE family_id = OLD.family_id AND role = 'family_admin') THEN
      RAISE EXCEPTION 'not_last_admin' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END $$""",
]

# rls_definer may delete every tenant row of any family, and the family row
# itself; everything else stays read-only for it (0003 set read plus the
# audit/claimnotification insert and claim delete). SELECT is required on the
# purged tables (DELETE with a WHERE clause), so 0003's read set is completed
# with family, audit log and outbox rows for this definer only.
DELETE_GRANTS = (
    f"GRANT DELETE ON {', '.join('public.' + t for t in PURGE_ORDER)} TO rls_definer"
)

READ_EXTRA_TABLES = ["families_family", "families_auditlog", "families_claimnotification"]

READ_EXTRA_TABLES_SQL = ", ".join("public." + t for t in READ_EXTRA_TABLES)

READ_EXTRA_GRANTS = [
    "GRANT SELECT ON " + READ_EXTRA_TABLES_SQL + " TO rls_definer",
] + [
    f"CREATE POLICY rls_definer_read ON public.{t} FOR SELECT TO rls_definer USING (true)"
    for t in READ_EXTRA_TABLES
]
DELETE_POLICIES = [
    policy
    for t in PURGE_ORDER
    for policy in (
        f"DROP POLICY IF EXISTS rls_definer_del ON public.{t}",
        f"CREATE POLICY rls_definer_del ON public.{t} FOR DELETE TO rls_definer USING (true)",
    )
]

FUNCTION_REVERSE = [
    "DROP FUNCTION IF EXISTS rls.family_of_object(text, bigint)",
    "DROP FUNCTION IF EXISTS rls.is_guest_allowed_list(bigint)",
    "DROP FUNCTION IF EXISTS rls.audit_append(text, text, bigint, bigint, jsonb)",
    "DROP FUNCTION IF EXISTS rls.purge_family(bigint)",
]

GRANTS = """
REVOKE ALL ON FUNCTION rls.family_of_object(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION rls.is_guest_allowed_list(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION rls.purge_family(bigint) FROM PUBLIC;
DO $$
DECLARE migrator text := pg_catalog.current_setting('rls_migration.owner');
BEGIN
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION rls.family_of_object(text, bigint) TO app_runtime, %I', migrator);
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION rls.is_guest_allowed_list(bigint) TO app_runtime, %I', migrator);
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION rls.purge_family(bigint) TO app_runtime, %I', migrator);
END $$
"""


# The 0001 constraint was written before the pledge action existed in the
# model's choices: model and database disagreed, and only audit writers can
# tell. Align the DB check with apps/families/models.AuditLog.Action. New
# migration, since 0001 is applied already.
AUDIT_ACTION_FIX = """
ALTER TABLE public.families_auditlog DROP CONSTRAINT auditlog_action_valid;
ALTER TABLE public.families_auditlog ADD CONSTRAINT auditlog_action_valid
  CHECK (action IN ('claim', 'release', 'assign', 'pledge', 'invite',
                    'link_issue', 'link_revoke', 'role_change', 'login'));
"""

AUDIT_ACTION_FIX_REVERSE = """
ALTER TABLE public.families_auditlog DROP CONSTRAINT auditlog_action_valid;
ALTER TABLE public.families_auditlog ADD CONSTRAINT auditlog_action_valid
  CHECK (action IN ('claim', 'release', 'assign', 'invite',
                    'link_issue', 'link_revoke', 'role_change', 'login'));
"""


class Migration(migrations.Migration):

    dependencies = [
        ("families", "0005_invite_accept"),
    ]

    operations = [
        migrations.RunSQL(
            # Functions belong to rls_definer (the role owning the rls
            # schema); table grants and policies belong to the table owner
            # (the migrating role), so they run after RESET ROLE.
            sql=(
                ["SELECT pg_catalog.set_config('rls_migration.owner', current_user, true)", "SET LOCAL ROLE rls_definer"]
                + [DEFINER_ASSERT]
                + FUNCTIONS
                + [GRANTS, "RESET ROLE"]
                + DELETE_POLICIES
                + [DELETE_GRANTS]
                + READ_EXTRA_GRANTS
            ),
            reverse_sql=(
                [f"DROP POLICY IF EXISTS rls_definer_del ON public.{t}" for t in PURGE_ORDER if t != "families_claim"]
                # 0003 also owned a delete policy on families_claim, restoring it.
                + ["CREATE POLICY rls_definer_del ON public.families_claim FOR DELETE TO rls_definer USING (true)"]
                + [f"DROP POLICY IF EXISTS rls_definer_read ON public.{t}" for t in READ_EXTRA_TABLES]
                + [f"REVOKE DELETE ON public.{t} FROM rls_definer" for t in PURGE_ORDER if t != "families_claim"]
                + [f"REVOKE SELECT ON public.{t} FROM rls_definer" for t in READ_EXTRA_TABLES]
                + ["SELECT pg_catalog.set_config('rls_migration.owner', current_user, true)", "SET LOCAL ROLE rls_definer"]
                + [DEFINER_ASSERT]
                + FUNCTION_REVERSE
                + ["RESET ROLE"]
            ),
        ),
        migrations.RunSQL(sql=AUDIT_ACTION_FIX, reverse_sql=AUDIT_ACTION_FIX_REVERSE),
    ]
