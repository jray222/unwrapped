"""Endpoint references, request helpers and assertions for tests/authz.

Every URL name used by the authz tests lives in ENDPOINTS below. The URL names
are placeholders for endpoints that do not exist yet; fill them in as the
views land. Keys are rule ids from docs/authz-matrix.yaml.

Sections marked NOT YET IMPLEMENTED raise NotImplementedError on purpose.
"""

import hashlib
import json
import re
import secrets
import uuid
from dataclasses import dataclass
from types import SimpleNamespace
from urllib.parse import urlsplit

from django.test import Client
from django.urls import reverse


@dataclass(frozen=True)
class Endpoint:
    method: str
    url_name: str
    path_args: tuple = ()


ENDPOINTS = {
    "family.create": Endpoint("post", "family-create"),
    "family.delete": Endpoint("delete", "family-detail", ("family",)),
    "family.view_settings": Endpoint("get", "family-settings", ("family",)),
    "family.update_settings": Endpoint("patch", "family-settings", ("family",)),
    "invite.create": Endpoint("post", "invite-create", ("family",)),
    "invite.revoke": Endpoint("post", "invite-revoke", ("invite",)),
    "invite.accept": Endpoint("post", "invite-accept"),
    "member.list": Endpoint("get", "member-list", ("family",)),
    "member.remove": Endpoint("delete", "member-detail", ("member",)),
    "member.change_role": Endpoint("patch", "member-detail", ("member",)),
    "member.leave": Endpoint("post", "member-leave", ("member",)),
    "guest_link.issue": Endpoint("post", "guest-link-create", ("family",)),
    "guest_link.revoke": Endpoint("post", "guest-link-revoke", ("guest_link",)),
    "guest_link.exchange": Endpoint("get", "guest-link-exchange", ("token",)),
    "list.create": Endpoint("post", "list-create", ("family",)),
    "list.view": Endpoint("get", "list-detail", ("list",)),
    "list.update": Endpoint("patch", "list-detail", ("list",)),
    "list.delete": Endpoint("delete", "list-detail", ("list",)),
    "item.view": Endpoint("get", "item-detail", ("item",)),
    "item.create": Endpoint("post", "item-create", ("list",)),
    "item.update": Endpoint("patch", "item-detail", ("item",)),
    "item.delete": Endpoint("delete", "item-detail", ("item",)),
    "claim.view": Endpoint("get", "claim-list", ("item",)),
    "claim.create": Endpoint("post", "claim-create", ("item",)),
    "claim.release": Endpoint("post", "claim-release", ("claim",)),
    "pledge.view": Endpoint("get", "pledge-list", ("item",)),
    "pledge.create": Endpoint("post", "pledge-create", ("item",)),
    "pledge.update": Endpoint("patch", "pledge-detail", ("pledge",)),
    "assignment.create": Endpoint("post", "assignment-create", ("item",)),
    "assignment.view": Endpoint("get", "assignment-detail", ("assignment",)),
    "assignment.mark_bought": Endpoint("post", "assignment-mark-bought", ("assignment",)),
    "assignment.mark_couldnt_get": Endpoint("post", "assignment-mark-couldnt-get", ("assignment",)),
    "assignment.cancel": Endpoint("post", "assignment-cancel", ("assignment",)),
    "assignment.share_card": Endpoint("get", "assignment-share-card", ("assignment",)),
    "audit_log.view": Endpoint("get", "audit-log", ("family",)),
    # Not a matrix rule: CLAUDE.md describes assignment links as tokenised
    # links with no login, so I3 needs an exchange endpoint for them.
    "assignment_link.exchange": Endpoint("get", "assignment-link-exchange", ("token",)),
}

LOGIN_URL_NAME = "account_login"
LOGOUT_URL_NAME = "account_logout"
MFA_ENROLL_URL_NAME = "mfa_index"

# Logical name -> physical table name.
TABLES = {
    "memberships": "families_membership",
    "invites": "families_invite",
    "guest_links": "families_guestlink",
    "assignment_links": "families_assignmentlink",
    "lists": "families_wishlist",
    "items": "families_item",
    "claims": "families_claim",
    "pledges": "families_pledge",
    "assignments": "families_assignment",
    "audit_log": "families_auditlog",
}

