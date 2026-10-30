from django.core.exceptions import ValidationError
from django.db import transaction

from .models import Assignment, Claim, Item


class QuantityExhausted(ValidationError):
    def __init__(self):
        super().__init__("All units of this item are already claimed.", code="quantity_exhausted")


def validate_claim_capacity(item, *, exclude_claim_id=None):
    if item.allow_duplicates:
        return
    claims = Claim.objects.filter(item=item).exclude(pk=exclude_claim_id)
    if claims.count() >= item.quantity:
        raise QuantityExhausted()


def create_claim(*, item, claimer, assignment=None):
    """Authoritative claim creation: the item row lock serialises concurrent claims,
    so two people cannot both take the last unit. A unique-constraint
    IntegrityError means this claimer already holds a claim on the item.
    """
    with transaction.atomic():
        item = Item.objects.select_for_update().get(pk=item.pk)
        validate_claim_capacity(item)
        claim = Claim(family_id=item.family_id, item=item, claimer=claimer, assignment=assignment)
        claim.save()
        return claim


def create_assignment(*, item, assignee, assigner):
    """Assigns the item and claims it in the assignee's name in one transaction."""
    with transaction.atomic():
        item = Item.objects.select_for_update().get(pk=item.pk)
        assignment = Assignment(family_id=item.family_id, item=item, assignee=assignee, assigner=assigner)
        assignment.save()
        create_claim(item=item, claimer=assignee, assignment=assignment)
        return assignment
