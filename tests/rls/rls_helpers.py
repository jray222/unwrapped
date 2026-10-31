from contextlib import contextmanager

from django.db import DatabaseError

from apps.authz.db import rls_context


def as_user(user_id, family_id):
    return rls_context(family_id=family_id, principal_type="user", principal_id=user_id)


def as_guest(link_id, family_id):
    return rls_context(family_id=family_id, principal_type="guest", principal_id=link_id)


def as_assignment_link(link_id, family_id):
    return rls_context(family_id=family_id, principal_type="assignment_link", principal_id=link_id)


def anonymous():
    return rls_context()


def pks(queryset):
    return set(queryset.values_list("pk", flat=True))


def sqlstate(exc):
    return getattr(exc.__cause__, "sqlstate", None)


@contextmanager
def db_error(state, match=None):
    """Expect a DatabaseError with this SQLSTATE (and optional message fragment)."""
    try:
        yield
    except DatabaseError as exc:
        assert sqlstate(exc) == state, f"expected SQLSTATE {state}, got {sqlstate(exc)}: {exc}"
        if match:
            assert match in str(exc), str(exc)
    else:
        raise AssertionError(f"expected a DatabaseError with SQLSTATE {state}")