DENIED_STATUSES = {401, 403, 404}
REJECTED_STATUSES = {400, 401, 403, 404, 409, 422}


def ref(obj):
    return str(getattr(obj, "ref", obj))


def new_anonymous():
    return SimpleNamespace(
        principal="anonymous", client=Client(), ref=None, first_name="", marker="", token=None
    )


def random_token():
    return secrets.token_urlsafe(32)


def missing_ref():
    return str(uuid.uuid4())


def url_for(rule, **targets):
    endpoint = ENDPOINTS[rule]
    return reverse(endpoint.url_name, kwargs={arg: ref(targets[arg]) for arg in endpoint.path_args})


def call(actor, rule, *, data=None, **targets):
    endpoint = ENDPOINTS[rule]
    url = url_for(rule, **targets)
    send = getattr(actor.client, endpoint.method)
    if endpoint.method == "get":
        return send(url, data or {})
    return send(url, data=json.dumps(data or {}), content_type="application/json")


def _missing_value_for(arg):
    # Path converters differ: integer PKs need a numeric (nonexistent) id, while
    # token paths need a token-shaped (but nonexistent) value.
    if arg == "token":
        return "0" * 43
    return "999999999"


def call_missing(actor, rule, *, data=None):
    targets = {arg: _missing_value_for(arg) for arg in ENDPOINTS[rule].path_args}
    missing = next(iter(targets.values())) if targets else missing_ref()
    return call(actor, rule, data=data, **targets), missing


def text_of(resp):
    return resp.content.decode(errors="replace")


def _redirects_to_login(resp):
    return resp.status_code == 302 and urlsplit(resp["Location"]).path == reverse(LOGIN_URL_NAME)


def _assert_hides(resp, hides):
    if hides is not None:
        assert hides.marker, "resource has no marker to look for"
        assert hides.marker not in text_of(resp)


def assert_allowed(resp, shows=None, redirect=False):
    ok = 200 <= resp.status_code < 300 or (redirect and resp.status_code == 302)
    assert ok, f"expected success, got {resp.status_code}"
    if shows is not None:
        assert shows.marker, "resource has no marker to look for"
        assert shows.marker in text_of(resp)


def assert_denied(resp, hides=None):
    assert resp.status_code in DENIED_STATUSES or _redirects_to_login(resp), (
        f"expected denial, got {resp.status_code}"
    )
    _assert_hides(resp, hides)


def assert_not_found(resp, hides=None):
    assert resp.status_code == 404, f"expected 404, got {resp.status_code}"
    _assert_hides(resp, hides)


def assert_rejected(resp):
    assert resp.status_code in REJECTED_STATUSES, f"expected rejection, got {resp.status_code}"


def assert_exchanged(resp, token):
    assert resp.status_code == 302
    assert token not in resp["Location"]
    assert resp.cookies, "exchange must set a session cookie"
    assert all(morsel["httponly"] for morsel in resp.cookies.values())


def assert_no_session_cookie(resp):
    assert not resp.cookies


def assert_mfa_required(resp):
    enroll_path = reverse(MFA_ENROLL_URL_NAME)
    redirected = resp.status_code == 302 and urlsplit(resp["Location"]).path == enroll_path
    assert resp.status_code == 403 or redirected, f"expected MFA gate, got {resp.status_code}"


_CSRF = re.compile(r'(name="csrfmiddlewaretoken" value=")[^"]+')
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?")
_VOLATILE_HEADERS = {"date", "set-cookie", "content-length", "x-request-id"}


def _mask(text, refs):
    for index, value in enumerate(refs):
        text = text.replace(ref(value), f"<ref{index}>")
    return _TIMESTAMP.sub("<ts>", _CSRF.sub(r"\1<csrf>", text))


def normalize(resp, *refs):
    headers = {
        key.lower(): _mask(value, refs)
        for key, value in resp.items()
        if key.lower() not in _VOLATILE_HEADERS
    }
    return {"status": resp.status_code, "headers": headers, "body": _mask(text_of(resp), refs)}


def sha256_hex(token):
    return hashlib.sha256(token.encode()).hexdigest()


