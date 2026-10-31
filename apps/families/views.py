"""Exchange endpoints and the post-exchange landing page (CLAUDE.md rule 7).

A link is a bearer token in a URL. Icons of hygiene here:

- The first visit to the link exchange URL is GET-only and anonymous-only; it
  validates the raw token against the database (definer function), writes the
  link principal (ids, not credentials) into the session, rotates the session
  id, and 302s to a clean URL. The redirect never carries the token, so it
  cannot leak into a page body, a log, or a Referer header afterwards.
- No failures here touch the session: an invalid, revoked, expired or
  already-used-nowhere token leaves no cookie behind, so a probe of a guessed
  URL is indistinguishable from "not registered" and creates zero state.
- Nothing in this module logs tokens, full URLs, or bodies: the framework's
  request logging would carry the URL, so failures are returned as plain
  HttpResponse instead of raised as Http404.

Matrix rules link these surfaces to anonymous principals only; a signed-in
user must sign out before using an access link (two principals in one session
would let a member ride a guest's scope, and nobody has a use case).
"""

import json

from django.contrib.auth import get_user_model
from django.db import transaction
from django.http import HttpResponse, HttpResponseForbidden
from django.shortcuts import redirect, render
from django.views.decorators.http import require_POST, require_safe

from apps.authz.link_session import save_link_principal
from . import tokens


@require_safe
def exchange_guest_link(request, token):
    return _exchange(request, tokens.GUEST, token)


@require_safe
def exchange_assignment_link(request, token):
    return _exchange(request, tokens.ASSIGNMENT_LINK, token)


def _exchange(request, kind, raw_token):
    if request.user.is_authenticated:
        return HttpResponseForbidden("sign out before using an access link")
    found = tokens.exchange_link_token(kind, raw_token)
    if found is None:
        # No DB state, no cookie, no detail about which of the failure reasons
        # applied, and nothing worth logging (the token in this URL's path
        # reached us only through this response path; we answer and forget).
        return HttpResponse("", status=404)
    family_id, link_id = found
    save_link_principal(request, kind, family_id, link_id)
    # 302 to a URL that does not contain the token (rule 7): the browser goes
    # to the landing page, and the token never appears in a Referer header on
    # any outgoing request the landing page may make.
    return redirect("welcome")


@require_safe
def welcome(request):
    """Landing page for an exchanged link principal (or anyone else).

    Deliberately static content: family data arrives with the family-view PRs
    through permission-checked views, never here. The two messages differ only
    in what a principal could already learn about itself; no family, no token,
    no link details are rendered.
    """
    principal = getattr(request, "principal", None)
    link_active = principal is not None and not principal.is_anonymous
    return render(request, "welcome.html", {"link_active": link_active})


@require_POST
def invite_accept(request):
    """Accept an invite to join a family (single use, anonymous only)."""
    if request.user.is_authenticated:
        return HttpResponseForbidden("sign out before accepting an invite")

    try:
        if request.content_type == "application/json":
            payload = json.loads(request.body)
        else:
            payload = request.POST
    except Exception:
        return HttpResponse("", status=400)

    raw_token = payload.get("token")
    email = payload.get("email")
    if not raw_token or not email:
        return HttpResponse("", status=400)

    with transaction.atomic():
        User = get_user_model()
        user = User.objects.filter(email__iexact=email).first()
        if user is None:
            base = email.split("@")[0] or "user"
            username = base
            counter = 1
            while User.objects.filter(username=username).exists():
                username = f"{base}_{counter}"
                counter += 1
            user = User.objects.create_user(username=username, email=email, password=None)

        accepted = tokens.accept_invite(raw_token, email, user.pk)
        if not accepted:
            transaction.set_rollback(True)
            return HttpResponse("", status=400)

    return redirect("account_login")
