FROM python:3.13.18-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# Code stays owned by root and is not writable by the app user.
COPY . .
RUN chown -R root:root /app && chmod -R go-w,a+rX /app

# Static manifest comes out of the image build (read-only root FS at runtime).
# Dummy build-time-only settings satisfy the env-required settings module.
RUN DJANGO_SETTINGS_MODULE=config.settings.prod \
    DJANGO_SECRET_KEY=build-time-only \
    DB_NAME=unused DB_USER=unused DB_PASSWORD=unused DB_HOST=unused \
    python manage.py collectstatic --noinput

USER 10001:10001
EXPOSE 8000

CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "3"]