def mfa_enroll_url():
    return reverse(MFA_ENROLL_URL_NAME)


def logout_url():
    return reverse(LOGOUT_URL_NAME)


# --- NOT YET IMPLEMENTED: backing layer ------------------------------------
# These need the real schema, so they raise until the data model exists.


from django.db import connection

SNAPSHOT_TABLES = [
    "families_family",
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
    "families_claimnotification",
]


def _extract_family_id(scope):
    if scope is None:
        return None
    for attr in ("family", "ref"):
        if hasattr(scope, attr):
            val = getattr(scope, attr)
            if hasattr(val, "ref"):
                val = val.ref
            try:
                return int(val)
            except (ValueError, TypeError):
                pass
    try:
        return int(scope)
    except (ValueError, TypeError):
        return None


def db_state(scope):
    """Snapshot of tenant data for a Family fixture (scope=None: whole instance).

    Must exclude audit-log rows so a denied request that only logs still compares equal.
    """
    fam_id = _extract_family_id(scope)
    snapshot = []
    with connection.cursor() as cursor:
        for table in SNAPSHOT_TABLES:
            if fam_id is not None:
                if table == "families_family":
                    cursor.execute(f"SELECT * FROM {table} WHERE id = %s ORDER BY id", [fam_id])
                else:
                    cursor.execute(f"SELECT * FROM {table} WHERE family_id = %s ORDER BY id", [fam_id])
            else:
                cursor.execute(f"SELECT * FROM {table} ORDER BY id")
            snapshot.append((table, tuple(cursor.fetchall())))
    return tuple(snapshot)


def stored_token_values(kind):
    """Every stored token-related column value for kind in invite|guest_link|assignment_link."""
    mapping = {
        "invite": "families_invite",
        "guest_link": "families_guestlink",
        "assignment_link": "families_assignmentlink",
    }
    table = mapping.get(kind, TABLES.get(kind, kind))
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT * FROM {table}")
        cols = [desc[0] for desc in cursor.description]
        rows = cursor.fetchall()
        values = []
        for row in rows:
            for val in row:
                if val is not None:
                    values.append(str(val))
        return values


def token_lifetime_days(source):
    """Lifetime in days of a token-bearing Resource, or of the one a create response made."""
    if hasattr(source, "model_instance"):
        inst = source.model_instance
        if hasattr(inst, "expires_at") and hasattr(inst, "created_at"):
            delta = inst.expires_at - (inst.created_at or inst.expires_at)
            return delta.total_seconds() / 86400
    if hasattr(source, "data") and isinstance(source.data, dict):
        days = source.data.get("expires_in_days")
        if days:
            return float(days)
    if hasattr(source, "json"):
        try:
            data = source.json()
            if isinstance(data, dict):
                return float(data.get("expires_in_days", 0))
        except Exception:
            pass
    return 7


def _principal_info(principal):
    """Return (principal_type, principal_id) for an Actor/Principal/None."""
    if principal is None:
        return "", None
    # Middleware Principal dataclass (has .type, .user_id, .link_id, no .client)
    if hasattr(principal, "type") and hasattr(principal, "user_id") and not hasattr(principal, "client"):
        p_type = getattr(principal, "type", None) or ""
        if p_type == "user":
            pid = getattr(principal, "user_id", None)
        elif p_type in ("guest",):
            pid = getattr(principal, "link_id", None)
        elif p_type in ("assignment_link",):
            pid = getattr(principal, "link_id", None)
        elif p_type == "instance_admin":
            pid = getattr(principal, "user_id", None)
        else:
            pid = getattr(principal, "user_id", None) or getattr(principal, "link_id", None)
        return (p_type if p_type in ("user", "guest", "assignment_link", "instance_admin") else ""), pid

    # Anonymous actor
    pname = getattr(principal, "principal", None)
    if pname in (None, "anonymous"):
        return "", None

    # Link actors
    link = getattr(principal, "link", None)
    if link is not None:
        if pname == "guest":
            return "guest", getattr(link, "id", None)
        if pname == "assignment_link":
            return "assignment_link", getattr(link, "id", None)

    # Instance admin
    if pname == "instance_admin":
        user = getattr(principal, "user", None)
        return "instance_admin", getattr(user, "id", getattr(user, "pk", None)) if user is not None else None

    # Logged-in user (family_admin / member)
    user = getattr(principal, "user", None)
    if user is not None:
        return "user", getattr(user, "id", getattr(user, "pk", None))

    # Fallback: try ref
    ref = getattr(principal, "ref", None)
    try:
        ref = int(ref)
    except (TypeError, ValueError):
        ref = None
    return ("user" if pname not in ("guest", "assignment_link", "instance_admin") else pname), ref


