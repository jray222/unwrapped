"""Log filters ensuring sensitive credentials are never logged (CLAUDE.md rule 7)."""

import logging
import re

# secrets.token_urlsafe(32) produces 43 chars of [A-Za-z0-9_-].
# Any bearer token (guest link, assignment link, invite) matches this pattern.
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")


class TokenSanitizingFilter(logging.Filter):
    """Ensure tokens never appear in logs or full URLs logged by the framework."""

    def filter(self, record):
        if isinstance(record.msg, str):
            record.msg = TOKEN_PATTERN.sub("<token>", record.msg)
        if record.args:
            record.args = tuple(
                TOKEN_PATTERN.sub("<token>", a) if isinstance(a, str) else a
                for a in record.args
            )
        return True
