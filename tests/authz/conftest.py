"""Fixtures for the authz matrix tests.

Per family (alpha, beta) a `Family` holds:
  family_admin, member_recipient, member_giver   logged-in actors
  guest_scoped      guest link scoped to member_recipient's list
  guest_unscoped    guest link scoped to other_list only
  assignee_link     assignment link for one person
  recipient_list    list for member_recipient, created by member_recipient
  other_list        list created by member_giver for member_giver
Each family is seeded with at least one row in every tenant table.
`grandma` is a member of alpha and a guest (scoped to beta.recipient_list) in beta.
"""

import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import Client
from django.urls import reverse
from django.utils import timezone

from allauth.mfa.models import Authenticator
from allauth.mfa.totp.internal.auth import TOTP, generate_totp_secret

from apps.families import tokens
from apps.families.models import (
    Assignment,
    AuditLog,
    AssignmentLink,
    Claim,
    ClaimNotification,
    Family as FamilyModel,
    GuestLink,
    GuestLinkList,
    Invite,
    Item,
    Membership,
    Person,
    Pledge,
    WishList,
)
from .helpers import new_anonymous


def _uid():
    return uuid.uuid4().hex[:8]


@dataclass
class Resource:
    """A persisted object. `ref` goes in URLs; `marker` is a string unique to its content."""

    ref: str
    family: Any
    marker: str
    token: str | None = None
    email: str | None = None
    model_instance: Any = None

    def expire(self):
        if self.model_instance and hasattr(self.model_instance, "expires_at"):
            past = timezone.now() - timedelta(days=1)
            table = self.model_instance._meta.db_table
            with connection.cursor() as cursor:
                cursor.execute("SET session_replication_role = replica")
                cursor.execute(f"UPDATE {table} SET expires_at = %s WHERE id = %s", [past, self.model_instance.pk])
                cursor.execute("SET session_replication_role = origin")
            self.model_instance.refresh_from_db()

    def revoke(self):
        if self.model_instance and hasattr(self.model_instance, "revoked_at"):
            self.model_instance.revoked_at = timezone.now()
            self.model_instance.save(update_fields=["revoked_at"])


@dataclass
class Actor:
    """A principal with an HTTP client already authenticated as them."""

    principal: str
    client: Any
    ref: str
    first_name: str
    token: str | None = None
    user: Any = None
    person: Any = None
    link: Any = None

    @property
    def marker(self):
        return self.first_name

    def revoke(self):
        """Link principals only: revoke the link behind this session."""
        if self.link:
            self.link.revoked_at = timezone.now()
            self.link.save(update_fields=["revoked_at"])

    def expire(self):
        """Link principals only: move past the link's expiry."""
        if self.link:
            past = timezone.now() - timedelta(days=1)
            table = self.link._meta.db_table
            with connection.cursor() as cursor:
                cursor.execute("SET session_replication_role = replica")
                cursor.execute(f"UPDATE {table} SET expires_at = %s WHERE id = %s", [past, self.link.pk])
                cursor.execute("SET session_replication_role = origin")
            self.link.refresh_from_db()

    def without_mfa(self):
        """Same user, signed in through a local account with no MFA enrolled."""
        User = get_user_model()
        user_no_mfa = User.objects.create_user(
            username=f"nomfa_{_uid()}",
            email=f"nomfa_{_uid()}@example.test",
            password="password123!",
        )
        if self.user and hasattr(self.user, "memberships"):
            for m in self.user.memberships.all():
                Membership.objects.create(family=m.family, user=user_no_mfa, role=m.role)
        client = Client()
        client.force_login(user_no_mfa)
        return Actor(
            principal=self.principal,
            client=client,
            ref=self.ref,
            first_name=self.first_name,
            user=user_no_mfa,
            person=self.person,
        )

    def passkey_only(self):
        """Same user, signed in through a passkey-only account."""
        User = get_user_model()
        user_passkey = User.objects.create_user(
            username=f"passkey_{_uid()}",
            email=f"passkey_{_uid()}@example.test",
            password=None,
        )
        user_passkey.set_unusable_password()
        user_passkey.save(update_fields=["password"])
        if self.user and hasattr(self.user, "memberships"):
            for m in self.user.memberships.all():
                Membership.objects.create(family=m.family, user=user_passkey, role=m.role)
        client = Client()
        client.force_login(user_passkey)
        return Actor(
            principal=self.principal,
            client=client,
            ref=self.ref,
            first_name=self.first_name,
            user=user_passkey,
            person=self.person,
        )

    def enroll_totp(self):
        if self.user:
            TOTP.activate(self.user, generate_totp_secret())


