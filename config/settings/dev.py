import os

os.environ.setdefault("DJANGO_SECRET_KEY", "dev-only-insecure-key")
os.environ.setdefault("DB_NAME", "unwrapped")
os.environ.setdefault("DB_USER", "unwrapped_app")
os.environ.setdefault("DB_PASSWORD", "dev-only")
os.environ.setdefault("DB_HOST", "localhost")

from .base import *  # noqa: E402,F401,F403

DEBUG = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1", "testserver"]
