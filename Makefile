-include .env

.PHONY: up down migrate test

up:
	docker compose up -d --build

down:
	docker compose down

# Migrations run as the migrator role; the app role cannot create tables.
migrate:
	DB_USER=$(MIGRATOR_DB_USER) DB_PASSWORD=$(MIGRATOR_DB_PASSWORD) \
		docker compose run --rm -e DB_USER -e DB_PASSWORD app python manage.py migrate

test:
	docker compose run --rm app pytest