@dataclass
class Family:
    name: str
    family: Resource
    family_admin: Actor
    member_recipient: Actor
    member_giver: Actor
    guest_scoped: Actor
    guest_unscoped: Actor
    assignee_link: Actor
    recipient_list: Resource
    other_list: Resource
    _model: Any = None

    def new_list(self, recipient, created_by=None):
        person = recipient.person if hasattr(recipient, "person") else (recipient.model_instance if hasattr(recipient, "model_instance") else recipient)
        creator = created_by.user if (created_by and hasattr(created_by, "user")) else self.family_admin.user
        title = f"list_{_uid()}"
        lst = WishList.objects.create(
            family=self._model,
            recipient=person,
            created_by=creator,
            title=title,
        )
        return Resource(ref=str(lst.id), family=self.family, marker=title, model_instance=lst)

    def new_item(self, list=None, quantity=1, allow_duplicates=False, **fields):
        """Item on `list` (default recipient_list)."""
        target_list = list.model_instance if (list and hasattr(list, "model_instance")) else (list or self.recipient_list.model_instance)
        name = fields.pop("name", f"item_{_uid()}")
        item = Item.objects.create(
            family=self._model,
            list=target_list,
            name=name,
            quantity=quantity,
            allow_duplicates=allow_duplicates,
            **fields,
        )
        return Resource(ref=str(item.id), family=self.family, marker=name, model_instance=item)

    def new_claim(self, item, by):
        target_item = item.model_instance if hasattr(item, "model_instance") else item
        person = by.person if hasattr(by, "person") else (by.model_instance if hasattr(by, "model_instance") else by)
        claim = Claim.objects.create(
            family=self._model,
            item=target_item,
            claimer=person,
        )
        return Resource(ref=str(claim.id), family=self.family, marker=person.first_name, model_instance=claim)

    def new_pledge(self, item, by):
        target_item = item.model_instance if hasattr(item, "model_instance") else item
        person = by.person if hasattr(by, "person") else (by.model_instance if hasattr(by, "model_instance") else by)
        marker = f"pledge_{_uid()}"
        pledge = Pledge.objects.create(
            family=self._model,
            item=target_item,
            pledger=person,
            amount=15,
        )
        return Resource(ref=str(pledge.id), family=self.family, marker=person.first_name, model_instance=pledge)

    def new_assignment(self, item, assigner, assignee):
        target_item = item.model_instance if hasattr(item, "model_instance") else item
        assigner_user = assigner.user if hasattr(assigner, "user") else assigner
        assignee_person = assignee.person if hasattr(assignee, "person") else (assignee.model_instance if hasattr(assignee, "model_instance") else assignee)
        marker = f"assign_{_uid()}"
        assignment = Assignment.objects.create(
            family=self._model,
            item=target_item,
            assigner=assigner_user,
            assignee=assignee_person,
            status="assigned",
        )
        return Resource(ref=str(assignment.id), family=self.family, marker=assignee_person.first_name, model_instance=assignment)

    def new_invite(self, email="new.person@example.test"):
        """Invite with `.token` and `.email` set; `.expire()` and `.revoke()` available."""
        raw = tokens.new_token()
        invite = Invite.objects.create(
            family=self._model,
            created_by=self.family_admin.user,
            email=email,
            token_hash=tokens.hash_token(raw),
            expires_at=timezone.now() + timedelta(days=7),
        )
        return Resource(ref=str(invite.id), family=self.family, marker=email, token=raw, email=email, model_instance=invite)

    def new_guest_link(self, issued_by, lists=None):
        """Guest link with `.token`; lists defaults to [recipient_list]."""
        issuer = issued_by.user if hasattr(issued_by, "user") else issued_by
        target_lists = lists or [self.recipient_list]
        guest_person = Person.objects.create(family=self._model, first_name=f"Guest_{_uid()}")
        raw = tokens.new_token()
        link = GuestLink.objects.create(
            family=self._model,
            issued_by=issuer,
            person=guest_person,
            token_hash=tokens.hash_token(raw),
            expires_at=timezone.now() + timedelta(days=30),
        )
        for l in target_lists:
            target_l = l.model_instance if hasattr(l, "model_instance") else l
            GuestLinkList.objects.create(family=self._model, guest_link=link, list=target_l)
        return Resource(ref=str(link.id), family=self.family, marker=guest_person.first_name, token=raw, model_instance=link)

    def membership_of(self, actor):
        target_user = actor.user if hasattr(actor, "user") else actor
        m = Membership.objects.get(family=self._model, user=target_user)
        return Resource(ref=str(m.id), family=self.family, marker=actor.marker, model_instance=m)

    def add_family_admin(self):
        User = get_user_model()
        name = f"admin_{_uid()}"
        user = User.objects.create_user(username=name, email=f"{name}@example.test", password="password123!")
        TOTP.activate(user, generate_totp_secret())
        Membership.objects.create(family=self._model, user=user, role=Membership.Role.FAMILY_ADMIN)
        person = Person.objects.create(family=self._model, user=user, first_name=name)
        client = Client()
        client.force_login(user)
        return Actor(principal="family_admin", client=client, ref=str(person.id), first_name=name, user=user, person=person)

    def notifications_for(self, actor):
        person = actor.person if hasattr(actor, "person") else actor
        pid = getattr(person, "id", person)
        return list(ClaimNotification.objects.filter(family=self._model, claimer_id=pid))


