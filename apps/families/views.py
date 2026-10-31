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
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import transaction
from django.http import (
    Http404,
    HttpResponse,
    HttpResponseForbidden,
    HttpResponseNotAllowed,
    JsonResponse,
)
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_POST, require_safe

from apps.authz.link_session import save_link_principal
from apps.authz.permissions import check_authz
from . import tokens
from .models import (
    Family,
    GuestLink,
    GuestLinkList,
    Invite,
    LINK_MAX_DAYS,
    Membership,
    Person,
    WishList,
)


@require_safe
def exchange_guest_link(request, token):
    return _exchange(request, tokens.GUEST, token)


@require_safe
def exchange_assignment_link(request, token):
    return _exchange(request, tokens.ASSIGNMENT_LINK, token)


def _exchange(request, kind, raw_token):
    principal = getattr(request, "principal", None)
    if request.user.is_authenticated or (principal and not principal.is_anonymous):
        return HttpResponseForbidden("sign out before using an access link")
    found = tokens.exchange_link_token(kind, raw_token)
    if found is None:
        return HttpResponse("", status=404)
    family_id, link_id = found
    save_link_principal(request, kind, family_id, link_id)
    return redirect("welcome")


def _authz_error(status):
    if status == 404:
        raise Http404()
    if status == 401:
        return redirect("account_login")
    if status == 400:
        return HttpResponse("Action rejected", status=400)
    return HttpResponseForbidden("Access denied")


def _parse_body(request):
    try:
        if request.content_type == "application/json" and request.body:
            return json.loads(request.body)
        return request.POST
    except Exception:
        return {}


def family_create(request):
    allowed, status = check_authz("family.create", request)
    if not allowed:
        return _authz_error(status)
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    payload = _parse_body(request)
    name = payload.get("name")
    if not name:
        return JsonResponse({"error": "name required"}, status=400)
    fam = Family.objects.create(name=name)
    return JsonResponse({"id": fam.id, "name": fam.name}, status=201)


def family_detail(request, family):
    fam_id = int(family)
    if request.method == "DELETE":
        allowed, status = check_authz("family.delete", request, family_id=fam_id)
        if not allowed:
            return _authz_error(status)
        fam = get_object_or_404(Family, id=fam_id)
        with transaction.atomic():
            from django.db import connection
            with connection.cursor() as cursor:
                cursor.execute("SET session_replication_role = replica")
                for tbl in [
                    "families_pledge",
                    "families_assignment",
                    "families_claim",
                    "families_claimnotification",
                    "families_item",
                    "families_guestlinklist",
                    "families_guestlink",
                    "families_assignmentlink",
                    "families_wishlist",
                    "families_invite",
                    "families_auditlog",
                    "families_person",
                    "families_membership",
                    "families_family",
                ]:
                    if tbl == "families_family":
                        cursor.execute(f"DELETE FROM {tbl} WHERE id = %s", [fam_id])
                    else:
                        cursor.execute(f"DELETE FROM {tbl} WHERE family_id = %s", [fam_id])
                cursor.execute("SET session_replication_role = origin")
        return HttpResponse(status=204)
    return HttpResponseNotAllowed(["DELETE"])


def family_settings(request, family):
    fam_id = int(family)
    if request.method == "GET":
        allowed, status = check_authz("family.view_settings", request, family_id=fam_id)
        if not allowed:
            return _authz_error(status)
        fam = get_object_or_404(Family, id=fam_id)
        return JsonResponse({"id": fam.id, "name": fam.name})
    elif request.method in ("PATCH", "PUT"):
        allowed, status = check_authz("family.update_settings", request, family_id=fam_id)
        if not allowed:
            return _authz_error(status)
        fam = get_object_or_404(Family, id=fam_id)
        payload = _parse_body(request)
        if "name" in payload:
            fam.name = payload["name"]
            fam.save(update_fields=["name"])
        return JsonResponse({"id": fam.id, "name": fam.name})
    return HttpResponseNotAllowed(["GET", "PATCH", "PUT"])


def invite_create(request, family):
    fam_id = int(family)
    allowed, status = check_authz("invite.create", request, family_id=fam_id)
    if not allowed:
        return _authz_error(status)
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    payload = _parse_body(request)
    email = payload.get("email")
    if not email:
        return JsonResponse({"error": "email required"}, status=400)
    fam = get_object_or_404(Family, id=fam_id)
    raw_token = tokens.new_token()
    invite = Invite.objects.create(
        family=fam,
        created_by=request.user,
        email=email,
        token_hash=tokens.hash_token(raw_token),
        expires_at=timezone.now() + timedelta(days=7),
    )
    return JsonResponse({"id": invite.id, "email": invite.email, "token": raw_token}, status=201)


def invite_revoke(request, invite):
    invite_id = int(invite)
    inv = get_object_or_404(Invite, id=invite_id)
    allowed, status = check_authz("invite.revoke", request, family_id=inv.family_id, invite=inv)
    if not allowed:
        return _authz_error(status)
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    inv.revoked_at = timezone.now()
    inv.save(update_fields=["revoked_at"])
    return JsonResponse({"status": "revoked"})


def member_list(request, family):
    fam_id = int(family)
    allowed, status = check_authz("member.list", request, family_id=fam_id)
    if not allowed:
        return _authz_error(status)
    if request.method != "GET":
        return HttpResponseNotAllowed(["GET"])
    memberships = Membership.objects.filter(family_id=fam_id).select_related("user")
    persons = {p.user_id: p.first_name for p in Person.objects.filter(family_id=fam_id, user__isnull=False)}
    data = [
        {
            "id": m.id,
            "user_id": m.user_id,
            "role": m.role,
            "first_name": persons.get(m.user_id, ""),
            "name": persons.get(m.user_id, ""),
        }
        for m in memberships
    ]
    return JsonResponse({"members": data})


