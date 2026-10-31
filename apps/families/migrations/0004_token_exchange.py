"""Definer functions that map token credentials to link principals.

Guest and assignment links are bearer tokens: only their SHA-256 digest is
stored (apps/families/models.py TokenModel). Validating a presented token, or
keeping an exchanged session alive, must read the link row -- but the SELECT
policies on families_guestlink / families_assignmentlink require a member with
manage rights, and the exchanging principal is anonymous. These two SECURITY
DEFINER helpers (schema rls owner rls_definer, exactly like the 0003 helpers)
are therefore the only DB paths that turn a token/credential into a principal
identity, and the only write-capable free read the app gets on those rows:

  rls.exchange_link_token(kind, token_hash) -> (family_id, link_id) | NULL
      Used once per exchange attempt. Returns identity ONLY for an active link
      (not revoked, not expired) matching the presented digest. A row absent,
      revoked or expired all come back NULL: the caller cannot distinguish
      them, and neither shall the response reveal which one it was.
  rls.link_is_active(kind, link_id) -> boolean
      Used by principal resolution on every request of an exchanged session, so
      revocation and expiry cut access at the DB layer rather than only in the
      session store (revocation is re-checked again per statement by the RLS
      policy functions, e.g. rls.guest_link_id()).

Per-statement re-verification inside the policies (issuer, person and expiry
are all read fresh) means a revoked or expired link yields zero rows even if a
stale session still carries the ids: default deny, twice checked.
"""

from django.db import migrations

STABLE_DEFINER = "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp"

ASSERT_DEFINER = """
DO $$
BEGIN
  IF current_user <> 'rls_definer' THEN
    RAISE EXCEPTION 'helper functions must be created as rls_definer, current_user is %', current_user;
  END IF;
END $$
"""

FUNCTIONS = [
    f"""
CREATE FUNCTION rls.exchange_link_token(
  p_kind text, p_token_hash text)
RETURNS TABLE (family_id bigint, link_id bigint)
{STABLE_DEFINER} AS $$
  SELECT g.family_id, g.id FROM public.families_guestlink g
   WHERE p_kind = 'guest' AND g.token_hash = p_token_hash
     AND g.revoked_at IS NULL AND g.expires_at > pg_catalog.now()
  UNION ALL
  SELECT a.family_id, a.id FROM public.families_assignmentlink a
   WHERE p_kind = 'assignment_link' AND a.token_hash = p_token_hash
     AND a.revoked_at IS NULL AND a.expires_at > pg_catalog.now()
$$""",
    f"""
CREATE FUNCTION rls.link_is_active(p_kind text, p_link_id bigint) RETURNS boolean
{STABLE_DEFINER} AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.families_guestlink g
     WHERE p_kind = 'guest' AND g.id = p_link_id
       AND g.revoked_at IS NULL AND g.expires_at > pg_catalog.now())
  OR EXISTS (
    SELECT 1 FROM public.families_assignmentlink a
     WHERE p_kind = 'assignment_link' AND a.id = p_link_id
       AND a.revoked_at IS NULL AND a.expires_at > pg_catalog.now())
$$""",
]

# p_token_hash is caller-supplied text; the exchange function returns an
# identity, so the app role must hold EXECUTE, like on the other app-callable
# helpers (see 0003 GRANT_EXECUTE).
GRANTS = """
REVOKE ALL ON FUNCTION rls.exchange_link_token(p_kind text, p_token_hash text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rls.link_is_active(p_kind text, p_link_id bigint) FROM PUBLIC;
DO $$
DECLARE migrator text := pg_catalog.current_setting('rls_migration.owner');
BEGIN
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION rls.exchange_link_token(p_kind text, p_token_hash text) TO app_runtime, %I',
    migrator);
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION rls.link_is_active(p_kind text, p_link_id bigint) TO app_runtime, %I',
    migrator);
END $$
"""

REVERSE = [
    "SET LOCAL ROLE rls_definer",
    ASSERT_DEFINER,
    "DROP FUNCTION IF EXISTS rls.exchange_link_token(p_kind text, p_token_hash text)",
    "DROP FUNCTION IF EXISTS rls.link_is_active(p_kind text, p_link_id bigint)",
    "RESET ROLE",
]


class Migration(migrations.Migration):

    dependencies = [
        ("families", "0003_rls"),
    ]

    operations = [
        migrations.RunSQL(
            sql=(
                ["SELECT pg_catalog.set_config('rls_migration.owner', current_user, true)", "SET LOCAL ROLE rls_definer"]
                + [ASSERT_DEFINER]
                + FUNCTIONS
                + [GRANTS, "RESET ROLE"]
            ),
            reverse_sql=REVERSE,
        ),
    ]
