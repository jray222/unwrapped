"""Cross-request guest and assignment-link principals, in the session.

Written ONLY by the token exchange views (apps/families/views.py) after the
raw URL token validated against a definer function, and read ONLY by
resolve_principal (apps/authz/middleware.py). The values are server-side ints,
not credentials: even a stolen or forged session cookie grants nothing by
itself, because link validity (revocation/expiry) is re-checked in the
database on every request, and the RLS policies re-check the link row again
per statement (tenant isolation twice).
"""

LINK_SESSION_KEY = "app.link"

_KINDS = ("guest", "assignment_link")


def save_link_principal(request, kind, family_id, link_id):
    """Promote an anonymous session to a link principal.

    cycle_key rotates the session identifier while keeping the data: a new
    principal gets a fresh session id, so a previously observed session cookie
    (e.g. from a phishing page that pre-populated the token URL) cannot be
    replayed to inherit this exchange.
    """
    request.session.cycle_key()
    request.session[LINK_SESSION_KEY] = {
        "kind": kind,
        "family_id": family_id,
        "link_id": link_id,
    }


def read_link_principal(request):
    """(kind, family_id, link_id) for a session that carries one, else None."""
    data = request.session.get(LINK_SESSION_KEY)
    if data is None:
        return None
    if isinstance(data, dict):
        kind = data.get("kind")
        family_id = data.get("family_id")
        link_id = data.get("link_id")
        if (
            kind in _KINDS
            and type(family_id) is int
            and family_id > 0
            and type(link_id) is int
            and link_id > 0
        ):
            return kind, family_id, link_id
    # Corrupted or self-made entries never grant anything; drop the data so the
    # session does not keep failing shape checks on every request.
    drop_link_principal(request)
    return None


def drop_link_principal(request):
    request.session.pop(LINK_SESSION_KEY, None)
