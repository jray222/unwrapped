from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MinValueValidator
from django.db import models
from django.db.models.functions import Lower
from django.utils import timezone

from .validators import MaxLifetime, validate_http_url, validate_no_tokens, validate_token_hash

User = settings.AUTH_USER_MODEL

LINK_MAX_DAYS = 365
LINK_DEFAULT_DAYS = 30
INVITE_MAX_DAYS = 7


class Timestamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Family(Timestamped):
    name = models.CharField(max_length=200)

    def __str__(self):
        return self.name


class TenantModel(models.Model):
    """Base for every tenant table: family_id NOT NULL (indexed by the FK).

    `family_scoped` names FKs whose target must belong to the same family. Django
    has no composite FKs, so this is checked in save() and clean() for a friendly
    error. The database enforces the same rule with composite (id, family_id)
    foreign keys added in migration 0002, so bulk_create() and queryset.update()
    cannot bypass it.
    """

    family = models.ForeignKey(Family, on_delete=models.PROTECT, related_name="+")

    family_scoped = ()

    class Meta:
        abstract = True

    def validate_invariants(self):
        for name in self.family_scoped:
            related = getattr(self, name)
            if related is not None and related.family_id != self.family_id:
                raise ValidationError(f"{name} belongs to a different family.", code="cross_family")

    def clean(self):
        super().clean()
        self.validate_invariants()

    def save(self, *args, **kwargs):
        self.validate_invariants()
        super().save(*args, **kwargs)


class Membership(TenantModel, Timestamped):
    class Role(models.TextChoices):
        FAMILY_ADMIN = "family_admin"
        MEMBER = "member"

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=20, choices=Role, default=Role.MEMBER)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["family", "user"], name="uniq_membership_family_user"),
            models.CheckConstraint(condition=models.Q(role__in=["family_admin", "member"]), name="membership_role_valid"),
        ]


class Person(TenantModel, Timestamped):
    """Someone a list is for, or a claimer/assignee. Members, guests and assignees are all Persons."""

    user = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    first_name = models.CharField(max_length=100)
    last_name = models.CharField(max_length=100, blank=True)
    email = models.EmailField(blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["family", "user"], condition=models.Q(user__isnull=False), name="uniq_person_family_user"
            ),
            models.UniqueConstraint(fields=["id", "family"], name="uniq_person_id_family"),
            models.UniqueConstraint(
                "family", Lower("email"), condition=~models.Q(email=""), name="uniq_person_family_lower_email"
            ),
            models.CheckConstraint(condition=~models.Q(first_name=""), name="person_first_name_not_empty"),
        ]

    def __str__(self):
        return self.first_name


class WishList(TenantModel, Timestamped):
    family_scoped = ("recipient",)

    recipient = models.ForeignKey(Person, on_delete=models.PROTECT, related_name="+")
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    managed_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    title = models.CharField(max_length=200)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["id", "family"], name="uniq_wishlist_id_family")]


class Item(TenantModel, Timestamped):
    family_scoped = ("list",)

    list = models.ForeignKey(WishList, on_delete=models.CASCADE, related_name="items")
    name = models.CharField(max_length=200)
    notes = models.TextField(blank=True)
    store_name = models.CharField(max_length=200, blank=True)
    # Rendered as an untrusted link, never fetched server-side.
    store_url = models.URLField(max_length=2000, blank=True, validators=[validate_http_url])
    price = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True, validators=[MinValueValidator(0)])
    quantity = models.PositiveIntegerField(default=1, validators=[MinValueValidator(1)])
    allow_duplicates = models.BooleanField(default=False)
    # Storage path only; upload handling lives in a later PR.
    photo = models.CharField(max_length=255, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["id", "family"], name="uniq_item_id_family"),
            models.CheckConstraint(condition=models.Q(quantity__gte=1), name="item_quantity_positive"),
            models.CheckConstraint(
                condition=models.Q(price__isnull=True) | models.Q(price__gte=0), name="item_price_non_negative"
            ),
        ]


class RecipientExcludedMixin(models.Model):
    """Surprise rule at the data layer: the list's recipient can never hold a claim or pledge."""

    class Meta:
        abstract = True

    def _reject_recipient(self, person_id):
        if person_id == self.item.list.recipient_id:
            raise ValidationError("The list recipient cannot take part.", code="is_recipient")