def member_detail(request, member):
    mem_id = int(member)
    mem = get_object_or_404(Membership, id=mem_id)
    if request.method == "DELETE":
        allowed, status = check_authz("member.remove", request, family_id=mem.family_id, member=mem)
        if not allowed:
            return _authz_error(status)
        mem.delete()
        return HttpResponse(status=204)
    elif request.method in ("PATCH", "PUT"):
        allowed, status = check_authz("member.change_role", request, family_id=mem.family_id, member=mem)
        if not allowed:
            return _authz_error(status)
        payload = _parse_body(request)
        new_role = payload.get("role")
        if new_role in ("family_admin", "member"):
            if mem.role == "family_admin" and new_role == "member":
                other_admins = (
                    Membership.objects.filter(family_id=mem.family_id, role="family_admin")
                    .exclude(id=mem.id)
                    .count()
                )
                if other_admins == 0:
                    return HttpResponse("Action rejected", status=400)
            mem.role = new_role
            mem.save(update_fields=["role"])
        return JsonResponse({"id": mem.id, "role": mem.role})
    return HttpResponseNotAllowed(["DELETE", "PATCH"])


def member_leave(request, member):
    mem_id = int(member)
    mem = get_object_or_404(Membership, id=mem_id)
    allowed, status = check_authz("member.leave", request, family_id=mem.family_id, member=mem)
    if not allowed:
        return _authz_error(status)
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    mem.delete()
    return HttpResponse(status=204)


def guest_link_create(request, family):
    fam_id = int(family)
    allowed, status = check_authz("guest_link.issue", request, family_id=fam_id)
    if not allowed:
        return _authz_error(status)
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    payload = _parse_body(request)
    fam = get_object_or_404(Family, id=fam_id)

    raw_person = payload.get("person")
    if not raw_person:
        return JsonResponse({"error": "person required"}, status=400)

    try:
        person_obj = Person.objects.get(id=int(raw_person), family=fam)
    except (ValueError, TypeError, Person.DoesNotExist):
        person_obj = Person.objects.create(family=fam, first_name=str(raw_person))

    days = payload.get("expires_in_days", 30)
    try:
        days = min(int(days), LINK_MAX_DAYS)
    except (ValueError, TypeError):
        days = 30

    raw_token = tokens.new_token()
    link = GuestLink.objects.create(
        family=fam,
        issued_by=request.user,
        person=person_obj,
        token_hash=tokens.hash_token(raw_token),
        expires_at=timezone.now() + timedelta(days=days),
    )

    list_ids = payload.get("lists", [])
    for lid in list_ids:
        try:
            target_l = WishList.objects.get(id=int(lid), family=fam)
            GuestLinkList.objects.create(family=fam, guest_link=link, list=target_l)
        except (ValueError, TypeError, WishList.DoesNotExist):
            return _authz_error(404)

    return JsonResponse(
        {"id": link.id, "token": raw_token, "expires_in_days": days},
        status=201,
    )


def guest_link_revoke(request, guest_link):
    link_id = int(guest_link)
    link = get_object_or_404(GuestLink, id=link_id)
    allowed, status = check_authz("guest_link.revoke", request, family_id=link.family_id, guest_link=link)
    if not allowed:
        return _authz_error(status)
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    link.revoked_at = timezone.now()
    link.save(update_fields=["revoked_at"])
    return JsonResponse({"status": "revoked"})


def list_create(request, family):
    fam_id = int(family)
    allowed, status = check_authz("list.create", request, family_id=fam_id)
    if not allowed:
        return _authz_error(status)
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    payload = _parse_body(request)
    title = payload.get("title")
    recip_id = payload.get("recipient")
    if not title or not recip_id:
        return JsonResponse({"error": "title and recipient required"}, status=400)
    fam = get_object_or_404(Family, id=fam_id)
    try:
        recip = Person.objects.get(id=int(recip_id), family=fam)
    except (ValueError, TypeError, Person.DoesNotExist):
        return _authz_error(404)
    lst = WishList.objects.create(family=fam, recipient=recip, created_by=request.user, title=title)
    return JsonResponse({"id": lst.id, "title": lst.title, "recipient": lst.recipient_id}, status=201)


def list_detail(request, list):
    list_id = int(list)
    lst = get_object_or_404(WishList, id=list_id)
    if request.method == "GET":
        allowed, status = check_authz("list.view", request, family_id=lst.family_id, list=lst)
        if not allowed:
            return _authz_error(status)
        return JsonResponse({"id": lst.id, "title": lst.title, "recipient": lst.recipient_id})
    elif request.method in ("PATCH", "PUT"):
        allowed, status = check_authz("list.update", request, family_id=lst.family_id, list=lst)
        if not allowed:
            return _authz_error(status)
        payload = _parse_body(request)
        if "title" in payload:
            lst.title = payload["title"]
            lst.save(update_fields=["title"])
        return JsonResponse({"id": lst.id, "title": lst.title, "recipient": lst.recipient_id})
    elif request.method == "DELETE":
        allowed, status = check_authz("list.delete", request, family_id=lst.family_id, list=lst)
        if not allowed:
            return _authz_error(status)
        lst.delete()
        return HttpResponse(status=204)
    return HttpResponseNotAllowed(["GET", "PATCH", "DELETE"])


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
    principal = getattr(request, "principal", None)
    if request.user.is_authenticated or (principal and not principal.is_anonymous):
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
