"""Permission layer directly implementing docs/authz-matrix.yaml (CLAUDE.md).

Default is DENY. Global rules:
- G1: All family-scoped actions require same_family. Cross-family returns 404.
- G2: instance_admin is never same_family for content.
- G3: guest and assignment_link principals are denied after revocation/expiry.
"""

from django.core.exceptions import PermissionDenied
from django.http import Http404, HttpResponse, HttpResponseForbidden
from django.shortcuts import redirect

from apps.families.models import (
    GuestLink,
    GuestLinkList,
    Membership,
    Person,
)


def get_actor_context(request, family_id=None):
    """Determine the actor's role, person, and family affiliation."""
    principal = getattr(request, "principal", None)
    user = getattr(request, "user", None)

    # 1. Anonymous
    if not (user and user.is_authenticated):
        if principal and not principal.is_anonymous:
            # Guest or assignment link principal from session
            if family_id and principal.family_id != family_id:
                # G1 cross-family access
                return "cross_family", None, None

            if principal.type == "guest":
                link = GuestLink.objects.filter(id=principal.link_id).first()
                if not link or not link.is_active():
                    return "denied", None, None
                return "guest", link.person, principal.family_id

            if principal.type == "assignment_link":
                from apps.families.models import AssignmentLink
                link = AssignmentLink.objects.filter(id=principal.link_id).first()
                if not link or not link.is_active():
                    return "denied", None, None
                return "assignment_link", link.person, principal.family_id

        return "anonymous", None, None

    # 2. Authenticated user
    is_instance_admin = bool(user.is_superuser or user.is_staff)

    if family_id is None:
        if is_instance_admin:
            return "instance_admin", None, None
        return "user", None, None

    # Family-scoped check
    membership = Membership.objects.filter(family_id=family_id, user=user).first()
    if membership is None:
        if is_instance_admin:
            return "instance_admin", None, None
        # User does not belong to this family -> G1 cross-family 404
        return "cross_family", None, None

    person = Person.objects.filter(family_id=family_id, user=user).first()
    role = "family_admin" if membership.role == Membership.Role.FAMILY_ADMIN else "member"
    return role, person, family_id


