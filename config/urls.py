from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import render
from django.urls import include, path
from django.views.decorators.http import require_safe


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
    path("accounts/", include("allauth.urls")),
]
