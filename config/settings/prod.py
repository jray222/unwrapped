from .base import *  # noqa: F401,F403

# Only trust this header because the app is reachable solely through Caddy.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = False

# Hashed static file names; the manifest is built by collectstatic in the
# image build (see the Dockerfile) so allauth MFA template JavaScript URLs
# keep the CSP: no bare filenames that could drift out of the manifest.
STATICFILES_STORAGE = "django.contrib.staticfiles.storage.ManifestStaticFilesStorage"
