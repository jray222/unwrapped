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

# Logical name -> physical table name (placeholders until the schema exists).
TABLES = {
    "memberships": "memberships",
    "invites": "invites",
    "guest_links": "guest_links",
    "assignment_links": "assignment_links",
    "lists": "lists",
    "items": "items",
    "claims": "claims",
    "pledges": "pledges",
    "assignments": "assignments",
    "audit_log": "audit_log",
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


def call_missing(actor, rule, *, data=None):
    missing = missing_ref()
    targets = {arg: missing for arg in ENDPOINTS[rule].path_args}
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


def db_state(scope):
    """Snapshot of tenant data for a Family fixture (scope=None: whole instance).

    Must exclude audit-log rows so a denied request that only logs still compares equal.
    """
    raise NotImplementedError("authz helpers: db_state is not implemented yet")


def stored_token_values(kind):
    """Every stored token-related column value for kind in invite|guest_link|assignment_link."""
    raise NotImplementedError("authz helpers: stored_token_values is not implemented yet")


def token_lifetime_days(source):
    """Lifetime in days of a token-bearing Resource, or of the one a create response made."""
    raise NotImplementedError("authz helpers: token_lifetime_days is not implemented yet")


def rls_family_ids(table, *, family=None, principal=None):
    """family_id of every row a raw query on `table` returns with app.* GUCs set.

    Bypasses app-layer querysets. family=None leaves app.family_id unset.
    """
    raise NotImplementedError("authz helpers: rls_family_ids is not implemented yet")


def rls_update_rowcount(table, *, family, principal, target_family):
    """Rows affected by a raw UPDATE aimed at target_family's rows under family's context."""
    raise NotImplementedError("authz helpers: rls_update_rowcount is not implemented yet")


def rls_count_for_list(table, lst, *, family, principal):
    """Rows of `table` attached to `lst` that a raw query returns under the given context."""
    raise NotImplementedError("authz helpers: rls_count_for_list is not implemented yet")


def app_role_flags():
    """Return {'rolsuper': bool, 'rolbypassrls': bool} for the connected role."""
    raise NotImplementedError("authz helpers: app_role_flags is not implemented yet")


def table_rls_flags(table):
    """Return {'relrowsecurity': bool, 'relforcerowsecurity': bool} for `table`."""
    raise NotImplementedError("authz helpers: table_rls_flags is not implemented yet")
