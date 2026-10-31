"""Read-side behaviour as the app role: tenant isolation and the surprise rule."""

import pytest
from django.apps import apps
from django.db import DatabaseError, connection, transaction

from apps.families.models import (
    Assignment, AssignmentLink, AuditLog, Claim, ClaimNotification, Family, GuestLink, GuestLinkList, Invite, Item,
    Membership, Person, Pledge, WishList,
)
from rls_helpers import anonymous, as_assignment_link, as_guest, as_user, db_error, pks

ALL_MODELS = list(apps.get_app_config("families").get_models())
# The outbox has no app_runtime grants at all: even SELECT is "permission denied" (fail closed).
READABLE_MODELS = [m for m in ALL_MODELS if m is not ClaimNotification]


def test_every_family_table_is_covered_by_the_zero_row_test():
    assert {Family, Membership, Person, WishList, Item, Claim, Pledge, Assignment, GuestLink, GuestLinkList,
            AssignmentLink, Invite, AuditLog, ClaimNotification} == set(ALL_MODELS)


@pytest.mark.parametrize("model", READABLE_MODELS, ids=lambda m: m.__name__)
def test_no_principal_sees_zero_rows(world, admin_sql, model):
    assert admin_sql(f"SELECT count(*) FROM {model._meta.db_table}")[0][0] > 0 or model is Invite
    assert model.objects.count() == 0  # autocommit, settings never set
    with anonymous():
        assert model.objects.count() == 0


@pytest.mark.parametrize("model", READABLE_MODELS, ids=lambda m: m.__name__)
def test_empty_string_settings_see_zero_rows(world, model):
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('app.family_id', '', true), set_config('app.principal_type', '', true),"
                " set_config('app.principal_id', '', true)"
            )
        assert model.objects.count() == 0


@pytest.mark.parametrize("model", READABLE_MODELS, ids=lambda m: m.__name__)
def test_family_without_principal_sees_zero_rows(world, model):
    # A family id on its own (a middleware bug) must not open anything up.
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_config('app.family_id', %s, true)", [str(world.alpha)])
        assert model.objects.count() == 0


def test_outbox_is_closed_to_the_app_role_for_every_principal(world):
    for ctx in (anonymous(), as_user(world.u_admin, world.alpha)):
        with db_error("42501"), ctx:
            ClaimNotification.objects.count()


def test_malformed_setting_fails_loudly(world):
    with pytest.raises(DatabaseError):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SELECT set_config('app.family_id', 'abc', true)")
            list(Person.objects.all())


def test_principal_id_alone_does_not_count_as_a_user(world):
    # principal_id is only meaningful together with principal_type.
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('app.family_id', %s, true), set_config('app.principal_id', %s, true)",
                [str(world.alpha), str(world.u_admin)],
            )
        assert Person.objects.count() == 0 and Membership.objects.count() == 0


def test_other_family_user_sees_nothing_in_this_family(world):
    with as_user(world.u_zed, world.alpha):
        for model in READABLE_MODELS:
            assert model.objects.count() == 0, model
    with as_user(world.u_admin, world.beta):
        for model in READABLE_MODELS:
            assert model.objects.count() == 0, model


def test_family_scope_and_does_not_exist_for_other_family_ids(world):
    with as_user(world.u_gus, world.alpha):
        assert pks(Item.objects.all()) == {world.i_rita, world.i_rita_free, world.i_gus, world.i_admin}
        assert pks(Person.objects.all()) == {world.p_admin, world.p_gus, world.p_mia, world.p_rita, world.p_guest}
        assert pks(Family.objects.all()) == {world.alpha}
        assert pks(Claim.objects.all()).isdisjoint({world.c_beta})
        with pytest.raises(Item.DoesNotExist):
            Item.objects.get(pk=world.i_beta)
        with pytest.raises(WishList.DoesNotExist):
            WishList.objects.get(pk=world.l_beta)
    with as_user(world.u_bea, world.beta):
        assert pks(Claim.objects.all()) == {world.c_beta}
        assert pks(Family.objects.all()) == {world.beta}
    with as_user(world.u_zed, world.beta):
        assert pks(Claim.objects.all()) == set()  # Zed is the recipient of l_beta
        assert pks(Family.objects.all()) == {world.beta}


def test_member_sees_claims_on_other_lists_but_not_their_own(world):
    # Gus receives l_gus: its claim (c_gus_mia) and the l_gus pledge are invisible to him.
    with as_user(world.u_gus, world.alpha):
        assert pks(Claim.objects.all()) == {world.c_rita_gus, world.c_rita_mia, world.c_admin_gus}
        assert pks(Pledge.objects.all()) == {world.pl_rita}
        assert pks(Assignment.objects.all()) == {world.a_rita}
    with as_user(world.u_mia, world.alpha):  # Mia receives nothing: sees all alpha gift state
        assert pks(Claim.objects.all()) == {world.c_rita_gus, world.c_rita_mia, world.c_gus_mia, world.c_admin_gus}
        assert pks(Pledge.objects.all()) == {world.pl_rita, world.pl_gus}
        assert pks(Assignment.objects.all()) == {world.a_rita}


def test_recipient_sees_zero_claims_pledges_assignments_on_own_list(world):
    with as_user(world.u_rita, world.alpha):
        assert pks(Claim.objects.all()) == {world.c_gus_mia, world.c_admin_gus}
        assert pks(Pledge.objects.all()) == {world.pl_gus}
        assert pks(Assignment.objects.all()) == set()
        assert Claim.objects.filter(item__list_id=world.l_rita).count() == 0
        assert Claim.objects.filter(item__list__recipient_id=world.p_rita).exists() is False
        assert Pledge.objects.filter(item_id=world.i_rita).exists() is False
        assert Item.objects.get(pk=world.i_rita).claims.count() == 0
        assert Item.objects.get(pk=world.i_rita).pledges.count() == 0
        assert Item.objects.get(pk=world.i_rita).assignments.count() == 0
        assert Item.objects.filter(claims__isnull=False, list_id=world.l_rita).count() == 0
        assert AuditLog.objects.count() == 0


