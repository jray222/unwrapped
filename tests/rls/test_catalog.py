"""Catalog tests: the shape of roles, grants, policies and functions, read as the app role."""

import os

import pytest
from django.apps import apps
from django.db import connection

from apps.families.models import TenantModel

APP_ROLE = os.environ.get("RLS_TEST_APP", "")
OWNER_ROLE = os.environ.get("RLS_TEST_OWNER", "")

RLS_TABLES = sorted(
    {m._meta.db_table for m in apps.get_app_config("families").get_models() if issubclass(m, TenantModel)}
    | {"families_family"}
)

EXPECTED_POLICIES = {
    "families_family": {"family_select", "family_insert", "family_update"},
    "families_membership": {"membership_select", "membership_update", "membership_delete", "rls_definer_read"},
    "families_person": {"person_select", "person_insert", "person_update", "person_delete", "rls_definer_read"},
    "families_wishlist": {"wishlist_select", "wishlist_insert", "wishlist_update", "wishlist_delete", "rls_definer_read"},
    "families_item": {"item_select", "item_insert", "item_update", "item_delete", "rls_definer_read"},
    "families_claim": {"claim_select", "claim_insert", "claim_delete", "rls_definer_read", "rls_definer_del"},
    "families_pledge": {"pledge_select", "pledge_insert", "pledge_update", "pledge_delete", "rls_definer_read"},
    "families_assignment": {
        "assignment_select", "assignment_insert", "assignment_update", "assignment_delete", "rls_definer_read",
    },
    "families_guestlink": {"guestlink_select", "guestlink_insert", "guestlink_update", "rls_definer_read"},
    "families_guestlinklist": {"gll_select", "gll_insert", "gll_delete", "rls_definer_read"},
    "families_assignmentlink": {"alink_select", "alink_insert", "alink_update", "rls_definer_read"},
    "families_invite": {"invite_select", "invite_insert", "invite_update", "rls_definer_read"},
    "families_auditlog": {"auditlog_select", "rls_definer_ins"},
    "families_claimnotification": {"rls_definer_ins"},
}
for _table, _names in EXPECTED_POLICIES.items():
    if _table != "families_family":
        _names.add("tenant")


def q(sql, params=()):
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchall()


def test_connection_is_the_unprivileged_app_role():
    ((user, is_super, bypass),) = q(
        "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user"
    )
    assert user == APP_ROLE and user != OWNER_ROLE
    assert not is_super and not bypass
    assert q("SELECT count(*) FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)") == [
        (0,)
    ]
    # The login role inherits app_runtime but is not a member of rls_definer or the migrator.
    assert q("SELECT pg_has_role(current_user, 'app_runtime', 'MEMBER')") == [(True,)]
    assert q("SELECT pg_has_role(current_user, 'rls_definer', 'MEMBER')") == [(False,)]
    assert q("SELECT pg_has_role(current_user, %s, 'MEMBER')", [OWNER_ROLE]) == [(False,)]


def test_group_roles_cannot_login_or_bypass():
    rows = q(
        "SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles"
        " WHERE rolname IN ('app_runtime', 'rls_definer') ORDER BY 1"
    )
    assert rows == [("app_runtime", False, False, False), ("rls_definer", False, False, False)]


def test_tables_are_owned_by_the_migrator_only():
    owners = {r[0] for r in q("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname LIKE 'families\\_%%' AND relkind = 'r'")}
    assert owners == {OWNER_ROLE}


def test_rls_enabled_and_forced_on_every_table():
    assert RLS_TABLES == sorted(EXPECTED_POLICIES)
    rows = dict(
        (name, (rls, force))
        for name, rls, force in q("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relkind = 'r'")
    )
    for table in RLS_TABLES:
        assert rows[table] == (True, True), table


def test_exact_policy_set_per_table():
    actual = {}
    for table, name in q("SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'"):
        actual.setdefault(table, set()).add(name)
    assert actual == EXPECTED_POLICIES


def test_every_tenant_table_has_one_restrictive_tenant_policy():
    rows = q("SELECT tablename, permissive, roles::text FROM pg_policies WHERE policyname = 'tenant'")
    assert sorted(t for t, *_ in rows) == sorted(set(RLS_TABLES) - {"families_family"})
    assert all(permissive == "RESTRICTIVE" and roles == "{app_runtime}" for _, permissive, roles in rows)


def test_no_policy_is_to_public_and_none_is_unconditional_for_app_runtime():
    for table, name, roles, qual, check in q(
        "SELECT tablename, policyname, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public'"
    ):
        assert "public" not in roles, (table, name)
        if "app_runtime" in roles:
            assert (qual or "").strip("() ") != "true", (table, name)
            assert (check or "").strip("() ") != "true", (table, name)
        else:
            assert roles == "{rls_definer}", (table, name)


def test_policies_avoid_forbidden_patterns():
    # Policies read the session only through rls.* accessors, never current_setting or COALESCE fallbacks.
    for table, name, qual, check in q(
        "SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE roles::text LIKE '%%app_runtime%%'"
    ):
        text = f"{qual} {check}".lower()
        assert "current_setting" not in text, (table, name)
        assert "coalesce" not in text, (table, name)
        assert "family_id() is null" not in text, (table, name)


@pytest.mark.parametrize("privilege", ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])
def test_audit_log_is_append_only_for_the_app_role(privilege):
    assert q("SELECT has_table_privilege(current_user, 'families_auditlog', %s)", [privilege]) == [(False,)]
    assert q("SELECT has_table_privilege(current_user, 'families_auditlog', 'SELECT')") == [(True,)]


def test_grant_deltas():
    def priv(table, p):
        return q("SELECT has_table_privilege(current_user, %s, %s)", [table, p])[0][0]

    assert not priv("families_claim", "UPDATE")
    assert not priv("families_guestlinklist", "UPDATE")
    assert not priv("families_membership", "INSERT")
    for table in ("families_family", "families_guestlink", "families_assignmentlink", "families_invite"):
        assert not priv(table, "DELETE"), table
    for table in RLS_TABLES:
        for p in ("TRUNCATE", "REFERENCES", "TRIGGER"):
            assert not priv(table, p), (table, p)
    for p in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert not priv("families_claimnotification", p), p


def test_definer_functions_are_hardened():
    rows = q(
        "SELECT p.proname, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig FROM pg_proc p"
        " WHERE p.pronamespace = 'rls'::regnamespace"
    )
    assert len(rows) > 20
    for name, owner, secdef, config in rows:
        assert owner == "rls_definer", name
        if secdef:
            assert config and "search_path=pg_catalog, pg_temp" in config, name
    # No function may be executable by PUBLIC (a NULL ACL means the PUBLIC default).
    assert q(
        "SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'rls'::regnamespace AND (p.proacl IS NULL"
        " OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))"
    ) == []


def test_app_role_cannot_execute_trigger_functions_or_create_in_schemas():
    assert q("SELECT has_function_privilege(current_user, 'rls.tg_claim_guard()', 'EXECUTE')") == [(False,)]
    assert q("SELECT has_function_privilege(current_user, 'rls.audit_append(text,text,bigint,bigint,jsonb)', 'EXECUTE')") == [
        (True,)
    ]
    assert q("SELECT has_schema_privilege(current_user, 'public', 'CREATE'), has_schema_privilege(current_user, 'rls', 'CREATE')") == [
        (False, False)
    ]
    assert q("SELECT has_database_privilege(current_user, current_database(), 'TEMP')") == [(False,)]
