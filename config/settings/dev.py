import os

os.environ.setdefault("DJANGO_SECRET_KEY", "dev-only-insecure-key")
os.environ.setdefault("DB_NAME", "unwrapped")
os.environ.setdefault("DB_USER", "unwrapped_app")
os.environ.setdefault("DB_PASSWORD", "dev-only")
os.environ.setdefault("DB_HOST", "localhost")
# pytest-created test databases clone this template (tests/make_test_template.sh);
# the db/init grant scripts ran on the template, not on the test databases.
os.environ.setdefault("DB_TEST_TEMPLATE", "template_unwrapped")

from .base import *  # noqa: F401,F403

DEBUG = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1", "testserver"]
# Console mailer: password reset etc. print to stdout instead of leaving the
# box. Prod configures the same alias with real SMTP as env-driven config.
MAILERS = {"default": {"BACKEND": "django.core.mail.backends.console.EmailBackend"}}
