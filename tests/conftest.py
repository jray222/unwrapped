import pytest


@pytest.fixture(autouse=True)
def _client_requests_need_db(request):
    # Every request now runs inside a database transaction (RlsContextMiddleware), so any
    # test that drives the Django test client needs database access, even for /healthz.
    # tests/rls opts out: it manages its own connections as the non-superuser app role.
    if "client" in request.fixturenames and "rls" not in request.path.parts:
        request.getfixturevalue("db")