def check_authz(rule, request, *, family_id=None, **targets):
    """Evaluate docs/authz-matrix.yaml rule against actor and targets.

    Returns:
        (True, 200) if allowed
        (False, 404) if cross-family or target not found (G1)
        (False, 401) if anonymous
        (False, 403) if denied by matrix or surprise rule
        (False, 400) if condition like not_last_admin rejected
    """
    role, actor_person, resolved_family_id = get_actor_context(request, family_id)

    # G1: Cross-family access returns 404
    if role == "cross_family":
        return False, 404

    # G2: instance_admin is never same_family for content
    CONTENT_RULES = (
        "list.view", "list.update", "list.delete",
        "item.view", "item.update", "item.delete",
        "claim.view", "claim.create", "claim.release",
        "pledge.view", "pledge.create", "pledge.update",
        "assignment.view", "assignment.mark_bought", "assignment.mark_couldnt_get",
        "assignment.cancel", "assignment.share_card",
        "audit_log.view",
    )
    if role == "instance_admin" and rule in CONTENT_RULES:
        return False, 404

    # Anonymous attempting restricted action
    if role == "anonymous" and rule not in ("invite.accept", "guest_link.exchange", "assignment_link.exchange"):
        return False, 401

    # --- Instance Rules ---
    if rule in ("family.create", "family.delete"):
        if role == "instance_admin":
            return True, 200
        return False, 403

    if rule in ("family.view_settings", "family.update_settings"):
        if role == "family_admin":
            return True, 200
        return False, 403

    # --- Invites ---
    if rule == "invite.create":
        if role == "family_admin":
            return True, 200
        return False, 403

    if rule == "invite.revoke":
        if role == "family_admin":
            return True, 200
        return False, 403

    if rule == "invite.accept":
        if role == "anonymous":
            return True, 200
        return False, 403

    # --- Members ---
    if rule == "member.list":
        if role in ("family_admin", "member"):
            return True, 200
        return False, 403

    if rule in ("member.remove", "member.change_role"):
        if role != "family_admin":
            return False, 403
        target_member = targets.get("member")
        if target_member and target_member.role == "family_admin":
            # Check not_last_admin
            admin_count = Membership.objects.filter(
                family_id=resolved_family_id, role="family_admin"
            ).count()
            if admin_count <= 1:
                return False, 400  # rejected
        return True, 200

    if rule == "member.leave":
        if role not in ("family_admin", "member"):
            return False, 403
        target_member = targets.get("member")
        if not target_member or target_member.user_id != request.user.id:
            return False, 403  # is_self required
        if target_member.role == "family_admin":
            admin_count = Membership.objects.filter(
                family_id=resolved_family_id, role="family_admin"
            ).count()
            if admin_count <= 1:
                return False, 400  # not_last_admin required
        return True, 200

    # --- Guest Links ---
    if rule == "guest_link.issue":
        if role in ("family_admin", "member"):
            return True, 200
        return False, 403

    if rule == "guest_link.revoke":
        if role == "family_admin":
            return True, 200
        if role == "member":
            guest_link = targets.get("guest_link")
            if guest_link and guest_link.issued_by_id == request.user.id:
                return True, 200
        return False, 403

    # --- Lists ---
    if rule == "list.create":
        if role in ("family_admin", "member"):
            return True, 200
        return False, 403

    if rule == "list.view":
        target_list = targets.get("list")
        if role in ("family_admin", "member"):
            return True, 200
        if role == "guest" and target_list:
            principal = getattr(request, "principal", None)
            if GuestLinkList.objects.filter(guest_link_id=principal.link_id, list_id=target_list.id).exists():
                return True, 200
        return False, 403

    if rule in ("list.update", "list.delete"):
        target_list = targets.get("list")
        if role == "family_admin":
            return True, 200
        if role == "member" and target_list:
            if target_list.created_by_id == request.user.id or (target_list.managed_by_id and target_list.managed_by_id == request.user.id):
                return True, 200
        return False, 403

    # --- Items ---
    if rule == "item.view":
        target_item = targets.get("item")
        if role in ("family_admin", "member"):
            return True, 200
        if role == "guest" and target_item:
            principal = getattr(request, "principal", None)
            if GuestLinkList.objects.filter(guest_link_id=principal.link_id, list_id=target_item.list_id).exists():
                return True, 200
        return False, 403

    if rule in ("item.create", "item.update", "item.delete"):
        target_list = targets.get("list") or (targets.get("item").list if targets.get("item") else None)
        if role == "family_admin":
            return True, 200
        if role == "member" and target_list:
            if target_list.created_by_id == request.user.id or (target_list.managed_by_id and target_list.managed_by_id == request.user.id):
                return True, 200
        return False, 403

    # --- Claims (Surprise rule applies) ---
    if rule in ("claim.view", "claim.create", "claim.release"):
        target_item = targets.get("item") or (targets.get("claim").item if targets.get("claim") else None)
        if not target_item:
            return False, 404

        # Surprise rule: recipient is denied
        recipient_person_id = target_item.list.recipient_id
        if actor_person and actor_person.id == recipient_person_id:
            return False, 403

        if role == "guest":
            principal = getattr(request, "principal", None)
            if not GuestLinkList.objects.filter(guest_link_id=principal.link_id, list_id=target_item.list_id).exists():
                return False, 403

        if rule == "claim.view":
            if role in ("family_admin", "member", "guest"):
                return True, 200
            return False, 403

        if rule == "claim.create":
            if role in ("family_admin", "member", "guest"):
                return True, 200
            return False, 403

        if rule == "claim.release":
            target_claim = targets.get("claim")
            if role == "family_admin":
                return True, 200
            if target_claim and actor_person and target_claim.claimer_id == actor_person.id:
                return True, 200
            return False, 403

    # --- Pledges (Surprise rule applies) ---
    if rule in ("pledge.view", "pledge.create", "pledge.update"):
        target_item = targets.get("item") or (targets.get("pledge").item if targets.get("pledge") else None)
        if not target_item:
            return False, 404

        recipient_person_id = target_item.list.recipient_id
        if actor_person and actor_person.id == recipient_person_id:
            return False, 403

        if role == "guest":
            principal = getattr(request, "principal", None)
            if not GuestLinkList.objects.filter(guest_link_id=principal.link_id, list_id=target_item.list_id).exists():
                return False, 403

        if rule == "pledge.view":
            if role in ("family_admin", "member", "guest"):
                return True, 200
            return False, 403

        if rule == "pledge.create":
            if role in ("family_admin", "member", "guest"):
                return True, 200
            return False, 403

        if rule == "pledge.update":
            target_pledge = targets.get("pledge")
            if target_pledge and actor_person and target_pledge.pledger_id == actor_person.id:
                return True, 200
            return False, 403

    # --- Assignments (Surprise rule applies) ---
    if rule == "assignment.create":
        target_item = targets.get("item")
        if not target_item:
            return False, 404
        recipient_person_id = target_item.list.recipient_id
        if actor_person and actor_person.id == recipient_person_id:
            return False, 403
        assignee_person = targets.get("assignee")
        if assignee_person and assignee_person.id == recipient_person_id:
            return False, 400
        if role in ("family_admin", "member"):
            return True, 200
        return False, 403

    if rule == "assignment.view":
        target_assignment = targets.get("assignment")
        if not target_assignment:
            return False, 404
        recipient_person_id = target_assignment.item.list.recipient_id
        if actor_person and actor_person.id == recipient_person_id:
            return False, 403
        if role in ("family_admin", "member"):
            return True, 200
        if role == "assignment_link" and actor_person and target_assignment.assignee_id == actor_person.id:
            return True, 200
        return False, 403

    if rule in ("assignment.mark_bought", "assignment.mark_couldnt_get"):
        target_assignment = targets.get("assignment")
        if not target_assignment:
            return False, 404
        if role == "family_admin":
            return True, 200
        if role == "member" and target_assignment.assigner_id == request.user.id:
            return True, 200
        if role == "assignment_link" and actor_person and target_assignment.assignee_id == actor_person.id:
            return True, 200
        return False, 403

    if rule in ("assignment.cancel", "assignment.share_card"):
        target_assignment = targets.get("assignment")
        if not target_assignment:
            return False, 404
        if role == "family_admin":
            return True, 200
        if role == "member" and target_assignment.assigner_id == request.user.id:
            return True, 200
        return False, 403

    # --- Audit Log ---
    if rule == "audit_log.view":
        if role == "family_admin":
            return True, 200
        return False, 403

    # Default deny
    return False, 403


def require_authz(rule, get_family_id=None, get_targets=None):
    """Decorator for views enforcing authz matrix rule."""
    def decorator(view_func):
        def wrapper(request, *args, **kwargs):
            family_id = kwargs.get("family_id") or kwargs.get("family")
            if get_family_id:
                family_id = get_family_id(request, *args, **kwargs)

            targets = {}
            if get_targets:
                targets = get_targets(request, *args, **kwargs)

            allowed, status_code = check_authz(rule, request, family_id=family_id, **targets)
            if not allowed:
                if status_code == 404:
                    raise Http404()
                if status_code == 401:
                    return redirect("account_login")
                if status_code == 400:
                    return HttpResponse("Action rejected", status=400)
                return HttpResponseForbidden("Access denied")

            return view_func(request, *args, **kwargs)

        wrapper.__name__ = view_func.__name__
        wrapper.__doc__ = view_func.__doc__
        return wrapper

    return decorator