@dataclass
class Grandma:
    alpha_member: Actor
    beta_guest: Actor


def _make_logged_in_member(family, role, first_name):
    User = get_user_model()
    name = f"{first_name.lower()}_{_uid()}"
    user = User.objects.create_user(username=name, email=f"{name}@example.test", password="password123!")
    TOTP.activate(user, generate_totp_secret())
    Membership.objects.create(family=family, user=user, role=role)
    person = Person.objects.create(family=family, user=user, first_name=first_name)
    client = Client()
    client.force_login(user)
    principal_name = "family_admin" if role == Membership.Role.FAMILY_ADMIN else "member"
    return Actor(
        principal=principal_name,
        client=client,
        ref=str(person.id),
        first_name=first_name,
        user=user,
        person=person,
    )


def _make_guest_actor(family, target_list, first_name, issuer_user):
    person = Person.objects.create(family=family, first_name=first_name)
    raw = tokens.new_token()
    link = GuestLink.objects.create(
        family=family,
        issued_by=issuer_user,
        person=person,
        token_hash=tokens.hash_token(raw),
        expires_at=timezone.now() + timedelta(days=30),
    )
    GuestLinkList.objects.create(family=family, guest_link=link, list=target_list)
    client = Client()
    client.get(reverse("guest-link-exchange", args=[raw]))
    return Actor(
        principal="guest",
        client=client,
        ref=str(person.id),
        first_name=first_name,
        token=raw,
        person=person,
        link=link,
    )


def _make_assignment_actor(family, first_name, issuer_user):
    person = Person.objects.create(family=family, first_name=first_name)
    raw = tokens.new_token()
    link = AssignmentLink.objects.create(
        family=family,
        issued_by=issuer_user,
        person=person,
        token_hash=tokens.hash_token(raw),
        expires_at=timezone.now() + timedelta(days=30),
    )
    client = Client()
    client.get(reverse("assignment-link-exchange", args=[raw]))
    return Actor(
        principal="assignment_link",
        client=client,
        ref=str(person.id),
        first_name=first_name,
        token=raw,
        person=person,
        link=link,
    )


