"""RLS behaviour tests: they only mean something as the real, unprivileged app role.

Set up with tests/rls/bootstrap_test_roles.sh. Required environment:

  DB_NAME / DB_USER / DB_PASSWORD / DB_HOST   Django connects as the APP role (non-superuser,
                                              non-BYPASSRLS, owns nothing)
  RLS_TEST_APP                                 that role's name; asserted against current_user
  RLS_TEST_OWNER                               the migrator/owner role's name
  RLS_TEST_ADMIN_DSN                           libpq DSN of a SUPERUSER, used only to seed and wipe data
  RLS_TESTS_REQUIRED=1                         fail (instead of skip) when the above is missing

If the environment is absent the whole directory is skipped with a reason, unless
RLS_TESTS_REQUIRED is set, in which case it fails.
"""

import os
from datetime import timedelta
from types import SimpleNamespace

import psycopg
import pytest
from django.db import connection, connections

from rls_seed import Seed

APP_ROLE = os.environ.get("RLS_TEST_APP", "")
OWNER_ROLE = os.environ.get("RLS_TEST_OWNER", "")
ADMIN_DSN = os.environ.get("RLS_TEST_ADMIN_DSN", "")
REQUIRED = os.environ.get("RLS_TESTS_REQUIRED") == "1"


def _unconfigured(reason):
    if REQUIRED:
        pytest.fail(f"RLS tests are required but not configured: {reason}", pytrace=False)
    pytest.skip(f"RLS tests need tests/rls/bootstrap_test_roles.sh and its env: {reason}")


@pytest.fixture(autouse=True)
def _app_role_connection(django_db_blocker):
    """Unblock the database and prove, on every test, that Django is the unprivileged app role."""
    if not (APP_ROLE and OWNER_ROLE and ADMIN_DSN):
        _unconfigured("RLS_TEST_APP, RLS_TEST_OWNER and RLS_TEST_ADMIN_DSN must be set")
    with django_db_blocker.unblock():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user"
            )
            current_user, is_super, bypass_rls = cursor.fetchone()
        assert current_user == APP_ROLE, f"Django connected as {current_user!r}, expected app role {APP_ROLE!r}"
        assert not is_super and not bypass_rls, "the app role must be NOSUPERUSER and NOBYPASSRLS"
        yield
        connections.close_all()


@pytest.fixture(scope="session")
def _admin_conn():
    if not ADMIN_DSN:
        _unconfigured("RLS_TEST_ADMIN_DSN is not set")
    conn = psycopg.connect(ADMIN_DSN, autocommit=True)
    assert conn.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user").fetchone()[0], (
        "RLS_TEST_ADMIN_DSN must be a superuser connection (it seeds data the app role cannot create)"
    )
    yield conn
    conn.close()


@pytest.fixture
def admin_sql(_admin_conn):
    """Run SQL as the superuser (verification and seeding only); returns all rows."""

    def run(sql, params=()):
        cur = _admin_conn.execute(sql, params)
        return cur.fetchall() if cur.description else None

    return run


@pytest.fixture
def seed(_admin_conn):
    s = Seed(_admin_conn)
    s.wipe()
    yield s
    s.wipe()


@pytest.fixture
def world(seed):
    """Two families. Alpha: an admin, three members, Rita (a member who is the recipient of a
    list), and guest/assignment-link Persons. Claims, a pledge and an assignment exist on
    Rita's list and on other lists, so recipient-vs-giver views differ.
    """
    w = SimpleNamespace(seed=seed)
    w.alpha, w.beta = seed.family("Alpha"), seed.family("Beta")
    for name in ("admin", "gus", "mia", "rita", "zed", "bea"):
        setattr(w, f"u_{name}", seed.user(name))
    seed.membership(w.alpha, w.u_admin, "family_admin")
    for name in ("gus", "mia", "rita"):
        seed.membership(w.alpha, getattr(w, f"u_{name}"))
    seed.membership(w.beta, w.u_bea, "family_admin")
    seed.membership(w.beta, w.u_zed)

    for name in ("admin", "gus", "mia", "rita"):
        setattr(w, f"p_{name}", seed.person(w.alpha, name.title(), user=getattr(w, f"u_{name}")))
    w.p_guest = seed.person(w.alpha, "Grandma")
    w.p_zed = seed.person(w.beta, "Zed", user=w.u_zed)
    w.p_bea = seed.person(w.beta, "Bea", user=w.u_bea)

    w.l_rita = seed.wishlist(w.alpha, w.p_rita, w.u_admin, title="Rita's list")
    w.l_gus = seed.wishlist(w.alpha, w.p_gus, w.u_gus, title="Gus's list")
    w.l_admin = seed.wishlist(w.alpha, w.p_admin, w.u_gus, title="Admin's list")
    w.l_beta = seed.wishlist(w.beta, w.p_zed, w.u_bea, title="Zed's list")

    w.i_rita = seed.item(w.alpha, w.l_rita, "Rita item", quantity=3)
    w.i_rita_free = seed.item(w.alpha, w.l_rita, "Rita unclaimed", quantity=1)
    w.i_gus = seed.item(w.alpha, w.l_gus, "Gus item", quantity=2)
    w.i_admin = seed.item(w.alpha, w.l_admin, "Admin item")
    w.i_beta = seed.item(w.beta, w.l_beta, "Beta item")

    w.a_rita = seed.assignment(w.alpha, w.i_rita, w.p_mia, w.u_admin)
    w.c_rita_gus = seed.claim(w.alpha, w.i_rita, w.p_gus)
    w.c_rita_mia = seed.claim(w.alpha, w.i_rita, w.p_mia, assignment=w.a_rita)
    w.c_gus_mia = seed.claim(w.alpha, w.i_gus, w.p_mia)
    w.c_admin_gus = seed.claim(w.alpha, w.i_admin, w.p_gus)
    w.c_beta = seed.claim(w.beta, w.i_beta, w.p_bea)
    w.pl_rita = seed.pledge(w.alpha, w.i_rita, w.p_mia)
    w.pl_gus = seed.pledge(w.alpha, w.i_gus, w.p_mia)

    w.au_rita = seed.audit(w.alpha, "claim", actor=w.u_gus, recipient_person=w.p_rita)
    w.au_admin = seed.audit(w.alpha, "claim", actor=w.u_gus, recipient_person=w.p_admin)
    w.au_gus = seed.audit(w.alpha, "claim", actor=w.u_mia, recipient_person=w.p_gus)
    w.au_invite = seed.audit(w.alpha, "invite", actor=w.u_admin)
    w.au_beta = seed.audit(w.beta, "invite", actor=w.u_bea)

    w.g_guest = seed.guest_link(w.alpha, w.p_guest, w.u_admin, [w.l_rita, w.l_gus])
    w.g_recipient = seed.guest_link(w.alpha, w.p_rita, w.u_admin, [w.l_rita, w.l_gus])
    w.g_revoked = seed.guest_link(w.alpha, w.p_guest, w.u_admin, [w.l_gus], revoked=True)
    w.g_expired = seed.guest_link(w.alpha, w.p_guest, w.u_admin, [w.l_gus], expires_in=timedelta(days=-1))
    w.al_mia = seed.assignment_link(w.alpha, w.p_mia, w.u_admin)
    return w
