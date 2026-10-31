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
    path("welcome", family_views.welcome, name="welcome"),
    path("accounts/", include("allauth.urls")),
]
