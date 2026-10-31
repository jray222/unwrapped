from django.core.exceptions import ValidationError
from django.db import connection, transaction

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


def lock_item_claims(item_id):
    """Transaction-scoped advisory lock serialising claim writes for one item.

    Replaces select_for_update(): that needs the UPDATE policy on the item row, which
    members who do not manage the list (and guests) do not have under RLS, so the lock
    query would find no row. The key must match the claim_guard trigger (rls.tg_claim_guard).
    """
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended('item-claims:' || %s::bigint::text, 0))", [item_id])


def create_claim(*, item, claimer, assignment=None):
    """Claim creation: the advisory lock serialises concurrent claims on the item, then a
    friendly pre-check runs. The claim_guard database trigger is the authoritative capacity
    check, so a writer that skips this function cannot over-claim either. A
    unique-constraint IntegrityError means this claimer already holds a claim on the item.
    """
    with transaction.atomic():
        lock_item_claims(item.pk)
        item = Item.objects.get(pk=item.pk)
        validate_claim_capacity(item)
        claim = Claim(family_id=item.family_id, item=item, claimer=claimer, assignment=assignment)
        claim.save()
        return claim


def create_assignment(*, item, assignee, assigner):
    """Assigns the item and claims it in the assignee's name in one transaction."""
    with transaction.atomic():
        lock_item_claims(item.pk)
        item = Item.objects.get(pk=item.pk)
        assignment = Assignment(family_id=item.family_id, item=item, assignee=assignee, assigner=assigner)
        assignment.save()
        create_claim(item=item, claimer=assignee, assignment=assignment)
        return assignment
