import pytest


@pytest.fixture(autouse=True)
def _cleared_ratelimit_cache():
    # The rate limiter (apps/authz/ratelimit.py) counts anonymously in the
    # cache; without this autouse reset its fixed 60s windows would count one
    # whole test run as a single client to every test that opens an exchange
    # or invite-accept endpoint. tests/rls opts out (own conftest, real app
    # role) and simply never uses these decorators.
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _client_requests_need_db(request):
    # Every request now runs inside a database transaction (RlsContextMiddleware), so any
    # test that drives the Django test client needs database access, even for /healthz.
    # tests/rls opts out: it manages its own connections as the non-superuser app role.
    if "client" in request.fixturenames and "rls" not in request.path.parts:
        request.getfixturevalue("db")
