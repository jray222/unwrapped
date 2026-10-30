from datetime import timedelta

from django.core.exceptions import ValidationError
from django.core.validators import RegexValidator, URLValidator
from django.utils import timezone
from django.utils.deconstruct import deconstructible

validate_token_hash = RegexValidator(
    r"^[0-9a-f]{64}$", "Must be a lowercase hex SHA-256 digest.", code="invalid_token_hash"
)
validate_http_url = URLValidator(schemes=["http", "https"])


@deconstructible
class MaxLifetime:
    """Rejects expiry timestamps further than `days` from now."""

    def __init__(self, days):
        self.days = days

    def __call__(self, value):
        if value > timezone.now() + timedelta(days=self.days):
            raise ValidationError(f"Expiry may be at most {self.days} days away.", code="expiry_too_far")

    def __eq__(self, other):
        return isinstance(other, MaxLifetime) and other.days == self.days


def validate_no_tokens(value):
    """Audit metadata must never carry credentials."""
    items = value.items() if isinstance(value, dict) else enumerate(value) if isinstance(value, list) else ()
    for key, nested in items:
        if isinstance(key, str) and "token" in key.lower():
            raise ValidationError("Audit metadata must not contain tokens.", code="token_in_metadata")
        validate_no_tokens(nested)
