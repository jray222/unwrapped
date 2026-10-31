import pytest
from django.contrib.auth import get_user_model
from datetime import timedelta

from django.utils import timezone

from apps.families import tokens
from apps.families.models import (
    AssignmentLink,
    Family,
    GuestLink,
    Membership,
    Person,
)

LINK_LIFETIME_DAYS = 30


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        "rita", email="rita@example.com", password="s3cretypa55w0rd!"
    )


@pytest.fixture
def family(db, user):
    fam = Family.objects.create(name="Alpha")
    Membership.objects.create(family=fam, user=user, role=Membership.Role.FAMILY_ADMIN)
    return fam


@pytest.fixture
def person(family):
    return Person.objects.create(family=family, first_name="Aunt May")


@pytest.fixture
def make_guest_link(family, user, person):
    def _make(*, family=family, person=person, expired=False, revoked=False):
        raw = tokens.new_token()
        expires_at = (
            timezone.now() - timedelta(days=1)
            if expired
            else timezone.now() + timedelta(days=LINK_LIFETIME_DAYS)
        )
        return (
            GuestLink.objects.create(
                family=family,
                person=person,
                issued_by=user,
                token_hash=tokens.hash_token(raw),
                expires_at=expires_at,
                revoked_at=timezone.now() if revoked else None,
            ),
            raw,
        )

    return _make


@pytest.fixture
def make_assignment_link(family, user, person):
    def _make(*, family=family, person=person, expired=False, revoked=False):
        raw = tokens.new_token()
        expires_at = (
            timezone.now() - timedelta(days=1)
            if expired
            else timezone.now() + timedelta(days=LINK_LIFETIME_DAYS)
        )
        return (
            AssignmentLink.objects.create(
                family=family,
                person=person,
                issued_by=user,
                token_hash=tokens.hash_token(raw),
                expires_at=expires_at,
                revoked_at=timezone.now() if revoked else None,
            ),
            raw,
        )

    return _make
