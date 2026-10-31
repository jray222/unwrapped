"""Token handling for guest, assignment and invite links (CLAUDE.md rule 6).

Raw tokens exist exactly twice: as an argument to hash_token() the moment the
link is created, and in the URL the family member shares. They are never
stored or logged; the DB keeps only the SHA-256 hex digest (TokenModel), which
this module turns back into a principal identity through the rls definer
functions from apps/families/migrations/0004_token_exchange.py. Looking a
digest up by its unique index is the comparison: the digest is not attacker
controlled data, so there is nothing for a constant-time compare to protect.
"""

import hashlib
import secrets

from django.db import connection

# secrets.token_urlsafe(32) is exactly 43 URL-safe characters.
TOKEN_CHARS = 43

GUEST = "guest"
ASSIGNMENT_LINK = "assignment_link"
LINK_KINDS = frozenset({GUEST, ASSIGNMENT_LINK})

_EXCHANGE = "SELECT family_id, link_id FROM rls.exchange_link_token(%s, %s)"
_IS_ACTIVE = "SELECT rls.link_is_active(%s, %s)"


def new_token():
    """A fresh raw bearer token, URL-safe but still opaque to the client."""
    return secrets.token_urlsafe(32)


def hash_token(raw_token):
    """SHA-256 hex digest, the only representation that touches a database."""
    if not isinstance(raw_token, str) or len(raw_token) != TOKEN_CHARS:
        # Anything else can never match: no DB roundtrip for malformed input,
        # and the digest-shaped garbage never reaches Postgres at all.
        raise ValueError("token shape is not what links are issued with")
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def exchange_link_token(kind, raw_token):
    """Identity of the active link with this raw token: (family_id, link_id),
    or None. Mismatch, revocation and expiry all yield None on purpose.
    """
    if kind not in LINK_KINDS:
        raise ValueError("invalid link kind")
    try:
        digest = hash_token(raw_token)
    except ValueError:
        return None
    with connection.cursor() as cursor:
        cursor.execute(_EXCHANGE, [kind, digest])
        return cursor.fetchone()


def link_is_active(kind, link_id):
    """Whether the link identity (e.g. one restored from a session) is still an
    active credential of that kind. Revocation and expiry are DB state.
    """
    if kind not in LINK_KINDS or not (type(link_id) is int and link_id > 0):
        return False
    with connection.cursor() as cursor:
        cursor.execute(_IS_ACTIVE, [kind, link_id])
        return bool(cursor.fetchone()[0])
