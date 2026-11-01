import os
from pathlib import Path

from .security import *  # noqa: F401,F403

BASE_DIR = Path(__file__).resolve().parent.parent.parent

SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]
DEBUG = False
ALLOWED_HOSTS = [h for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "").split(",") if h]

# django-allauth accounts, login and MFA (invite-only signup, adapter in
# apps/authz/adapter.py). django.contrib.sites is NOT needed since allauth 0.63.
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "allauth",
    "allauth.account",
    "allauth.mfa",
    "apps.families",
    "apps.authz",
]

# allauth's AuthenticationBackend only: no ModelBackend for username/password,
# because its login view is not rate limited. Local accounts log in by email.
AUTHENTICATION_BACKENDS = ["allauth.account.auth_backends.AuthenticationBackend"]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "config.middleware.ContentSecurityPolicyMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "allauth.account.middleware.AccountMiddleware",
    "apps.authz.mfa_gate.MfaGateMiddleware",
    "apps.authz.middleware.RlsContextMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

# The app role is non-superuser and not the table owner; migrations run
# with the migrator role by overriding DB_USER / DB_PASSWORD (see Makefile).
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ["DB_NAME"],
        "USER": os.environ["DB_USER"],
        "PASSWORD": os.environ["DB_PASSWORD"],
        "HOST": os.environ["DB_HOST"],
        "PORT": os.environ.get("DB_PORT", "5432"),
    }
}

# Optional Postgres template cloned for every pytest-created test database
# (tests/make_test_template.sh). db/init SQL such as the schema rls created by
# 02-rls-roles.sql exists only on the main data volume, so test databases need
# to inherit it. Unset in prod: nothing there creates test databases.
if os.environ.get("DB_TEST_TEMPLATE"):
    DATABASES["default"]["TEST"] = {"TEMPLATE": os.environ["DB_TEST_TEMPLATE"]}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# allauth accounts, invite-only: signup stays closed (adapter in apps/authz;
# accounts are born only through the invite-accept flow). Local accounts log
# in by email; usernames are never selectable for authentication.
ACCOUNT_ADAPTER = "apps.authz.adapter.AccountAdapter"
ACCOUNT_LOGIN_METHODS = {"email"}
# Aligned with the email login method although the signup view itself never
# opens; the fields stay correct if the adapter is ever reopened.
ACCOUNT_SIGNUP_FIELDS = ["email*", "password1*", "password2*"]
# Sessions die with the browser; "remember me" would be a feature decision.
ACCOUNT_SESSION_REMEMBER = False
# Neutralize "no user with that email" feedback on login and password reset.
ACCOUNT_PREVENT_ENUMERATION = True

# MFA: TOTP and recovery codes only for now; WebAuthn/passkeys arrive with
# their own PR (they need the [mfa] extra, static assets, and per-origin
# configuration). MFA_REAUTHENTICATION_REQUIRED defaults to True and stays.
MFA_SUPPORTED_TYPES = ["recovery_codes", "totp"]
MFA_TOTP_ISSUER = "unwrapped"

# Name-based redirects stay stable while URLs are (re)built: login and home
# exist in config/urls.py, mfa_index comes from allauth.
LOGIN_URL = "account_login"
LOGIN_REDIRECT_URL = "home"
LOGOUT_REDIRECT_URL = "home"
ACCOUNT_EMAIL_CONFIRMATION_ANONYMOUS_REDIRECT_URL = "account_login"

# Static (allauth loads the recovery-pages JS over rather than inlining, which
# keeps the CSP intact). In prod the files are collected with collectstatic in
# the image build into STATIC_ROOT and served off the app origin through the
# static/ URL route (config/urls.py) behind Caddy.
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# Default deny for DRF: every API view must declare its own permission.
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Never log bearer tokens or URLs containing them (CLAUDE.md rule 7).
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {
        "mask_tokens": {
            "()": "config.logging.TokenSanitizingFilter",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "filters": ["mask_tokens"],
        },
    },
    "loggers": {
        "django.request": {
            "filters": ["mask_tokens"],
        },
        "django": {
            "filters": ["mask_tokens"],
        },
    },
    "root": {
        "filters": ["mask_tokens"],
    },
}
