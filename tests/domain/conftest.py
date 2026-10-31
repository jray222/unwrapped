import pytest
from django.contrib.auth import get_user_model

from apps.families.models import Family, Item, Membership, Person, WishList


@pytest.fixture
def family(db):
    return Family.objects.create(name="Alpha")


@pytest.fixture
def other_family(db):
    return Family.objects.create(name="Beta")


@pytest.fixture
def make_user(db):
    return lambda name: get_user_model().objects.create_user(username=name, password=None)


@pytest.fixture
def admin_user(make_user, family):
    user = make_user("admin")
    Membership.objects.create(family=family, user=user, role=Membership.Role.FAMILY_ADMIN)
    return user


@pytest.fixture
def make_person(family):
    return lambda first_name, **kw: Person.objects.create(family=kw.pop("family", family), first_name=first_name, **kw)


@pytest.fixture
def recipient(make_person):
    return make_person("Rita")


@pytest.fixture
def giver(make_person):
    return make_person("Gus")


@pytest.fixture
def wish_list(family, recipient, admin_user):
    return WishList.objects.create(family=family, recipient=recipient, created_by=admin_user, title="Birthday")


@pytest.fixture
def item(family, wish_list):
    return Item.objects.create(family=family, list=wish_list, name="Lego")