class Claim(RecipientExcludedMixin, TenantModel):
    """One claim = one unit of the item. `claimer` is a Person, which covers members,
    family admins (Person.user set), guests (Person bound by GuestLink) and assignees.
    """

    family_scoped = ("item", "claimer")

    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name="claims")
    claimer = models.ForeignKey(Person, on_delete=models.PROTECT, related_name="+")
    # Set when the claim was made in an assignee's name; cancelling the assignment releases it.
    assignment = models.OneToOneField(
        "Assignment", null=True, blank=True, on_delete=models.CASCADE, related_name="claim"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["item", "claimer"], name="uniq_claim_item_claimer")]

    def validate_invariants(self):
        super().validate_invariants()
        self._reject_recipient(self.claimer_id)
        if self.assignment_id and (
            self.assignment.item_id != self.item_id or self.assignment.assignee_id != self.claimer_id
        ):
            raise ValidationError("Claim does not match its assignment.", code="assignment_mismatch")

    def clean(self):
        super().clean()
        # Advisory only (unlocked); services.create_claim is the authoritative check.
        from .services import validate_claim_capacity

        validate_claim_capacity(self.item, exclude_claim_id=self.pk)


class Pledge(RecipientExcludedMixin, TenantModel, Timestamped):
    family_scoped = ("item", "pledger")

    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name="pledges")
    pledger = models.ForeignKey(Person, on_delete=models.PROTECT, related_name="+")
    amount = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True, validators=[MinValueValidator(0)])

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["item", "pledger"], name="uniq_pledge_item_pledger"),
            models.CheckConstraint(
                condition=models.Q(amount__isnull=True) | models.Q(amount__gte=0), name="pledge_amount_non_negative"
            ),
        ]

    def validate_invariants(self):
        super().validate_invariants()
        self._reject_recipient(self.pledger_id)


class Assignment(TenantModel, Timestamped):
    class Status(models.TextChoices):
        ASSIGNED = "assigned"
        BOUGHT = "bought"
        COULDNT_GET = "couldnt_get"

    family_scoped = ("item", "assignee")

    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name="assignments")
    assignee = models.ForeignKey(Person, on_delete=models.PROTECT, related_name="+")
    assigner = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    status = models.CharField(max_length=20, choices=Status, default=Status.ASSIGNED)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["item", "assignee"], name="uniq_assignment_item_assignee"),
            models.UniqueConstraint(fields=["id", "item", "assignee"], name="uniq_assignment_id_item_assignee"),
            models.CheckConstraint(
                condition=models.Q(status__in=["assigned", "bought", "couldnt_get"]), name="assignment_status_valid"
            ),
        ]

    def validate_invariants(self):
        super().validate_invariants()
        if self.assignee_id == self.item.list.recipient_id:
            raise ValidationError("Cannot assign an item to its list's recipient.", code="assignee_is_recipient")


class TokenModel(TenantModel):
    """Credential rows store only the SHA-256 hex digest, so a database or backup leak
    yields no usable links. There is deliberately no raw-token field.
    """

    token_hash = models.CharField(max_length=64, unique=True, validators=[validate_token_hash])
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True
        constraints = [
            models.CheckConstraint(condition=models.Q(token_hash__regex=r"^[0-9a-f]{64}$"), name="%(class)s_hash_hex64"),
        ]

    def validate_invariants(self):
        super().validate_invariants()
        for name in ("token_hash", "expires_at"):
            self._meta.get_field(name).run_validators(getattr(self, name))

    def is_active(self, now=None):
        return self.revoked_at is None and self.expires_at > (now or timezone.now())


class GuestLink(TokenModel):
    family_scoped = ("person",)

    expires_at = models.DateTimeField(validators=[MaxLifetime(LINK_MAX_DAYS)])
    issued_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    person = models.ForeignKey(Person, on_delete=models.CASCADE, related_name="+")
    lists = models.ManyToManyField(WishList, through="GuestLinkList", related_name="+")

    class Meta(TokenModel.Meta):
        constraints = TokenModel.Meta.constraints + [
            models.UniqueConstraint(fields=["id", "family"], name="uniq_guestlink_id_family"),
        ]


class GuestLinkList(TenantModel):
    """Explicit through table so the guest's scope rows carry family_id too."""

    family_scoped = ("guest_link", "list")

    guest_link = models.ForeignKey(GuestLink, on_delete=models.CASCADE, related_name="+")
    list = models.ForeignKey(WishList, on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["guest_link", "list"], name="uniq_guestlinklist")]


