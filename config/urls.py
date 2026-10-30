from django.http import JsonResponse
from django.urls import path
from django.views.decorators.http import require_safe


@require_safe
def healthz(request):
    # The only public view. Returns no data about the system.
    return JsonResponse({"status": "ok"})


urlpatterns = [
    path("healthz", healthz, name="healthz"),
]
