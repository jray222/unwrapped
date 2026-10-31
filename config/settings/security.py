SESSION_COOKIE_SECURE = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SECURE = True
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_SAMESITE = "Lax"

SECURE_REFERRER_POLICY = "no-referrer"
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"

# No inline scripts: all JS must be served from our own origin.
CONTENT_SECURITY_POLICY = "default-src 'self'; frame-ancestors 'none'; script-src 'self'"

# Argon2id only; no legacy hashers.
PASSWORD_HASHERS = ["django.contrib.auth.hashers.Argon2PasswordHasher"]
