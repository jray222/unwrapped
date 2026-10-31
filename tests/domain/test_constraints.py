import pytest
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction

from apps.families.models import Family, Item, Membership, Person, Pledge, WishList


def test_membership_unique_per_family_user(family, make_user):
    user = make_user("u")
    Membership.objects.create(family=family, user=user)
    with pytest.raises(IntegrityError), transaction.atomic():
        Membership.objects.create(family=family, user=user)


def test_user_can_be_admin_in_one_family_and_member_in_another(family, other_family, make_user):
    user = make_user("grandma")
    Membership.objects.create(family=family, user=user, role=Membership.Role.FAMILY_ADMIN)
    Membership.objects.create(family=other_family, user=user, role=Membership.Role.MEMBER)
    assert user.memberships.count() == 2


def test_one_person_per_user_per_family(family, other_family, make_user):
    user = make_user("u")
    Person.objects.create(family=family, user=user, first_name="U")
    Person.objects.create(family=other_family, user=user, first_name="U")
    with pytest.raises(IntegrityError), transaction.atomic():
        Person.objects.create(family=family, user=user, first_name="U2")


def test_many_userless_persons_allowed(make_person):
    make_person("A")
    make_person("A")


def test_person_requires_first_name(family):
    with pytest.raises(IntegrityError), transaction.atomic():
        Person.objects.create(family=family, first_name="")
    with pytest.raises(ValidationError):
        Person(family=family, first_name="").full_clean()


def test_item_quantity_must_be_positive(item):
    item.quantity = 0
    with pytest.raises(ValidationError):
        item.full_clean()
    with pytest.raises(IntegrityError), transaction.atomic():
        Item.objects.filter(pk=item.pk).update(quantity=0)


def test_item_rejects_non_http_store_url(item):
    item.store_url = "javascript:alert(1)"
    with pytest.raises(ValidationError):
        item.full_clean()
    item.store_url = "ftp://example.com/x"
    with pytest.raises(ValidationError):
        item.full_clean()
    item.store_url = "https://example.com/x"
    item.full_clean()


def test_pledge_unique_per_item_pledger(family, item, giver):
    Pledge.objects.create(family=family, item=item, pledger=giver, amount=10)
    with pytest.raises(IntegrityError), transaction.atomic():
        Pledge.objects.create(family=family, item=item, pledger=giver)


def test_recipient_cannot_pledge(family, item, recipient):
    with pytest.raises(ValidationError):
        Pledge.objects.create(family=family, item=item, pledger=recipient)


def test_item_family_must_match_list_family(other_family, wish_list):
    with pytest.raises(ValidationError):
        Item.objects.create(family=other_family, list=wish_list, name="x")


def test_list_recipient_must_be_in_same_family(other_family, make_person, admin_user):
    with pytest.raises(ValidationError):
        WishList.objects.create(
            family=other_family, recipient=make_person("X"), created_by=admin_user, title="t"
        )


def test_every_tenant_model_has_non_null_family_fk():
    from django.apps import apps

    from apps.families.models import TenantModel

    tenant_models = [m for m in apps.get_app_config("families").get_models() if issubclass(m, TenantModel)]
    assert len(tenant_models) >= 12
    for model in tenant_models:
        field = model._meta.get_field("family")
        assert not field.null and field.remote_field.model is Family, model
