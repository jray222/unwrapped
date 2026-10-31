"""Token exchange (rule 7) and the link principals it establishes."""

import logging
from datetime import timedelta

import pytest
from django.urls import reverse
from django.utils import timezone

from allauth.mfa.totp.internal.auth import TOTP, generate_totp_secret

from apps.authz.link_session import LINK_SESSION_KEY
from apps.families import tokens
from apps.families.models import GuestLink

pytestmark = pytest.mark.django_db

ACTIVE_MARKER = "access link is active"
INACTIVE_MARKER = "access link is not active"


def exchange_url(kind, raw):
    name = "guest-link-exchange" if kind == tokens.GUEST else "assignment-link-exchange"
    return reverse(name, args=[raw])


def test_guest_exchange_happy_path(client, make_guest_link):
    link, raw = make_guest_link()
    resp = client.get(exchange_url(tokens.GUEST, raw))
    assert resp.status_code == 302
    # The redirect carries no token; the session cookie is set.
    assert resp["Location"] == reverse("welcome")
    assert raw not in resp["Location"]
    data = client.session[LINK_SESSION_KEY]
    assert data == {"kind": tokens.GUEST, "family_id": link.family_id, "link_id": link.pk}
    cookies = resp.cookies
    assert cookies
    assert all(morsel["httponly"] for morsel in cookies.values())
    assert raw not in "".join(morsel.value for morsel in cookies.values())


def test_guest_exchange_landing_page(client, make_guest_link):
    _, raw = make_guest_link()
    resp = client.get(exchange_url(tokens.GUEST, raw), follow=True)
    assert resp.status_code == 200
    assert ACTIVE_MARKER in resp.content.decode()
    assert raw not in resp.content.decode()


def test_assignment_exchange_happy_path(client, make_assignment_link):
    link, raw = make_assignment_link()
    resp = client.get(exchange_url(tokens.ASSIGNMENT_LINK, raw))
    assert resp.status_code == 302
    assert resp["Location"] == reverse("welcome")
    assert client.session[LINK_SESSION_KEY] == {
        "kind": tokens.ASSIGNMENT_LINK,
        "family_id": link.family_id,
        "link_id": link.pk,
    }


def test_invalid_token_rejected_no_state(client, caplog):
    caplog.set_level(logging.DEBUG)
    raw = tokens.new_token()
    resp = client.get(exchange_url(tokens.GUEST, raw))
    assert resp.status_code == 404
    assert not resp.cookies
    assert raw not in resp.content.decode()
    # Token hygiene: no request logs carry the token (the 404 must come from
    # our own response, not a raised Http404, whose logger prints the URL).
    assert raw not in caplog.text


def test_malformed_token_never_reaches_the_database(client):
    resp = client.get("/links/guest/short")
    assert resp.status_code == 404
    assert not resp.cookies


def test_revoked_guest_link_rejected(client, make_guest_link):
    link, raw = make_guest_link()
    assert client.get(exchange_url(tokens.GUEST, raw)).status_code == 302
    GuestLink.objects.filter(pk=link.pk).update(revoked_at=timezone.now())
    # A revoked token no longer exchanges, and the already-exchanged session is
    # demoted: revocation is DB state, not just a response-time decision.
    client.cookies.clear()
    rejected = client.get(exchange_url(tokens.GUEST, raw))
    assert rejected.status_code == 404
    assert not rejected.cookies
    landing = client.get(reverse("welcome"))
    assert INACTIVE_MARKER in landing.content.decode()
    assert LINK_SESSION_KEY not in client.session


def test_expired_guest_link_rejected(client, make_guest_link):
    link, raw = make_guest_link(expired=True)
    assert not link.is_active()
    resp = client.get(exchange_url(tokens.GUEST, raw))
    assert resp.status_code == 404
    assert not resp.cookies


def test_revoked_assignment_link_rejected(client, make_assignment_link):
    from apps.families.models import AssignmentLink

    link, raw = make_assignment_link()
    client.get(exchange_url(tokens.ASSIGNMENT_LINK, raw))
    AssignmentLink.objects.filter(pk=link.pk).update(revoked_at=timezone.now())
    assert client.get(reverse("welcome")).status_code == 200
    landing = client.get(reverse("welcome"))
    assert INACTIVE_MARKER in landing.content.decode()


def test_authenticated_user_is_denied_and_gets_no_session(client, user, make_guest_link):
    _, raw = make_guest_link()
    TOTP.activate(user, generate_totp_secret())  # get past the MFA gate
    client.force_login(user)
    resp = client.get(exchange_url(tokens.GUEST, raw))
    assert resp.status_code == 403
    assert not resp.cookies
    assert LINK_SESSION_KEY not in client.session


def test_exchange_never_logs_the_token(client, make_guest_link, caplog):
    caplog.set_level(logging.DEBUG)
    _, raw = make_guest_link()
    resp = client.get(exchange_url(tokens.GUEST, raw))
    assert resp.status_code == 302
    client.get(resp["Location"])
    assert raw not in caplog.text


def test_invalid_exchange_never_logs_the_token(client, caplog):
    caplog.set_level(logging.DEBUG)
    raw = tokens.new_token()
    client.get(exchange_url(tokens.ASSIGNMENT_LINK, raw))
    assert raw not in caplog.text


def test_token_stored_only_as_hash(family, person, user):
    raw = tokens.new_token()
    link = GuestLink.objects.create(
        family=family,
        person=person,
        issued_by=user,
        token_hash=tokens.hash_token(raw),
        expires_at=timezone.now() + timedelta(days=30),
    )
    stored = [str(getattr(link, field)) for field in ("token_hash", "family_id", "issued_by_id", "person_id")]
    # rule 6: the only credential-recorded form is the SHA-256 digest.
    assert raw not in "".join(stored)
    assert tokens.hash_token(raw) in stored
