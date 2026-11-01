"""Server-side identity plumbing as the real, un-RLS-bypassed app role.

These tests prove the two properties the superuser-connected suites cannot see:

1. A user principal's family context can be upgraded from object URLs via
   rls.family_of_object (the middleware family/family_id kwarg fix), and the
   upgrade still yields zero rows for anyone who is not a member.
2. Link principals identify themselves through definer functions instead of
   ORM reads their policies deny, guest and assignment-link flows behave
   identically under the app role, and guest scope comes from the database.
"""

from types import SimpleNamespace

import pytest
from django.contrib.auth.models import AnonymousUser

from apps.authz import db as rls_db
from apps.authz.middleware import ANONYMOUS, Principal, adopt_family
from apps.authz.permissions import get_actor_context
from apps.families.models import AssignmentLink, GuestLink, Item, Membership, WishList
from rls_helpers import anonymous, as_assignment_link, as_guest, as_user


def test_family_of_object_resolves_every_addressable_row(world):
    with as_user(world.u_admin, world.alpha):
        m_gus_id = Membership.objects.get(family_id=world.alpha, user=world.u_gus).pk
        assert rls_db.family_of_object("families_family", world.alpha) == world.alpha
        assert rls_db.family_of_object("families_membership", m_gus_id) == world.alpha
        assert rls_db.family_of_object("families_wishlist", world.l_rita) == world.alpha
        assert rls_db.family_of_object("families_item", world.i_rita) == world.alpha
        assert rls_db.family_of_object("families_claim", world.c_rita_gus) == world.alpha
        assert rls_db.family_of_object("families_assignment", world.a_rita) == world.alpha
        assert rls_db.family_of_object("families_guestlink", world.g_guest) == world.alpha
        # Unknown ids and junk ids: no family, and no SQL roundtrip for garbage.
        assert rls_db.family_of_object("families_item", 999999) is None
        assert rls_db.family_of_object("families_item", 0) is None
        assert rls_db.family_of_object("families_item", -1) is None


def test_family_of_object_works_without_a_family_context(world):
    # The definer, not the policies, decides existence: a principal with unset
    # settings (an object URL before adoption) can still find the family id.
    with anonymous():
        assert rls_db.family_of_object("families_wishlist", world.l_rita) == world.alpha


def test_family_of_object_rejects_unknown_tables():
    with anonymous():
        with pytest.raises(ValueError):
            rls_db.family_of_object("families_not_a_table", 1)


def test_adopted_family_still_denies_non_members(world):
    """adopt_family with a foreign family never widens what a principal sees."""
    request = SimpleNamespace(principal=Principal(type="user", user_id=world.u_zed), user=None)
    with as_user(world.u_zed, None):
        adopt_family(request, world.alpha)
        assert request.principal.family_id == world.alpha
        # A beta member: alpha rows stay invisible even with alpha context set.
        assert not Item.objects.filter(id=world.i_rita).exists()


def test_adopted_family_lets_members_fetch_object_rows(world):
    request = SimpleNamespace(principal=Principal(type="user", user_id=world.u_gus), user=None)
    with as_user(world.u_gus, None):
        adopt_family(request, world.alpha)
        assert WishList.objects.get(id=world.l_rita).pk == world.l_rita
        assert Item.objects.get(id=world.i_gus).pk == world.i_gus


def test_adopt_family_ignores_link_principals_and_junk(world):
    request = SimpleNamespace(principal=Principal(type="guest", family_id=world.alpha, link_id=world.g_guest))
    with as_guest(world.g_guest, world.alpha):
        adopt_family(request, world.beta)
        assert request.principal.family_id == world.alpha
    request = SimpleNamespace(principal=ANONYMOUS, user=None)
    adopt_family(request, world.alpha)
    assert request.principal is ANONYMOUS
    request = SimpleNamespace(principal=Principal(type="user", user_id=world.u_gus), user=None)
    adopt_family(request, "7")
    assert request.principal.family_id is None


def _request(principal):
    return SimpleNamespace(principal=principal, user=AnonymousUser())


def test_guest_identifies_itself_via_the_definer(world):
    # A guest principal reading its own link row through the ORM finds zero
    # rows by design; identity must come from the definer path instead.
    with as_guest(world.g_guest, world.alpha):
        assert not GuestLink.objects.filter(id=world.g_guest).exists()
        role, person, family_id = get_actor_context(
            _request(Principal(type="guest", family_id=world.alpha, link_id=world.g_guest)),
            world.alpha,
        )
        assert role == "guest" and family_id == world.alpha
        assert person is not None


def test_guest_denied_when_link_is_revoked(world):
    request = _request(Principal(type="guest", family_id=world.alpha, link_id=world.g_revoked))
    with as_guest(world.g_revoked, world.alpha):
        assert get_actor_context(request, world.alpha) == ("denied", None, None)


def test_assignment_link_identity_via_the_definer(world):
    request = _request(Principal(type="assignment_link", family_id=world.alpha, link_id=world.al_mia))
    # The link principal cannot read its AssignmentLink row either.
    with as_assignment_link(world.al_mia, world.alpha):
        assert not AssignmentLink.objects.filter(id=world.al_mia).exists()
        role, person, family_id = get_actor_context(request, world.alpha)
        assert role == "assignment_link" and family_id == world.alpha
        assert person is not None


def test_guest_scope_comes_from_the_definer(world):
    with as_guest(world.g_guest, world.alpha):
        # In scope: rita's and gus's lists (the link's GuestLinkList rows).
        assert rls_db.guest_allows_list(world.l_rita) is True
        assert rls_db.guest_allows_list(world.l_gus) is True
        # Out of scope: another list in the family, and another family's.
        assert rls_db.guest_allows_list(world.l_admin) is False
        assert rls_db.guest_allows_list(world.l_beta) is False
    # A member principal has no guest scope at all.
    with as_user(world.u_gus, world.alpha):
        assert rls_db.guest_allows_list(world.l_rita) is False


def test_membership_lookup_holds_for_same_family_and_dies_cross_family(world):
    with as_user(world.u_gus, world.alpha):
        assert Membership.objects.filter(family_id=world.alpha, user=world.u_gus).exists()
    with as_user(world.u_zed, world.alpha):
        assert not Membership.objects.filter(family_id=world.alpha, user=world.u_zed).exists()
