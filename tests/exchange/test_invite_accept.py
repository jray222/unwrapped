"""Tests for the invite accept endpoint."""

import logging
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone

from allauth.mfa.totp.internal.auth import TOTP, generate_totp_secret

from apps.families import tokens
from apps.families.models import Invite, Membership, Person

pytestmark = pytest.mark.django_db


@pytest.fixture
def make_invite(family, user):
    def _make(email="invited@example.com", expired=False, revoked=False, person=None):
        raw = tokens.new_token()
        expires_at = (
            timezone.now() - timedelta(days=1)
            if expired
            else timezone.now() + timedelta(days=7)
        )
        invite = Invite.objects.create(
            family=family,
            created_by=user,
            email=email,
            token_hash=tokens.hash_token(raw),
            expires_at=expires_at,
            revoked_at=timezone.now() if revoked else None,
            person=person,
        )
        return invite, raw

    return _make


def test_invite_accept_happy_path(client, family, make_invite):
    invite, raw = make_invite("new.member@example.com")
    resp = client.post(
        reverse("invite-accept"),
        data={"token": raw, "email": "new.member@example.com"},
        content_type="application/json",
    )
    assert resp.status_code == 302
    assert raw not in resp["Location"]

    invite.refresh_from_db()
    assert invite.used_at is not None

    User = get_user_model()
    user = User.objects.get(email="new.member@example.com")
    assert Membership.objects.filter(family=family, user=user).exists()
    assert Person.objects.filter(family=family, user=user).exists()


def test_invite_accept_binds_existing_person(client, family, make_invite):
    person = Person.objects.create(family=family, first_name="InvitedPerson")
    invite, raw = make_invite("person.bound@example.com", person=person)

    resp = client.post(
        reverse("invite-accept"),
        data={"token": raw, "email": "person.bound@example.com"},
        content_type="application/json",
    )
    assert resp.status_code == 302

    person.refresh_from_db()
    assert person.user is not None
    assert person.user.email == "person.bound@example.com"


def test_invite_accept_reused_rejected(client, make_invite):
    invite, raw = make_invite("reused@example.com")
    client.post(
        reverse("invite-accept"),
        data={"token": raw, "email": "reused@example.com"},
        content_type="application/json",
    )
    # Second attempt must fail
    resp = client.post(
        reverse("invite-accept"),
        data={"token": raw, "email": "reused@example.com"},
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_invite_accept_expired_rejected(client, make_invite):
    _, raw = make_invite("expired@example.com", expired=True)
    resp = client.post(
        reverse("invite-accept"),
        data={"token": raw, "email": "expired@example.com"},
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_invite_accept_revoked_rejected(client, make_invite):
    _, raw = make_invite("revoked@example.com", revoked=True)
    resp = client.post(
        reverse("invite-accept"),
        data={"token": raw, "email": "revoked@example.com"},
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_invite_accept_email_mismatch_rejected(client, make_invite):
    _, raw = make_invite("correct@example.com")
    resp = client.post(
        reverse("invite-accept"),
        data={"token": raw, "email": "wrong@example.com"},
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_invite_accept_authenticated_user_denied(client, user, make_invite):
    _, raw = make_invite("someone@example.com")
    TOTP.activate(user, generate_totp_secret())
    client.force_login(user)
    resp = client.post(
        reverse("invite-accept"),
        data={"token": raw, "email": "someone@example.com"},
        content_type="application/json",
    )
    assert resp.status_code == 403


def test_invite_accept_token_not_logged(client, make_invite, caplog):
    caplog.set_level(logging.DEBUG)
    _, raw = make_invite("logging.test@example.com")
    client.post(
        reverse("invite-accept"),
        data={"token": raw, "email": "logging.test@example.com"},
        content_type="application/json",
    )
    assert raw not in caplog.text


def test_invite_accept_rolls_back_user_creation_on_invalid_token(client):
    raw = tokens.new_token()
    User = get_user_model()
    initial_count = User.objects.count()
    resp = client.post(
        reverse("invite-accept"),
        data={"token": raw, "email": "nobody@example.com"},
        content_type="application/json",
    )
    assert resp.status_code == 400
    assert User.objects.count() == initial_count
