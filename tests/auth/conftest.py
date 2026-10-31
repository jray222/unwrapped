import pytest
from django.contrib.auth import get_user_model


@pytest.fixture
def make_member(db):
    def _make(email, password="s3cretypa55w0rd!"):
        # The User model still requires a username even though the app only
        # ever signs in by email (allauth generates one during real flows);
        # tests derive a stable one from the (unique) email.
        return get_user_model().objects.create_user(username=email.split("@")[0], email=email, password=password)

    return _make


@pytest.fixture
def member(make_member):
    return make_member("rita@example.com")


@pytest.fixture
def oauth_member(make_member):
    # Google accounts have no usable password: the manager stores an unusable
    # hash when password is None (no local credential).
    return make_member("gina@example.com", password=None)