class AssignmentLink(TokenModel):
    """Bound to the assignee Person: sees every assignment for that person in this family."""

    family_scoped = ("person",)

    expires_at = models.DateTimeField(validators=[MaxLifetime(LINK_MAX_DAYS)])
    issued_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    person = models.ForeignKey(Person, on_delete=models.CASCADE, related_name="+")


def default_invite_expiry():
    return timezone.now() + timedelta(days=INVITE_MAX_DAYS)


class Invite(TokenModel):
    family_scoped = ("person",)

    expires_at = models.DateTimeField(default=default_invite_expiry, validators=[MaxLifetime(INVITE_MAX_DAYS)])
    email = models.EmailField()
    role = models.CharField(max_length=20, choices=Membership.Role, default=Membership.Role.MEMBER)
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    used_at = models.DateTimeField(null=True, blank=True)
    # Existing user-less Person that accepting this invite links to a user.
    person = models.ForeignKey(Person, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta(TokenModel.Meta):
        constraints = TokenModel.Meta.constraints + [
            models.CheckConstraint(condition=models.Q(role__in=["family_admin", "member"]), name="invite_role_valid"),
        ]

    def is_active(self, now=None):
        return self.used_at is None and super().is_active(now)


class AuditLogQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise TypeError("AuditLog is append-only.")

    def delete(self):
        raise TypeError("AuditLog is append-only.")

    def bulk_update(self, *args, **kwargs):
        raise TypeError("AuditLog is append-only.")


RECIPIENT_REQUIRED_ACTIONS = ["claim", "release", "assign", "pledge"]


class AuditLog(TenantModel):
    """Append-only at the model layer so app code cannot rewrite history. Database
    privileges (INSERT/SELECT only for the app role) are the real guarantee and are
    left to the RLS/grants PR.

    Claim, release, assign and pledge rows must name the list's recipient so the
    recipient's own audit view can be excluded (surprise rule).
    """

    family_scoped = ("recipient_person",)

    class Action(models.TextChoices):
        CLAIM = "claim"
        RELEASE = "release"
        ASSIGN = "assign"
        PLEDGE = "pledge"
        INVITE = "invite"
        LINK_ISSUE = "link_issue"
        LINK_REVOKE = "link_revoke"
        ROLE_CHANGE = "role_change"
        LOGIN = "login"

    actor = models.ForeignKey(User, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    principal_type = models.CharField(max_length=32, null=True, blank=True)
    principal_id = models.PositiveBigIntegerField(null=True, blank=True)
    recipient_person = models.ForeignKey(Person, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    action = models.CharField(max_length=20, choices=Action)
    target_type = models.CharField(max_length=64, blank=True)
    target_id = models.PositiveBigIntegerField(null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True, validators=[validate_no_tokens])
    created_at = models.DateTimeField(auto_now_add=True)

    objects = AuditLogQuerySet.as_manager()

    class Meta:
        indexes = [models.Index(fields=["family", "-created_at"], name="auditlog_family_created")]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    action__in=[
                        "claim", "release", "assign", "pledge", "invite", "link_issue", "link_revoke", "role_change", "login",
                    ]
                ),
                name="auditlog_action_valid",
            ),
            models.CheckConstraint(
                condition=~models.Q(action__in=RECIPIENT_REQUIRED_ACTIONS) | models.Q(recipient_person__isnull=False),
                name="auditlog_recipient_required",
            ),
        ]

    def validate_invariants(self):
        super().validate_invariants()
        validate_no_tokens(self.metadata)

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise TypeError("AuditLog rows cannot be modified.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise TypeError("AuditLog rows cannot be deleted.")


class ClaimNotification(TenantModel):
    """Outbox: rows to notify a claimer that a claimed item changed. Ids are plain
    bigints (no FKs) so a row survives the claim or item being deleted.
    """

    claim_id = models.PositiveBigIntegerField(null=True, blank=True)
    item_id = models.PositiveBigIntegerField()
    claimer_id = models.PositiveBigIntegerField()
    kind = models.CharField(max_length=32)
    created_at = models.DateTimeField(auto_now_add=True)
    sent_at = models.DateTimeField(null=True, blank=True)
