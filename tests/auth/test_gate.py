"""Accounts, login and the I4 gate (local account without MFA)."""

import pytest
from django.urls import reverse

from allauth.mfa.totp.internal.auth import TOTP, generate_totp_secret

pytestmark = pytest.mark.django_db

def login(client, email, password):
    return client.post(reverse("account_login"), {"login": email, "password": password})


def test_login_happy_path_creates_session(client, member):
    resp = client.post(reverse("account_login"), {"login": member.email, "password": "s3cretypa55w0rd!"})
    assert resp.status_code in (200, 302)
    assert client.session.get("_auth_user_id") == str(member.pk)


def test_login_wrong_password_rejected(client, member):
    resp = login(client, member.email, "wrong-password")
    assert resp.status_code == 200 or resp.get("Location")
    assert client.session.get("_auth_user_id") != str(member.pk)


def test_login_unknown_email_no_information(client):
    resp = login(client, "ghost@example.com", "irrelevant")
    assert client.session.get("_auth_user_id") is None


def test_password_is_stored_argon2id(member):
    assert member.password.startswith("argon2")


def test_error_messages_never_echo_the_form_back(client, member):
    # sanity: any rendered page error text must not include raw password
    resp = login(client, member.email, "wrong-password")
    assert "wrong-password" not in resp.content.decode()


# --- invariant I4: local + no MFA => only MFA enrollment and logout -----------------


def test_gate_redirects_unenrolled_home(client, member):
    client.force_login(member)
    resp = client.get(reverse("home"))
    assert resp.status_code == 302
    assert resp["Location"].startswith(reverse("mfa_index"))
    # Even a gate-generated response carries the security headers (the CSP
    # middleware is an inner self wrapper today, but nothing guarantees it
    # stays an __call__ wrapper).
    assert resp["Content-Security-Policy"]
    assert resp["Referrer-Policy"] == "no-referrer"


def test_gate_allows_healthz(client, member):
    client.force_login(member)
    assert client.get(reverse("healthz")).status_code == 200


def test_gate_allows_mfa_urls(client, member):
    client.force_login(member)
    assert client.get(reverse("mfa_index")).status_code in (200, 302)


def test_gate_blocks_password_change_but_allows_logout(client, member):
    client.force_login(member)
    # account_change_password belongs to allauth urls and must be gated
    assert client.get(reverse("account_change_password")).status_code == 302

    client.post(reverse("account_logout"))
    assert client.session.get("_auth_user_id") is None


def test_gate_does_not_apply_to_google_style_accounts(client, oauth_member):
    client.force_login(oauth_member)
    assert client.get(reverse("home")).status_code == 200


def test_totp_activation_puts_user_through(client, member):
    TOTP.activate(member, generate_totp_secret())
    client.force_login(member)
    assert client.get(reverse("home")).status_code == 200


def test_enrollment_page_requires_authentication(client):
    resp = client.get(reverse("mfa_index"))
    assert resp.status_code == 302
    assert resp["Location"].startswith(reverse("account_login"))


def test_signup_is_invite_only(client, db):
    from django.contrib.auth import get_user_model

    User = get_user_model()
    before = User.objects.count()
    client.post(
        reverse("account_signup"),
        {"email": "new@example.com", "password1": "unusual-signal-42", "password2": "unusual-signal-42"},
    )
    assert User.objects.count() == before
    assert client.session.get("_auth_user_id") is None
