from datetime import timedelta

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.families.models import (
    Assignment,
    AssignmentLink,
    AuditLog,
    Claim,
    GuestLink,
    GuestLinkList,
    Invite,
    Item,
    Pledge,
    WishList,
)
from apps.families.services import create_assignment, create_claim

HASH = "a" * 64
FUTURE = timezone.now() + timedelta(days=30)


@pytest.fixture
def beta_person(other_family, make_person):
    return make_person("Beta", family=other_family)


def expect_integrity_error(callable_):
    with pytest.raises(IntegrityError), transaction.atomic():
        callable_()


def test_claim_cannot_reference_item_in_another_family(family, other_family, giver, item):
    expect_integrity_error(
        lambda: Claim.objects.bulk_create([Claim(family=other_family, item=item, claimer=giver)])
    )
    assert not Claim.objects.exists()


def test_claim_cannot_use_claimer_from_another_family(family, item, beta_person):
    expect_integrity_error(
        lambda: Claim.objects.bulk_create([Claim(family=family, item=item, claimer=beta_person)])
    )


def test_wishlist_recipient_must_be_same_family(family, beta_person, admin_user):
    expect_integrity_error(
        lambda: WishList.objects.bulk_create(
            [WishList(family=family, recipient=beta_person, created_by=admin_user, title="x")]
        )
    )


def test_item_list_must_be_same_family(family, other_family, beta_person, admin_user):

    beta_list = WishList.objects.create(
        family=other_family, recipient=beta_person, created_by=admin_user, title="Beta list"
    )
    expect_integrity_error(
        lambda: Item.objects.bulk_create([Item(family=family, list=beta_list, name="Lego")])
    )


def test_pledge_pledger_must_be_same_family(family, item, beta_person):
    expect_integrity_error(
        lambda: Pledge.objects.bulk_create([Pledge(family=family, item=item, pledger=beta_person)])
    )


def test_assignment_assignee_must_be_same_family(family, item, admin_user, beta_person):
    expect_integrity_error(
        lambda: Assignment.objects.bulk_create(
            [Assignment(family=family, item=item, assignee=beta_person, assigner=admin_user)]
        )
    )


def test_guest_link_scope_must_be_same_family(family, other_family, giver, wish_list, make_person, admin_user):
    link = GuestLink.objects.create(
        family=family,
        token_hash=HASH,
        expires_at=FUTURE,
        issued_by=admin_user,
        person=giver,
    )
    beta_list = WishList.objects.create(
        family=other_family,
        recipient=make_person("Other", family=other_family),
        created_by=admin_user,
        title="Beta",
    )
    expect_integrity_error(
        lambda: GuestLinkList.objects.bulk_create(
            [GuestLinkList(family=family, guest_link=link, list=beta_list)]
        )
    )


def test_assignment_link_person_must_be_same_family(family, beta_person, admin_user):

    expect_integrity_error(
        lambda: AssignmentLink.objects.bulk_create(
            [
                AssignmentLink(
                    family=family,
                    token_hash=HASH,
                    expires_at=FUTURE,
                    issued_by=admin_user,
                    person=beta_person,
                )
            ]
        )
    )


def test_invite_person_must_be_same_family(family, beta_person, admin_user):
    expect_integrity_error(
        lambda: Invite.objects.bulk_create(
            [
                Invite(
                    family=family,
                    token_hash=HASH,
                    email="x@example.com",
                    created_by=admin_user,
                    person=beta_person,
                )
            ]
        )
    )


def test_deleting_list_cascades_to_items_claims_and_pledges(family, wish_list, item, giver, make_person):
    create_claim(item=item, claimer=giver)
    Pledge.objects.create(family=family, item=item, pledger=make_person("Pat"))

    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM families_wishlist WHERE id = %s", [wish_list.pk])

    assert not Claim.objects.exists()
    assert not Pledge.objects.exists()


def test_claim_must_match_its_assignment(family, item, giver, make_person, admin_user):
    assignment = create_assignment(item=item, assignee=giver, assigner=admin_user)
    other = make_person("Pat")
    expect_integrity_error(
        lambda: Claim.objects.bulk_create(
            [Claim(family=family, item=item, claimer=other, assignment=assignment)]
        )
    )


def test_deleting_assignment_releases_its_claim(family, item, giver, admin_user):
    assignment = create_assignment(item=item, assignee=giver, assigner=admin_user)
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM families_assignment WHERE id = %s", [assignment.pk])
    assert not Claim.objects.exists()


def test_audit_claim_action_requires_recipient(family, admin_user):
    expect_integrity_error(
        lambda: AuditLog.objects.create(family=family, actor=admin_user, action=AuditLog.Action.CLAIM)
    )


def test_audit_non_recipient_action_allowed_without_recipient(family, admin_user):
    AuditLog.objects.create(family=family, actor=admin_user, action=AuditLog.Action.LOGIN)
    assert AuditLog.objects.count() == 1
