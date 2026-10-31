"""The only place the RLS session settings (app.family_id, app.principal_type,
app.principal_id) are written.

Settings are transaction-local by construction: set_config(..., is_local => true) is the
bind-parameter-friendly equivalent of SET LOCAL, and its value reverts on COMMIT or
ROLLBACK. Outside a transaction it would last for a single statement, so a missing
atomic block fails closed (and apply_rls_settings refuses to run anyway). Never use
session-level SET or set_config(..., false): with persistent or pooled connections the
value would leak into the next request.
"""

import json
import logging
from contextlib import contextmanager

from django.core.exceptions import ImproperlyConfigured
from django.db import connection, transaction

logger = logging.getLogger(__name__)

_SET = (
    "SELECT pg_catalog.set_config('app.family_id', %s, true),"
    "       pg_catalog.set_config('app.principal_type', %s, true),"
    "       pg_catalog.set_config('app.principal_id', %s, true)"
)
_PROBE = (
    "SELECT pg_catalog.current_setting('app.family_id', true),"
    "       pg_catalog.current_setting('app.principal_type', true),"
    "       pg_catalog.current_setting('app.principal_id', true)"
)
PRINCIPAL_TYPES = frozenset({"user", "guest", "assignment_link", "instance_admin"})


def _valid_id(value):
    # type() is int rejects bool, str and Decimal; ids are positive database keys.
    return value is None or (type(value) is int and value > 0)


def _write(values):
    with connection.cursor() as cursor:
        cursor.execute(_SET, ["" if v is None else str(v) for v in values])


def apply_rls_settings(family_id, principal_type, principal_id):
    """Set the RLS context for the current transaction. All three None = anonymous."""
    if not connection.in_atomic_block:
        raise RuntimeError("RLS settings require an open transaction")
    if principal_type is not None and principal_type not in PRINCIPAL_TYPES:
        raise ValueError("invalid RLS context")
    if not _valid_id(family_id) or not _valid_id(principal_id):
        raise ValueError("invalid RLS context")
    if principal_type is None and (family_id is not None or principal_id is not None):
        raise ValueError("invalid RLS context")
    _write((family_id, principal_type, principal_id))


def read_rls_settings():
    """Raw (family_id, principal_type, principal_id) strings; None or '' mean unset."""
    with connection.cursor() as cursor:
        cursor.execute(_PROBE)
        return cursor.fetchone()


def assert_rls_clean():
    """Fail loudly if settings survived from an earlier transaction on this connection."""
    if any(value not in (None, "") for value in read_rls_settings()):
        logger.critical("rls_context_leak")  # never log the values
        raise ImproperlyConfigured("RLS context leaked across transactions")


@contextmanager
def rls_context(*, family_id=None, principal_type=None, principal_id=None):
    """Run a block as the given principal, inside a transaction.

    Outermost use opens the transaction and first asserts no stale settings exist.
    Nested use (a savepoint) restores the previous settings on normal exit, because
    releasing a savepoint keeps its GUC changes; a rollback reverts them by itself.
    """
    outermost = not connection.in_atomic_block
    with transaction.atomic():
        previous = None
        if outermost:
            assert_rls_clean()
        else:
            previous = read_rls_settings()
        apply_rls_settings(family_id, principal_type, principal_id)
        yield
        if previous is not None and not transaction.get_rollback():
            _write(previous)


def audit_append(action, *, target_type="", target_id=None, recipient_person_id=None, metadata=None):
    """Append an audit row through rls.audit_append. The app role has SELECT only on the
    audit table; actor, principal and family come from the RLS settings, not from callers.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT rls.audit_append(%s, %s, %s, %s, %s::jsonb)",
            [action, target_type, target_id, recipient_person_id, json.dumps(metadata or {})],
        )
