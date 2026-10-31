"""Test-data seeding over a SUPERUSER connection.

The app role cannot create most of this data (no membership INSERT policy, no family
INSERT, and so on) and must not be able to, so fixtures are written by a separate
superuser connection and committed. Everything the tests then *read or write* goes
through the real app-role connection.
"""

from datetime import datetime, timedelta, timezone

NOW = "now()"
TABLES = [
    "families_claimnotification",
    "families_auditlog",
    "families_claim",
    "families_pledge",
    "families_assignment",
    "families_assignmentlink",
    "families_guestlinklist",
    "families_guestlink",
    "families_invite",
    "families_item",
    "families_wishlist",
    "families_person",
    "families_membership",
    "families_family",
    "django_session",
    "auth_user",
]


class Seed:
    def __init__(self, conn):
        self.conn = conn
        self._n = 0

    def _one(self, sql, params=()):
        return self.conn.execute(sql, params).fetchone()[0]

    def _next(self):
        self._n += 1
        return self._n

    def wipe(self):
        self.conn.execute(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE")

    def user(self, username):
        return self._one(
            "INSERT INTO auth_user (password, is_superuser, username, first_name, last_name, email, is_staff,"
            " is_active, date_joined) VALUES ('!', false, %s, '', '', '', false, true, now()) RETURNING id",
            [username],
        )

    def family(self, name):
        return self._one(
            "INSERT INTO families_family (name, created_at, updated_at) VALUES (%s, now(), now()) RETURNING id", [name]
        )

    def membership(self, family, user, role="member"):
        return self._one(
            "INSERT INTO families_membership (family_id, user_id, role, created_at, updated_at)"
            " VALUES (%s, %s, %s, now(), now()) RETURNING id",
            [family, user, role],
        )

    def person(self, family, first_name, user=None, email=""):
        return self._one(
            "INSERT INTO families_person (family_id, user_id, first_name, last_name, email, created_at, updated_at)"
            " VALUES (%s, %s, %s, '', %s, now(), now()) RETURNING id",
            [family, user, first_name, email],
        )

    def wishlist(self, family, recipient, created_by, managed_by=None, title="List"):
        return self._one(
            "INSERT INTO families_wishlist (family_id, recipient_id, created_by_id, managed_by_id, title,"
            " created_at, updated_at) VALUES (%s, %s, %s, %s, %s, now(), now()) RETURNING id",
            [family, recipient, created_by, managed_by, title],
        )

    def item(self, family, wish_list, name="Lego", quantity=1, allow_duplicates=False):
        return self._one(
            "INSERT INTO families_item (family_id, list_id, name, notes, store_name, store_url, price, quantity,"
            " allow_duplicates, photo, created_at, updated_at)"
            " VALUES (%s, %s, %s, '', '', '', NULL, %s, %s, '', now(), now()) RETURNING id",
            [family, wish_list, name, quantity, allow_duplicates],
        )

    def claim(self, family, item, claimer, assignment=None):
        return self._one(
            "INSERT INTO families_claim (family_id, item_id, claimer_id, assignment_id, created_at)"
            " VALUES (%s, %s, %s, %s, now()) RETURNING id",
            [family, item, claimer, assignment],
        )

    def pledge(self, family, item, pledger):
        return self._one(
            "INSERT INTO families_pledge (family_id, item_id, pledger_id, amount, created_at, updated_at)"
            " VALUES (%s, %s, %s, NULL, now(), now()) RETURNING id",
            [family, item, pledger],
        )

    def assignment(self, family, item, assignee, assigner, status="assigned"):
        return self._one(
            "INSERT INTO families_assignment (family_id, item_id, assignee_id, assigner_id, status, created_at,"
            " updated_at) VALUES (%s, %s, %s, %s, %s, now(), now()) RETURNING id",
            [family, item, assignee, assigner, status],
        )

    def _link(self, table, family, person, issued_by, expires_in, revoked):
        self._next()
        expires = datetime.now(timezone.utc) + expires_in
        return self._one(
            f"INSERT INTO {table} (family_id, person_id, issued_by_id, token_hash, expires_at, revoked_at, created_at)"
            " VALUES (%s, %s, %s, %s, %s, %s, now()) RETURNING id",
            [family, person, issued_by, f"{self._n:064x}", expires, datetime.now(timezone.utc) if revoked else None],
        )

    def guest_link(self, family, person, issued_by, lists, expires_in=timedelta(days=30), revoked=False):
        link = self._link("families_guestlink", family, person, issued_by, expires_in, revoked)
        for wish_list in lists:
            self.conn.execute(
                "INSERT INTO families_guestlinklist (family_id, guest_link_id, list_id) VALUES (%s, %s, %s)",
                [family, link, wish_list],
            )
        return link

    def assignment_link(self, family, person, issued_by, expires_in=timedelta(days=30), revoked=False):
        return self._link("families_assignmentlink", family, person, issued_by, expires_in, revoked)

    def audit(self, family, action, actor=None, recipient_person=None):
        return self._one(
            "INSERT INTO families_auditlog (family_id, actor_id, recipient_person_id, action, target_type,"
            " metadata, created_at) VALUES (%s, %s, %s, %s, '', '{}', now()) RETURNING id",
            [family, actor, recipient_person, action],
        )
