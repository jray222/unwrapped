import pytest
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction

from apps.families.models import Assignment, Claim
from apps.families.services import QuantityExhausted, create_assignment, create_claim


def test_claim_succeeds_within_quantity(item, giver):
    claim = create_claim(item=item, claimer=giver)
    assert claim.family_id == item.family_id


def test_claim_rejected_when_quantity_exhausted(item, giver, make_person):
    create_claim(item=item, claimer=giver)
    with pytest.raises(QuantityExhausted):
        create_claim(item=item, claimer=make_person("Other"))
    assert Claim.objects.count() == 1


def test_quantity_two_allows_two_claims_not_three(item, giver, make_person):
    item.quantity = 2
    item.save()
    create_claim(item=item, claimer=giver)
    create_claim(item=item, claimer=make_person("B"))
    with pytest.raises(QuantityExhausted):
        create_claim(item=item, claimer=make_person("C"))


def test_allow_duplicates_lifts_the_limit(item, giver, make_person):
    item.allow_duplicates = True
    item.save()
    create_claim(item=item, claimer=giver)
    create_claim(item=item, claimer=make_person("B"))
    assert Claim.objects.count() == 2


def test_claim_clean_applies_same_capacity_check(family, item, giver, make_person):
    create_claim(item=item, claimer=giver)
    with pytest.raises(ValidationError) as exc:
        Claim(family=family, item=item, claimer=make_person("B")).full_clean()
    assert "quantity_exhausted" in [e.code for e in exc.value.error_dict["__all__"]]


def test_same_person_cannot_claim_twice(item, giver):
    item.allow_duplicates = True
    item.save()
    create_claim(item=item, claimer=giver)
    with pytest.raises(IntegrityError), transaction.atomic():
        create_claim(item=item, claimer=giver)


def test_recipient_cannot_claim(item, recipient):
    with pytest.raises(ValidationError):
        create_claim(item=item, claimer=recipient)


def test_claimer_must_be_same_family(item, other_family, make_person):
    with pytest.raises(ValidationError):
        create_claim(item=item, claimer=make_person("Z", family=other_family))


def test_assignment_to_recipient_rejected(item, recipient, admin_user):
    with pytest.raises(ValidationError) as exc:
        create_assignment(item=item, assignee=recipient, assigner=admin_user)
    assert exc.value.code == "assignee_is_recipient"
    assert not Assignment.objects.exists() and not Claim.objects.exists()


def test_direct_assignment_save_also_rejects_recipient(family, item, recipient, admin_user):
    with pytest.raises(ValidationError):
        Assignment.objects.create(family=family, item=item, assignee=recipient, assigner=admin_user)


def test_assignment_creates_claim_in_assignees_name(item, giver, admin_user):
    assignment = create_assignment(item=item, assignee=giver, assigner=admin_user)
    assert assignment.status == Assignment.Status.ASSIGNED
    assert assignment.claim.claimer == giver
    assert assignment.claim.item == item


def test_assignment_rolls_back_when_item_exhausted(item, giver, make_person, admin_user):
    create_claim(item=item, claimer=make_person("B"))
    with pytest.raises(QuantityExhausted):
        create_assignment(item=item, assignee=giver, assigner=admin_user)
    assert not Assignment.objects.exists()


def test_cancelling_assignment_releases_its_claim(item, giver, admin_user):
    assignment = create_assignment(item=item, assignee=giver, assigner=admin_user)
    assignment.delete()
    assert not Claim.objects.exists()


def test_assignment_unique_per_item_assignee(family, item, giver, admin_user):
    item.quantity = 2
    item.save()
    create_assignment(item=item, assignee=giver, assigner=admin_user)
    with pytest.raises(IntegrityError), transaction.atomic():
        Assignment.objects.create(family=family, item=item, assignee=giver, assigner=admin_user)
