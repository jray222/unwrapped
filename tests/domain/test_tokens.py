import secrets
from datetime import timedelta

import pytest
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.families.models import AssignmentLink, GuestLink, GuestLinkList, Invite

HASH = "a" * 64
TOKEN_MODELS = [GuestLink, AssignmentLink, Invite]


def _hash(n):
    return f"{n:064x}"


def _guest_link(family, person, user, **kw):
    kw.setdefault("token_hash", HASH)
    kw.setdefault("expires_at", timezone.now() + timedelta(days=30))
    return GuestLink(family=family, person=person, issued_by=user, **kw)


def _assignment_link(family, person, user, **kw):
    kw.setdefault("token_hash", HASH)
    kw.setdefault("expires_at", timezone.now() + timedelta(days=30))
    return AssignmentLink(family=family, person=person, issued_by=user, **kw)


@pytest.mark.parametrize("model", TOKEN_MODELS)
def test_no_raw_token_field_exists(model):
    names = {f.name for f in model._meta.get_fields()}
    assert "token_hash" in names
    assert not {n for n in names if "token" in n} - {"token_hash"}


@pytest.mark.parametrize("model", TOKEN_MODELS)
def test_token_hash_is_unique(model):
    assert model._meta.get_field("token_hash").unique


def test_raw_token_is_rejected_as_token_hash(family, giver, admin_user):
    raw = secrets.token_urlsafe(32)
    link = _guest_link(family, giver, admin_user, token_hash=raw)
    with pytest.raises(ValidationError):
        link.full_clean()
    with pytest.raises(ValidationError):
        link.save()


def test_duplicate_token_hash_rejected(family, giver, admin_user):
    _guest_link(family, giver, admin_user).save()
    with pytest.raises(IntegrityError), transaction.atomic():
        _guest_link(family, giver, admin_user).save()


@pytest.mark.parametrize("builder", [_guest_link, _assignment_link])
def test_link_expiry_max_365_days(family, giver, admin_user, builder):
    ok = builder(family, giver, admin_user, expires_at=timezone.now() + timedelta(days=364))
    ok.full_clean()
    ok.save()
    too_far = builder(
        family, giver, admin_user, token_hash=_hash(2), expires_at=timezone.now() + timedelta(days=366)
    )
    with pytest.raises(ValidationError):
        too_far.full_clean()
    with pytest.raises(ValidationError):
        too_far.save()


def test_invite_defaults_to_seven_days_and_caps_there(family, admin_user):
    invite = Invite(family=family, email="a@example.com", token_hash=HASH, created_by=admin_user)
    invite.full_clean()
    invite.save()
    assert timedelta(days=6, hours=23) < invite.expires_at - timezone.now() <= timedelta(days=7)
    invite.expires_at = timezone.now() + timedelta(days=8)
    with pytest.raises(ValidationError):
        invite.full_clean()


def test_is_active_respects_revocation_expiry_and_use(family, giver, admin_user):
    link = _guest_link(family, giver, admin_user)
    assert link.is_active()
    link.revoked_at = timezone.now()
    assert not link.is_active()
    link.revoked_at = None
    assert not link.is_active(now=link.expires_at + timedelta(seconds=1))

    invite = Invite(family=family, email="a@example.com", token_hash=HASH, created_by=admin_user)
    assert invite.is_active()
    invite.used_at = timezone.now()
    assert not invite.is_active()


def test_guest_link_scope_rows_must_match_family(family, other_family, giver, wish_list, admin_user):
    link = _guest_link(family, giver, admin_user)
    link.save()
    GuestLinkList.objects.create(family=family, guest_link=link, list=wish_list)
    assert list(link.lists.all()) == [wish_list]
    other_link = _guest_link(other_family, giver, admin_user, token_hash=_hash(3))
    with pytest.raises(ValidationError):
        other_link.save()


def test_guest_link_person_must_be_same_family(other_family, giver, admin_user):
    with pytest.raises(ValidationError):
        _guest_link(other_family, giver, admin_user).save()
