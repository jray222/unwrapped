"""I4 (mfa_gate): a local account without enrolled MFA reaches only MFA enrollment
and logout.

"Local account" means a user that signs in with a password (has_usable_password);
Google accounts arrive with no usable password and are not gated here (their MFA
requirement is part of the socialaccount PR). The allow list is URL NAME based so
it does not depend on where views are mounted, and contains only:
  - healthz: reachable for probes, reveals no data
  - the allauth MFA URLs (enrollment, authentication, recovery codes)
  - logout
  - the login page (only while anonymous; once authenticated that view redirects)

Every other URL redirects to mfa_index, so the gate is default deny for the home
page and every future endpoint. Anonymous requests are left alone: endpoints must
declare their own permissions ("no view without a permission class/decorator"),
and redirecting them to a mandatory MFA page would suggest that any guessable
account exists.
"""

from django import http
from django.urls import Resolver404, resolve, reverse

ALLOWED_URL_NAMES = (
    "healthz",
    "account_logout",
    "account_login",
)
MFA_URL_PREFIX = "mfa"


def _enrolled(user):
    from allauth.mfa.models import Authenticator

    return Authenticator.objects.filter(user=user).exists()


def _allowed(url_name):
    return url_name.startswith(MFA_URL_PREFIX) or url_name in ALLOWED_URL_NAMES


class MfaGateMiddleware:
    """Runs after AuthenticationMiddleware and before RlsContextMiddleware:
    a gated request must never reach a view that opens the RLS transaction.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user = getattr(request, "user", None)
        if (
            user is not None
            and user.is_authenticated
            and user.has_usable_password()  # local account
            and not _enrolled(user)
            and not _allowed(self._url_name(request))
        ):
            return http.HttpResponseRedirect(reverse("mfa_index"))
        return self.get_response(request)

    @staticmethod
    def _url_name(request):
        # Middleware runs before URL resolution, and the gate authorizes by
        # URL name; resolve the matching pattern ourselves. An unresolvable
        # path is not in the allow list, but letting it through is fine:
        # Django will produce the regular 404 with security headers.
        try:
            match = resolve(request.path)
        except Resolver404:
            return ""
        return match.url_name or ""
