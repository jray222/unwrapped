"""A minimal fixed-window rate limiter for the anonymous token surfaces.

CLAUDE.md rule 10: rate limits on login, MFA, and token endpoints. allauth
limits its own login attempts; the exchange endpoints and invite-accept need
their own. No third-party dependency: Django's cache framework holds the
counter. The default locmem cache is per-process, so the effective limit is
(per worker window) — deliberate: this is a DoS floor, not an abuse ledger, and
a shared cache (Redis, Memcached) can be swapped in via CACHES without
changing call sites.

Counts are per client IP plus the URL route name, with a generous window so
that normal navigation and the test suite never trip it.
"""

import functools

from django.core.cache import cache
from django.http import HttpResponse

WINDOW_SECONDS = 60
DEFAULT_LIMIT = 120


def ratelimit(scope, limit=None):
    """Return a decorator applying the limit per remote address.

    Applied to views whose URL carries a bearer token or takes one in a body.
    Failures count like successes: an abusive or broken client is not invited
    to hammer the token-validation path harder its errors.
    """
    if limit is None:
        limit = DEFAULT_LIMIT

    def decorator(view):
        @functools.wraps(view)
        def wrapped(request, *args, **kwargs):
            ip_addr = request.META.get("REMOTE_ADDR", "") or "unknown"
            key = f"rl:{scope}:{request.resolver_match.url_name}:{ip_addr}"
            # cache.add only sets when absent, so the first hit in a window
            # determines the TTL: no window without expiry even while firing.
            if cache.add(key, 1, WINDOW_SECONDS):
                hits = 1
            else:
                hits = cache.incr(key)
            if hits > limit:
                return HttpResponse("Too Many Requests", status=429)
            return view(request, *args, **kwargs)

        return wrapped

    return decorator