def test_recipient_sees_identical_items_whether_or_not_claimed(world):
    with as_user(world.u_rita, world.alpha):
        rows = list(Item.objects.filter(list_id=world.l_rita).order_by("pk").values_list("pk", "name", "quantity"))
        assert rows == [(world.i_rita, "Rita item", 3), (world.i_rita_free, "Rita unclaimed", 1)]
        assert pks(Item.objects.all()) == {world.i_rita, world.i_rita_free, world.i_gus, world.i_admin}


def test_recipient_who_is_family_admin_sees_nothing_about_their_own_list(world):
    with as_user(world.u_admin, world.alpha):
        # The admin receives l_admin; everyone else's gift state stays visible to them.
        assert pks(Claim.objects.all()) == {world.c_rita_gus, world.c_rita_mia, world.c_gus_mia}
        assert pks(Assignment.objects.all()) == {world.a_rita}
        assert Claim.objects.filter(item__list_id=world.l_admin).count() == 0
        assert pks(AuditLog.objects.all()) == {world.au_rita, world.au_gus, world.au_invite}
        assert Membership.objects.count() == 4 and Invite.objects.count() == 0


def test_non_admin_member_cannot_read_audit_log_or_invites(world):
    with as_user(world.u_gus, world.alpha):
        assert AuditLog.objects.count() == 0
        assert Invite.objects.count() == 0
        assert GuestLink.objects.count() == 0  # issued by the admin, not by Gus


def test_guest_sees_only_scoped_lists_and_never_assignments(world):
    with as_guest(world.g_guest, world.alpha):
        assert pks(WishList.objects.all()) == {world.l_rita, world.l_gus}
        assert pks(Item.objects.all()) == {world.i_rita, world.i_rita_free, world.i_gus}
        assert pks(Claim.objects.all()) == {world.c_rita_gus, world.c_rita_mia, world.c_gus_mia}
        assert pks(Pledge.objects.all()) == {world.pl_rita, world.pl_gus}
        assert Assignment.objects.count() == 0
        assert Membership.objects.count() == 0 and AuditLog.objects.count() == 0
        assert pks(Person.objects.all()) == {world.p_guest, world.p_rita, world.p_gus, world.p_mia}
        assert Family.objects.count() == 1


def test_guest_whose_person_is_a_list_recipient_sees_no_gift_state_for_that_list(world):
    with as_guest(world.g_recipient, world.alpha):
        assert pks(Item.objects.all()) == {world.i_rita, world.i_rita_free, world.i_gus}
        assert pks(Claim.objects.all()) == {world.c_gus_mia}
        assert pks(Pledge.objects.all()) == {world.pl_gus}
        assert Assignment.objects.count() == 0
        # Claimers on Rita's list (Gus, Mia) are only visible as claimers elsewhere / recipients.
        assert pks(Person.objects.all()) == {world.p_rita, world.p_gus, world.p_mia}


@pytest.mark.parametrize("link", ["g_revoked", "g_expired"])
def test_revoked_or_expired_guest_sees_nothing(world, link):
    with as_guest(getattr(world, link), world.alpha):
        for model in READABLE_MODELS:
            assert model.objects.count() == 0, model


def test_guest_link_is_re_checked_on_every_statement(world, admin_sql):
    with as_guest(world.g_guest, world.alpha):
        assert WishList.objects.count() == 2
    admin_sql("UPDATE families_guestlink SET revoked_at = now() WHERE id = %s", [world.g_guest])
    with as_guest(world.g_guest, world.alpha):
        assert WishList.objects.count() == 0 and Item.objects.count() == 0


def test_guest_link_does_not_cross_families(world):
    with as_guest(world.g_guest, world.beta):
        for model in READABLE_MODELS:
            assert model.objects.count() == 0, model


def test_user_id_and_link_id_are_different_namespaces(world, admin_sql):
    # A guest link id numerically equal to a user id must not act as that user.
    with as_user(world.g_guest, world.alpha):  # g_guest's id used as a user id
        expected_member = admin_sql(
            "SELECT count(*) FROM families_membership WHERE user_id = %s AND family_id = %s", [world.g_guest, world.alpha]
        )[0][0]
        assert Membership.objects.count() == (4 if expected_member else 0)
    with as_guest(world.u_admin, world.alpha):  # a user id used as a guest link id
        link_exists = admin_sql("SELECT count(*) FROM families_guestlink WHERE id = %s", [world.u_admin])[0][0]
        assert (WishList.objects.count() > 0) == bool(link_exists)


def test_assignment_link_sees_only_its_own_assignments(world):
    with as_assignment_link(world.al_mia, world.alpha):
        assert pks(Assignment.objects.all()) == {world.a_rita}
        assert Claim.objects.count() == 0 and Pledge.objects.count() == 0
        assert Membership.objects.count() == 0 and AuditLog.objects.count() == 0
        assert pks(Person.objects.all()) == {world.p_mia}


def test_assignment_link_cannot_see_assignments_on_its_own_recipient_list(world, seed):
    other_link = seed.assignment_link(world.alpha, world.p_rita, world.u_admin)  # bound to the recipient
    with as_assignment_link(other_link, world.alpha):
        assert Assignment.objects.count() == 0
