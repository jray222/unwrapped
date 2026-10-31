from dataclasses import dataclass

from django.core.exceptions import ImproperlyConfigured
from django.db import transaction

from .db import apply_rls_settings, rls_context
from .link_session import drop_link_principal, read_link_principal


@dataclass(frozen=True)
class Principal:
    """Who the database believes is acting. This is NOT request.user: it is what was
    written to the app.* settings, and the only identity the RLS policies ever see.
    """

    type: str | None = None  # None = anonymous
    user_id: int | None = None
    family_id: int | None = None
    # Link principals only: the exchanged link behind this session, so views can
    # address the credential (e.g. its own revoke endpoint) without re-deriving it.
    link_id: int | None = None

    @property
    def is_anonymous(self):
        return self.type is None


ANONYMOUS = Principal()


def resolve_principal(request, view_kwargs):
    """Resolve the principal for this request and apply the RLS settings.

    Two principal shapes exist:

    - An authenticated, active Django user (type 'user'), with the family taken
      from a URL `family_id` kwarg (always an <int:family_id> converter). RLS,
      not this code, decides whether that user belongs to that family: a
      non-member gets zero rows. The family role is deliberately never passed
      to the database.
    - A guest or assignment-link principal from the session, exchanged once
      from a raw URL token (apps/authz/link_session.py). The family comes ONLY
      from the exchanged link, never from the URL: link URLs carry no family
      segment, and a URL-supplied family_id for a link principal would be
      attacker-chosen. Link validity (revocation, expiry) is re-checked in the
      database here, and again per statement by the RLS policy functions, so a
      stale session grants nothing (tenant isolation twice).

    An authenticated user wins over a link that happens to sit in the same
    session (the link data is dropped, so logging out cannot silently revive a
    member's old guest session). Other principals (instance admins) arrive with
    the permission-layer PR; today they stay anonymous (fail closed).
    """
    if getattr(request, "_rls_principal_resolved", False):
        raise RuntimeError("RLS principal resolved twice")
    request._rls_principal_resolved = True

    user = request.user
    if user.is_authenticated and user.is_active:
        drop_link_principal(request)  # an authenticated principal outranks any link
        family_id = view_kwargs.get("family_id")
        if family_id is not None and not (type(family_id) is int and family_id > 0):
            return ANONYMOUS
        apply_rls_settings(family_id, "user", user.pk)
        return Principal(type="user", user_id=user.pk, family_id=family_id)

    stored = read_link_principal(request)  # None for anonymous requests anyway
    if stored is None:
        return ANONYMOUS
    kind, family_id, link_id = stored

    from apps.families import tokens  # imported late: keep the app layers independent

    if not tokens.link_is_active(kind, link_id):
        # Revoked or expired: the session no longer carries a credential, and
        # the next request skips the probe. Nothing else changes: this response
        # simply renders as anonymous (the policies would deny anyway).
        drop_link_principal(request)
        return ANONYMOUS

    apply_rls_settings(family_id, kind, link_id)
    # family_id in view_kwargs is deliberately ignored for link principals: the
    # link row (and below it, the policies) is the authority for the family.
    return Principal(type=kind, family_id=family_id, link_id=link_id)


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
