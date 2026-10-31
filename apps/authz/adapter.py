from allauth.account.adapter import DefaultAccountAdapter


class AccountAdapter(DefaultAccountAdapter):
    """Invite-only signup: the allauth signup view must never create accounts.

    Accounts are born exclusively through the invite-accept flow (rule: first
    sign-in must match a pending invite's email). allauth's built-in signup,
    its social-account automatic signup and passkey signup all funnel through
    adapter.is_open_for_signup, so closing it here closes every signup path.
    """

    def is_open_for_signup(self, request, **kwargs):  # noqa: ANN001
        return False
