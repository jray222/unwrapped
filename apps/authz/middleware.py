from dataclasses import dataclass

from django.core.exceptions import ImproperlyConfigured
from django.db import transaction

from .db import apply_rls_settings, rls_context


@dataclass(frozen=True)
class Principal:
    """Who the database believes is acting. This is NOT request.user: it is what was
    written to the app.* settings, and the only identity the RLS policies ever see.
    """

    type: str | None = None  # None = anonymous
    user_id: int | None = None
    family_id: int | None = None

    @property
    def is_anonymous(self):
        return self.type is None


ANONYMOUS = Principal()


def resolve_principal(request, view_kwargs):
    """Minimal principal resolution; applies the RLS settings for this request.

    Only an authenticated, active Django user becomes a principal (type 'user'), with the
    family taken from a URL `family_id` kwarg (always an <int:family_id> converter). RLS,
    not this code, decides whether that user belongs to that family: a non-member gets
    zero rows. The family role is deliberately never passed to the database.

    NOT resolved yet, so these requests stay anonymous and see nothing (fail closed):
    guest links, assignment links, instance admins, and the MFA gate. They arrive with
    the token-exchange and permission-layer PRs.
    """
    if getattr(request, "_rls_principal_resolved", False):
        raise RuntimeError("RLS principal resolved twice")
    request._rls_principal_resolved = True

    user = request.user
    if not (user.is_authenticated and user.is_active):
        return ANONYMOUS
    family_id = view_kwargs.get("family_id")
    if family_id is not None and not (type(family_id) is int and family_id > 0):
        return ANONYMOUS
    apply_rls_settings(family_id, "user", user.pk)
    return Principal(type="user", user_id=user.pk, family_id=family_id)


class RlsContextMiddleware:
    """One transaction per request, with the RLS settings applied inside it.

    Must sit after AuthenticationMiddleware. process_view runs inside the handler, so the
    principal settings are applied inside this transaction. Keep ATOMIC_REQUESTS off: its
    atomic wraps only the view, after process_view has already run.

    Django turns a view exception into a 500 response *before* it reaches this middleware,
    so a plain atomic() would commit half-finished writes. Roll back on any status >= 400.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        with rls_context():  # explicit anonymous baseline; asserts no leaked settings
            request.principal = ANONYMOUS
            response = self.get_response(request)
            if getattr(response, "streaming", False):
                # The body would be produced after the transaction (and settings) are gone.
                raise ImproperlyConfigured("streaming responses escape the RLS transaction")
            if response.status_code >= 400:
                transaction.set_rollback(True)
        return response

    def process_view(self, request, view_func, view_args, view_kwargs):
        request.principal = resolve_principal(request, view_kwargs)
        return None
