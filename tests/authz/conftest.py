"""Fixtures for the authz matrix tests.

NOT YET IMPLEMENTED: every fixture below that builds data raises
NotImplementedError until the data model, auth and token flows exist. The
shape here is the contract the generated tests rely on (see
test_generation.fixtures in docs/authz-matrix.yaml).

Per family (alpha, beta) a `Family` holds:
  family_admin, member_recipient, member_giver   logged-in actors
  guest_scoped      guest link scoped to member_recipient's list
  guest_unscoped    guest link scoped to other_list only
  assignee_link     assignment link for one person
  recipient_list    list for member_recipient, created by member_recipient
  other_list        list created by member_giver for member_giver
Each family is seeded with at least one row in every tenant table.
`grandma` is a member of alpha and a guest (scoped to beta.recipient_list) in beta.
"""

from dataclasses import dataclass
from typing import Any

import pytest

from .helpers import new_anonymous


def _todo(name):
    raise NotImplementedError(f"authz fixtures: {name} is not implemented yet")


@dataclass
class Resource:
    """A persisted object. `ref` goes in URLs; `marker` is a string unique to its content."""

    ref: str
    family: Any
    marker: str
    token: str | None = None
    email: str | None = None

    def expire(self):
        _todo("Resource.expire")

    def revoke(self):
        _todo("Resource.revoke")


@dataclass
class Actor:
    """A principal with an HTTP client already authenticated as them."""

    principal: str
    client: Any
    ref: str
    first_name: str
    token: str | None = None

    @property
    def marker(self):
        return self.first_name

    def revoke(self):
        """Link principals only: revoke the link behind this session."""
        _todo("Actor.revoke")

    def expire(self):
        """Link principals only: move past the link's expiry."""
        _todo("Actor.expire")

    def without_mfa(self):
        """Same user, signed in through a local account with no MFA enrolled."""
        _todo("Actor.without_mfa")

    def passkey_only(self):
        """Same user, signed in through a passkey-only account."""
        _todo("Actor.passkey_only")

    def enroll_totp(self):
        _todo("Actor.enroll_totp")


@dataclass
class Family:
    name: str
    family: Resource
    family_admin: Actor
    member_recipient: Actor
    member_giver: Actor
    guest_scoped: Actor
    guest_unscoped: Actor
    assignee_link: Actor
    recipient_list: Resource
    other_list: Resource

    def new_list(self, recipient, created_by=None):
        _todo("Family.new_list")

    def new_item(self, list=None, quantity=1, allow_duplicates=False, **fields):
        """Item on `list` (default recipient_list)."""
        _todo("Family.new_item")

    def new_claim(self, item, by):
        _todo("Family.new_claim")

    def new_pledge(self, item, by):
        _todo("Family.new_pledge")

    def new_assignment(self, item, assigner, assignee):
        _todo("Family.new_assignment")

    def new_invite(self, email="new.person@example.test"):
        """Invite with `.token` and `.email` set; `.expire()` and `.revoke()` available."""
        _todo("Family.new_invite")

    def new_guest_link(self, issued_by, lists=None):
        """Guest link with `.token`; lists defaults to [recipient_list]."""
        _todo("Family.new_guest_link")

    def membership_of(self, actor):
        _todo("Family.membership_of")

    def add_family_admin(self):
        _todo("Family.add_family_admin")

    def notifications_for(self, actor):
        _todo("Family.notifications_for")


@dataclass
class Grandma:
    alpha_member: Actor
    beta_guest: Actor


def _build_family(name):
    _todo(f"family {name}")


@pytest.fixture
def anonymous():
    return new_anonymous()


@pytest.fixture
def instance_admin():
    _todo("instance_admin")


@pytest.fixture
def alpha():
    return _build_family("alpha")


@pytest.fixture
def beta():
    return _build_family("beta")


@pytest.fixture
def grandma(alpha, beta):
    _todo("grandma")