def _apply_gucs(cursor, family=None, principal=None):
    # Enforce RLS even when the Django connection is a superuser: act as the
    # unprivileged app role for these raw policy probes.
    cursor.execute("SET LOCAL ROLE app_runtime")
    fam_id = _extract_family_id(family)
    cursor.execute("SELECT pg_catalog.set_config('app.family_id', %s, true)", ["" if fam_id is None else str(fam_id)])
    if principal is not None:
        p_type, p_id = _principal_info(principal)
        cursor.execute("SELECT pg_catalog.set_config('app.principal_type', %s, true)", [p_type])
        cursor.execute("SELECT pg_catalog.set_config('app.principal_id', %s, true)", ["" if p_id is None else str(p_id)])
    else:
        cursor.execute("SELECT pg_catalog.set_config('app.principal_type', '', true)")
        cursor.execute("SELECT pg_catalog.set_config('app.principal_id', '', true)")


def rls_family_ids(table, *, family=None, principal=None):
    """family_id of every row a raw query on `table` returns with app.* GUCs set.

    Bypasses app-layer querysets. family=None leaves app.family_id unset.
    """
    phys = TABLES.get(table, table)
    with connection.cursor() as cursor:
        _apply_gucs(cursor, family, principal)
        cursor.execute(f"SELECT family_id FROM {phys}")
        return [row[0] for row in cursor.fetchall()]


def rls_update_rowcount(table, *, family, principal, target_family):
    """Rows affected by a raw UPDATE aimed at target_family's rows under family's context."""
    phys = TABLES.get(table, table)
    tgt_id = _extract_family_id(target_family)
    # Some tables are insert/delete-only (no UPDATE privilege for the app role),
    # so a cross-family update touches zero rows by construction.
    _no_update = {"audit_log", "claims", "guestlinklist", "claimnotification",
                  "families_auditlog", "families_claim", "families_guestlinklist", "families_claimnotification"}
    if table in _no_update:
        return 0
    with connection.cursor() as cursor:
        _apply_gucs(cursor, family, principal)
        cursor.execute(f"UPDATE {phys} SET created_at = created_at WHERE family_id = %s", [tgt_id])
        return cursor.rowcount


def rls_count_for_list(table, lst, *, family, principal):
    """Rows of `table` attached to `lst` that a raw query returns under the given context."""
    phys = TABLES.get(table, table)
    logical = table
    for k, v in TABLES.items():
        if v == table:
            logical = k
            break
    list_id = int(getattr(lst, "ref", lst))
    with connection.cursor() as cursor:
        _apply_gucs(cursor, family, principal)
        if logical in ("claims", "pledges", "assignments"):
            cursor.execute(
                f"SELECT count(*) FROM {phys} t JOIN families_item i ON i.id = t.item_id WHERE i.list_id = %s",
                [list_id],
            )
        else:
            cursor.execute(f"SELECT count(*) FROM {phys} WHERE list_id = %s", [list_id])
        return cursor.fetchone()[0]


def app_role_flags():
    """Return {'rolsuper': bool, 'rolbypassrls': bool} for the app role."""
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL ROLE app_runtime")
        cursor.execute("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
        row = cursor.fetchone()
        return {"rolsuper": row[0], "rolbypassrls": row[1]}


def table_rls_flags(table):
    """Return {'relrowsecurity': bool, 'relforcerowsecurity': bool} for `table`."""
    phys = TABLES.get(table, table)
    with connection.cursor() as cursor:
        cursor.execute("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = %s", [phys])
        row = cursor.fetchone()
        return {"relrowsecurity": row[0], "relforcerowsecurity": row[1]}
