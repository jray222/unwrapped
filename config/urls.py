from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import render
from django.urls import include, path, register_converter
from django.views.decorators.http import require_safe

from apps.families import views as family_views


class TokenConverter:
    """Link tokens: exactly what secrets.token_urlsafe(32) produces. Anything
    else falls through to 404 before the token handling code even runs.
    """

    regex = "[A-Za-z0-9_-]{43}"

    def to_python(self, value):
        return value

    def to_url(self, value):
        return value


register_converter(TokenConverter, "token")


@require_safe
def healthz(request):
    # The only public view. Returns no data about the system.
    return JsonResponse({"status": "ok"})


@login_required
def home(request):
    """Landing page for signed-in principals. Deliberately user-scoped only:
    family content arrives with the family PRs, through permission-checked
    views, never here. The MFA gate (apps/authz/mfa_gate.py) holds a local
    account without enrolled MFA away from this view: login_required only
    keeps out the anonymous.
    """
    return render(request, "home.html")


urlpatterns = [
    path("healthz", healthz, name="healthz"),
    path("", home, name="home"),
    # Token exchange (rule 7): GET, anonymous-only, 302 to the clean landing
    # page. The token never appears outside its one request.
    path("links/guest/<token:token>", family_views.exchange_guest_link, name="guest-link-exchange"),
    path("links/assignment/<token:token>", family_views.exchange_assignment_link, name="assignment-link-exchange"),
    path("invites/accept", family_views.invite_accept, name="invite-accept"),
    path("families", family_views.family_create, name="family-create"),
    path("families/<int:family>", family_views.family_detail, name="family-detail"),
    path("families/<int:family>/settings", family_views.family_settings, name="family-settings"),
    path("families/<int:family>/invites", family_views.invite_create, name="invite-create"),
    path("invites/<int:invite>/revoke", family_views.invite_revoke, name="invite-revoke"),
    path("families/<int:family>/members", family_views.member_list, name="member-list"),
    path("members/<int:member>", family_views.member_detail, name="member-detail"),
    path("members/<int:member>/leave", family_views.member_leave, name="member-leave"),
    path("families/<int:family>/guest-links", family_views.guest_link_create, name="guest-link-create"),
    path("guest-links/<int:guest_link>/revoke", family_views.guest_link_revoke, name="guest-link-revoke"),
    path("families/<int:family>/lists", family_views.list_create, name="list-create"),
    path("lists/<int:list>", family_views.list_detail, name="list-detail"),
    path("lists/<int:list>/items", family_views.item_create, name="item-create"),
    path("items/<int:item>", family_views.item_detail, name="item-detail"),
    path("welcome", family_views.welcome, name="welcome"),
    path("accounts/", include("allauth.urls")),
]