def _build_family(name):
    fam_model = FamilyModel.objects.create(name=name)
    fam_res = Resource(ref=str(fam_model.id), family=None, marker=name, model_instance=fam_model)
    fam_res.family = fam_res

    admin = _make_logged_in_member(fam_model, Membership.Role.FAMILY_ADMIN, f"{name}_Admin")
    recipient = _make_logged_in_member(fam_model, Membership.Role.MEMBER, f"{name}_Recipient")
    giver = _make_logged_in_member(fam_model, Membership.Role.MEMBER, f"{name}_Giver")

    recip_title = f"{name}_RecipList"
    recipient_list = WishList.objects.create(
        family=fam_model,
        recipient=recipient.person,
        created_by=recipient.user,
        title=recip_title,
    )
    recip_list_res = Resource(ref=str(recipient_list.id), family=fam_res, marker=recip_title, model_instance=recipient_list)

    other_title = f"{name}_OtherList"
    other_list = WishList.objects.create(
        family=fam_model,
        recipient=giver.person,
        created_by=giver.user,
        title=other_title,
    )
    other_list_res = Resource(ref=str(other_list.id), family=fam_res, marker=other_title, model_instance=other_list)

    # Seed at least one item on each list
    item1 = Item.objects.create(family=fam_model, list=recipient_list, name=f"{name}_Item1", quantity=2)
    item2 = Item.objects.create(family=fam_model, list=other_list, name=f"{name}_Item2", quantity=2)

    # Seed claim, pledge, assignment so every table has rows
    Claim.objects.create(family=fam_model, item=item2, claimer=recipient.person)
    Pledge.objects.create(family=fam_model, item=item2, pledger=recipient.person, amount=20)

    assignee_person = Person.objects.create(family=fam_model, first_name=f"{name}_Assignee")
    Assignment.objects.create(family=fam_model, item=item2, assigner=admin.user, assignee=assignee_person, status="assigned")

    Invite.objects.create(
        family=fam_model,
        created_by=admin.user,
        email=f"invitee_{_uid()}@example.test",
        token_hash=tokens.hash_token(tokens.new_token()),
        expires_at=timezone.now() + timedelta(days=7),
    )

    AuditLog.objects.create(
        family=fam_model,
        actor=admin.user,
        principal_type="user",
        principal_id=admin.user.id,
        recipient_person=recipient.person,
        action="claim",
        target_type="item",
        target_id=item2.id,
    )

    # Links
    guest_scoped = _make_guest_actor(fam_model, recipient_list, f"{name}_GuestScoped", admin.user)
    guest_unscoped = _make_guest_actor(fam_model, other_list, f"{name}_GuestUnscoped", admin.user)
    assignee_link = _make_assignment_actor(fam_model, f"{name}_AssigneeLink", admin.user)

    return Family(
        name=name,
        family=fam_res,
        family_admin=admin,
        member_recipient=recipient,
        member_giver=giver,
        guest_scoped=guest_scoped,
        guest_unscoped=guest_unscoped,
        assignee_link=assignee_link,
        recipient_list=recip_list_res,
        other_list=other_list_res,
        _model=fam_model,
    )


@pytest.fixture
def anonymous():
    return new_anonymous()


@pytest.fixture
def instance_admin():
    User = get_user_model()
    name = f"iadmin_{_uid()}"
    user = User.objects.create_user(
        username=name,
        email=f"{name}@example.test",
        password="password123!",
        is_staff=True,
        is_superuser=True,
    )
    TOTP.activate(user, generate_totp_secret())
    client = Client()
    client.force_login(user)
    return Actor(
        principal="instance_admin",
        client=client,
        ref=str(user.id),
        first_name="InstanceAdmin",
        user=user,
    )


@pytest.fixture
def alpha(db):
    return _build_family("Alpha")


@pytest.fixture
def beta(db):
    return _build_family("Beta")


@pytest.fixture
def grandma(alpha, beta):
    User = get_user_model()
    name = f"grandma_{_uid()}"
    user = User.objects.create_user(username=name, email=f"{name}@example.test", password="password123!")
    TOTP.activate(user, generate_totp_secret())

    # Alpha: member
    Membership.objects.create(family=alpha._model, user=user, role=Membership.Role.MEMBER)
    alpha_person = Person.objects.create(family=alpha._model, user=user, first_name="Grandma")
    alpha_client = Client()
    alpha_client.force_login(user)
    alpha_actor = Actor(
        principal="member",
        client=alpha_client,
        ref=str(alpha_person.id),
        first_name="Grandma",
        user=user,
        person=alpha_person,
    )

    # Beta: guest scoped to beta.recipient_list
    beta_actor = _make_guest_actor(beta._model, beta.recipient_list.model_instance, "GrandmaGuest", beta.family_admin.user)

    return Grandma(alpha_member=alpha_actor, beta_guest=beta_actor)
