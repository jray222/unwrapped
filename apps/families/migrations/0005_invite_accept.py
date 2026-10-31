"""Invite accept definer function and table grants for rls_definer.

Invites are single-use bearer credentials (CLAUDE.md rule 6). Accepting an
invite is an unauthenticated action (anonymous principal) that:
1. Validates the invite token and email match.
2. Marks the invite as used (used_at = now()).
3. Creates the Membership row for the new user.
4. Binds the user to an existing user-less Person row, or creates a new Person.

Because families_membership, families_invite, and families_person enforce RLS
policies restricting modifications to admins or members, this transition
happens exclusively via rls.accept_invite owned by rls_definer.
"""

from django.db import migrations

ASSERT_DEFINER = """
DO $$
BEGIN
  IF current_user <> 'rls_definer' THEN
    RAISE EXCEPTION 'helper functions must be created as rls_definer, current_user is %', current_user;
  END IF;
END $$
"""

PLPGSQL_DEFINER = "LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp"

BASE_SQL = [
    "GRANT INSERT, UPDATE (role, updated_at) ON public.families_membership TO rls_definer",
    "GRANT INSERT ON public.families_person TO rls_definer",
    "GRANT UPDATE (used_at) ON public.families_invite TO rls_definer",
    "GRANT UPDATE (user_id, updated_at) ON public.families_person TO rls_definer",
    "CREATE POLICY rls_definer_ins ON public.families_membership FOR INSERT TO rls_definer WITH CHECK (true)",
    "CREATE POLICY rls_definer_upd ON public.families_membership FOR UPDATE TO rls_definer USING (true) WITH CHECK (true)",
    "CREATE POLICY rls_definer_ins ON public.families_person FOR INSERT TO rls_definer WITH CHECK (true)",
    "CREATE POLICY rls_definer_upd ON public.families_invite FOR UPDATE TO rls_definer USING (true) WITH CHECK (true)",
    "CREATE POLICY rls_definer_upd ON public.families_person FOR UPDATE TO rls_definer USING (true) WITH CHECK (true)",
]

BASE_REVERSE = [
    "DROP POLICY IF EXISTS rls_definer_ins ON public.families_membership",
    "DROP POLICY IF EXISTS rls_definer_upd ON public.families_membership",
    "DROP POLICY IF EXISTS rls_definer_ins ON public.families_person",
    "DROP POLICY IF EXISTS rls_definer_upd ON public.families_invite",
    "DROP POLICY IF EXISTS rls_definer_upd ON public.families_person",
    "REVOKE INSERT, UPDATE ON public.families_membership FROM rls_definer",
    "REVOKE INSERT ON public.families_person FROM rls_definer",
    "REVOKE UPDATE ON public.families_invite, public.families_person FROM rls_definer",
]

FUNCTION_SQL = f"""
CREATE FUNCTION rls.accept_invite(p_token_hash text, p_email text, p_user_id bigint)
RETURNS boolean
{PLPGSQL_DEFINER} AS $$
DECLARE
  v_invite public.families_invite%ROWTYPE;
  v_person_id bigint;
BEGIN
  SELECT * INTO v_invite
    FROM public.families_invite
   WHERE token_hash = p_token_hash
     AND lower(email) = lower(p_email)
     AND used_at IS NULL
     AND revoked_at IS NULL
     AND expires_at > pg_catalog.now()
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- 1. Mark invite as used (single use)
  UPDATE public.families_invite
     SET used_at = pg_catalog.now()
   WHERE id = v_invite.id;

  -- 2. Create Membership for user in family
  INSERT INTO public.families_membership (family_id, user_id, role, created_at, updated_at)
  VALUES (v_invite.family_id, p_user_id, v_invite.role, pg_catalog.now(), pg_catalog.now())
  ON CONFLICT (family_id, user_id) DO UPDATE SET role = EXCLUDED.role;

  -- 3. Bind Person row to user
  IF v_invite.person_id IS NOT NULL THEN
    UPDATE public.families_person
       SET user_id = p_user_id, updated_at = pg_catalog.now()
     WHERE id = v_invite.person_id AND user_id IS NULL;
  ELSE
    SELECT id INTO v_person_id
      FROM public.families_person
     WHERE family_id = v_invite.family_id
       AND (user_id = p_user_id OR (user_id IS NULL AND lower(email) = lower(p_email)))
     LIMIT 1;

    IF v_person_id IS NOT NULL THEN
      UPDATE public.families_person
         SET user_id = p_user_id, updated_at = pg_catalog.now()
       WHERE id = v_person_id AND user_id IS NULL;
    ELSE
      INSERT INTO public.families_person (family_id, user_id, first_name, last_name, email, created_at, updated_at)
      VALUES (v_invite.family_id, p_user_id, split_part(v_invite.email, '@', 1), '', v_invite.email, pg_catalog.now(), pg_catalog.now());
    END IF;
  END IF;

  RETURN TRUE;
END;
$$
"""

GRANTS = """
REVOKE ALL ON FUNCTION rls.accept_invite(text, text, bigint) FROM PUBLIC;
DO $$
DECLARE migrator text := pg_catalog.current_setting('rls_migration.owner');
BEGIN
  EXECUTE pg_catalog.format(
    'GRANT EXECUTE ON FUNCTION rls.accept_invite(text, text, bigint) TO app_runtime, %I',
    migrator);
END $$
"""

FUNCTION_REVERSE = [
    "SET LOCAL ROLE rls_definer",
    ASSERT_DEFINER,
    "DROP FUNCTION IF EXISTS rls.accept_invite(text, text, bigint)",
    "RESET ROLE",
]


class Migration(migrations.Migration):

    dependencies = [
        ("families", "0004_token_exchange"),
    ]

    operations = [
        migrations.RunSQL(sql=BASE_SQL, reverse_sql=BASE_REVERSE),
        migrations.RunSQL(
            sql=[
                "SELECT pg_catalog.set_config('rls_migration.owner', current_user, true)",
                "SET LOCAL ROLE rls_definer",
                ASSERT_DEFINER,
                FUNCTION_SQL,
                GRANTS,
                "RESET ROLE",
            ],
            reverse_sql=FUNCTION_REVERSE,
        ),
    ]
