from django.conf import settings


def test_healthz_ok_and_minimal(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_healthz_rejects_unsafe_methods(client):
    assert client.post("/healthz").status_code == 405


def test_security_headers(client):
    response = client.get("/healthz")
    assert response["Referrer-Policy"] == "no-referrer"
    assert response["X-Frame-Options"] == "DENY"
    assert response["X-Content-Type-Options"] == "nosniff"
    csp = response["Content-Security-Policy"]
    assert "frame-ancestors 'none'" in csp
    assert "script-src 'self'" in csp
    assert "unsafe-inline" not in csp


def test_unknown_path_still_has_headers(client):
    response = client.get("/does-not-exist")
    assert response.status_code == 404
    assert response["Referrer-Policy"] == "no-referrer"
    assert "frame-ancestors 'none'" in response["Content-Security-Policy"]


def test_cookie_settings():
    assert settings.SESSION_COOKIE_SECURE is True
    assert settings.SESSION_COOKIE_HTTPONLY is True
    assert settings.SESSION_COOKIE_SAMESITE == "Lax"
    assert settings.CSRF_COOKIE_SECURE is True
    assert settings.CSRF_COOKIE_HTTPONLY is True


def test_argon2_is_first_hasher():
    assert settings.PASSWORD_HASHERS[0] == "django.contrib.auth.hashers.Argon2PasswordHasher"
