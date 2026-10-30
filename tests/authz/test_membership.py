"""Matrix rules: invite.*, member.* (generated from docs/authz-matrix.yaml, version 1)."""

import pytest

from .helpers import (
    assert_allowed,
    assert_denied,
    assert_not_found,
    assert_rejected,
    call,
    db_state,
    new_anonymous,
    random_token,
)

pytestmark = pytest.mark.django_db


def test_invite_create__family_admin__allowed(alpha):
    family = alpha.family
    resp = call(alpha.family_admin, "invite.create", family=family, data={"email": "new.person@example.test"})
    assert_allowed(resp)


def test_invite_create__anonymous__not_in_allow_denied(alpha, anonymous):
    family = alpha.family
    before = db_state(alpha)
    resp = call(anonymous, "invite.create", family=family, data={"email": "new.person@example.test"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_create__instance_admin__not_in_allow_denied(alpha, instance_admin):
    family = alpha.family
    before = db_state(alpha)
    resp = call(instance_admin, "invite.create", family=family, data={"email": "new.person@example.test"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_create__member__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(alpha)
    resp = call(alpha.member_giver, "invite.create", family=family, data={"email": "new.person@example.test"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_create__guest__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "invite.create", family=family, data={"email": "new.person@example.test"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_create__assignment_link__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "invite.create", family=family, data={"email": "new.person@example.test"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_create__family_admin__cross_family_404(alpha, beta):
    family = beta.family
    before = db_state(beta)
    resp = call(alpha.family_admin, "invite.create", family=family, data={"email": "new.person@example.test"})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_invite_create__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    family = beta.family
    before = db_state(beta)
    resp = call(grandma.beta_guest, "invite.create", family=family, data={"email": "new.person@example.test"})
    assert_denied(resp)
    assert db_state(beta) == before


def test_invite_revoke__family_admin__allowed(alpha):
    invite = alpha.new_invite()
    resp = call(alpha.family_admin, "invite.revoke", invite=invite)
    assert_allowed(resp)


def test_invite_revoke__anonymous__not_in_allow_denied(alpha, anonymous):
    invite = alpha.new_invite()
    before = db_state(alpha)
    resp = call(anonymous, "invite.revoke", invite=invite)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_revoke__instance_admin__not_in_allow_denied(alpha, instance_admin):
    invite = alpha.new_invite()
    before = db_state(alpha)
    resp = call(instance_admin, "invite.revoke", invite=invite)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_revoke__member__not_in_allow_denied(alpha):
    invite = alpha.new_invite()
    before = db_state(alpha)
    resp = call(alpha.member_giver, "invite.revoke", invite=invite)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_revoke__guest__not_in_allow_denied(alpha):
    invite = alpha.new_invite()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "invite.revoke", invite=invite)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_revoke__assignment_link__not_in_allow_denied(alpha):
    invite = alpha.new_invite()
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "invite.revoke", invite=invite)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_revoke__family_admin__cross_family_404(alpha, beta):
    invite = beta.new_invite()
    before = db_state(beta)
    resp = call(alpha.family_admin, "invite.revoke", invite=invite)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_invite_revoke__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    invite = beta.new_invite()
    before = db_state(beta)
    resp = call(grandma.beta_guest, "invite.revoke", invite=invite)
    assert_denied(resp)
    assert db_state(beta) == before


def test_invite_accept__anonymous__allowed(alpha, anonymous):
    invite = alpha.new_invite(email="new.person@example.test")
    resp = call(anonymous, "invite.accept", data={"token": invite.token, "email": invite.email})
    assert_allowed(resp, redirect=True)


def test_invite_accept__anonymous__not_token_valid_unknown_denied(alpha, anonymous):
    invite = alpha.new_invite(email="new.person@example.test")
    before = db_state(alpha)
    resp = call(anonymous, "invite.accept", data={"token": random_token(), "email": invite.email})
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_invite_accept__anonymous__not_token_valid_expired_denied(alpha, anonymous):
    invite = alpha.new_invite(email="new.person@example.test")
    invite.expire()
    before = db_state(alpha)
    resp = call(anonymous, "invite.accept", data={"token": invite.token, "email": invite.email})
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_invite_accept__anonymous__not_token_valid_revoked_denied(alpha, anonymous):
    invite = alpha.new_invite(email="new.person@example.test")
    invite.revoke()
    before = db_state(alpha)
    resp = call(anonymous, "invite.accept", data={"token": invite.token, "email": invite.email})
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_invite_accept__anonymous__not_token_valid_reused_denied(alpha, anonymous):
    invite = alpha.new_invite(email="new.person@example.test")
    first = call(new_anonymous(), "invite.accept", data={"token": invite.token, "email": invite.email})
    assert_allowed(first, redirect=True)
    before = db_state(alpha)
    resp = call(anonymous, "invite.accept", data={"token": invite.token, "email": invite.email})
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_invite_accept__anonymous__not_email_matches_invite_denied(alpha, anonymous):
    invite = alpha.new_invite(email="new.person@example.test")
    before = db_state(alpha)
    resp = call(anonymous, "invite.accept", data={"token": invite.token, "email": "someone.else@example.test"})
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_invite_accept__instance_admin__not_in_allow_denied(alpha, instance_admin):
    invite = alpha.new_invite(email="new.person@example.test")
    before = db_state(alpha)
    resp = call(instance_admin, "invite.accept", data={"token": invite.token, "email": invite.email})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_accept__family_admin__not_in_allow_denied(alpha):
    invite = alpha.new_invite(email="new.person@example.test")
    before = db_state(alpha)
    resp = call(alpha.family_admin, "invite.accept", data={"token": invite.token, "email": invite.email})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_accept__member__not_in_allow_denied(alpha):
    invite = alpha.new_invite(email="new.person@example.test")
    before = db_state(alpha)
    resp = call(alpha.member_giver, "invite.accept", data={"token": invite.token, "email": invite.email})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_accept__guest__not_in_allow_denied(alpha):
    invite = alpha.new_invite(email="new.person@example.test")
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "invite.accept", data={"token": invite.token, "email": invite.email})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_invite_accept__assignment_link__not_in_allow_denied(alpha):
    invite = alpha.new_invite(email="new.person@example.test")
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "invite.accept", data={"token": invite.token, "email": invite.email})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_list__family_admin__allowed(alpha):
    family = alpha.family
    shown = alpha.member_recipient
    resp = call(alpha.family_admin, "member.list", family=family)
    assert_allowed(resp, shows=shown)


def test_member_list__member__allowed(alpha):
    family = alpha.family
    shown = alpha.member_recipient
    resp = call(alpha.member_giver, "member.list", family=family)
    assert_allowed(resp, shows=shown)


def test_member_list__anonymous__not_in_allow_denied(alpha, anonymous):
    family = alpha.family
    shown = alpha.member_recipient
    resp = call(anonymous, "member.list", family=family)
    assert_denied(resp, hides=shown)


def test_member_list__instance_admin__not_in_allow_denied(alpha, instance_admin):
    family = alpha.family
    shown = alpha.member_recipient
    resp = call(instance_admin, "member.list", family=family)
    assert_denied(resp, hides=shown)


def test_member_list__guest__not_in_allow_denied(alpha):
    family = alpha.family
    shown = alpha.member_recipient
    resp = call(alpha.guest_scoped, "member.list", family=family)
    assert_denied(resp, hides=shown)


def test_member_list__assignment_link__not_in_allow_denied(alpha):
    family = alpha.family
    shown = alpha.member_recipient
    resp = call(alpha.assignee_link, "member.list", family=family)
    assert_denied(resp, hides=shown)


def test_member_list__family_admin__cross_family_404(alpha, beta):
    family = beta.family
    shown = beta.member_recipient
    resp = call(alpha.family_admin, "member.list", family=family)
    assert_not_found(resp, hides=shown)


def test_member_list__member__cross_family_404(alpha, beta):
    family = beta.family
    shown = beta.member_recipient
    resp = call(alpha.member_giver, "member.list", family=family)
    assert_not_found(resp, hides=shown)


def test_member_list__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    family = beta.family
    shown = beta.member_recipient
    resp = call(grandma.beta_guest, "member.list", family=family)
    assert_denied(resp, hides=shown)


def test_member_remove__family_admin__allowed(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    resp = call(alpha.family_admin, "member.remove", member=membership)
    assert_allowed(resp)


def test_member_remove__family_admin__not_last_admin_allowed(alpha):
    second_admin = alpha.add_family_admin()
    membership = alpha.membership_of(alpha.family_admin)
    resp = call(second_admin, "member.remove", member=membership)
    assert_allowed(resp)


def test_member_remove__family_admin__not_last_admin_denied(alpha):
    membership = alpha.membership_of(alpha.family_admin)
    before = db_state(alpha)
    resp = call(alpha.family_admin, "member.remove", member=membership)
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_member_remove__anonymous__not_in_allow_denied(alpha, anonymous):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(anonymous, "member.remove", member=membership)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_remove__instance_admin__not_in_allow_denied(alpha, instance_admin):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(instance_admin, "member.remove", member=membership)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_remove__member__not_in_allow_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.member_giver, "member.remove", member=membership)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_remove__guest__not_in_allow_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "member.remove", member=membership)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_remove__assignment_link__not_in_allow_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "member.remove", member=membership)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_remove__family_admin__cross_family_404(alpha, beta):
    membership = beta.membership_of(beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.family_admin, "member.remove", member=membership)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_member_remove__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    membership = beta.membership_of(beta.member_giver)
    before = db_state(beta)
    resp = call(grandma.beta_guest, "member.remove", member=membership)
    assert_denied(resp)
    assert db_state(beta) == before


def test_member_change_role__family_admin__allowed(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    resp = call(alpha.family_admin, "member.change_role", member=membership, data={"role": "family_admin"})
    assert_allowed(resp)


def test_member_change_role__family_admin__not_last_admin_allowed(alpha):
    second_admin = alpha.add_family_admin()
    membership = alpha.membership_of(alpha.family_admin)
    resp = call(second_admin, "member.change_role", member=membership, data={"role": "member"})
    assert_allowed(resp)


def test_member_change_role__family_admin__not_last_admin_denied(alpha):
    membership = alpha.membership_of(alpha.family_admin)
    before = db_state(alpha)
    resp = call(alpha.family_admin, "member.change_role", member=membership, data={"role": "member"})
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_member_change_role__anonymous__not_in_allow_denied(alpha, anonymous):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(anonymous, "member.change_role", member=membership, data={"role": "family_admin"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_change_role__instance_admin__not_in_allow_denied(alpha, instance_admin):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(instance_admin, "member.change_role", member=membership, data={"role": "family_admin"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_change_role__member__not_in_allow_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.member_giver, "member.change_role", member=membership, data={"role": "family_admin"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_change_role__guest__not_in_allow_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "member.change_role", member=membership, data={"role": "family_admin"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_change_role__assignment_link__not_in_allow_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "member.change_role", member=membership, data={"role": "family_admin"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_change_role__family_admin__cross_family_404(alpha, beta):
    membership = beta.membership_of(beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.family_admin, "member.change_role", member=membership, data={"role": "family_admin"})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_member_change_role__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    membership = beta.membership_of(beta.member_giver)
    before = db_state(beta)
    resp = call(grandma.beta_guest, "member.change_role", member=membership, data={"role": "family_admin"})
    assert_denied(resp)
    assert db_state(beta) == before


def test_member_leave__family_admin__allowed(alpha):
    alpha.add_family_admin()
    membership = alpha.membership_of(alpha.family_admin)
    resp = call(alpha.family_admin, "member.leave", member=membership)
    assert_allowed(resp)


def test_member_leave__member__allowed(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    resp = call(alpha.member_giver, "member.leave", member=membership)
    assert_allowed(resp)


def test_member_leave__member__not_is_self_denied(alpha):
    membership = alpha.membership_of(alpha.member_recipient)
    before = db_state(alpha)
    resp = call(alpha.member_giver, "member.leave", member=membership)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_leave__family_admin__not_is_self_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.family_admin, "member.leave", member=membership)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_leave__family_admin__not_last_admin_denied(alpha):
    membership = alpha.membership_of(alpha.family_admin)
    before = db_state(alpha)
    resp = call(alpha.family_admin, "member.leave", member=membership)
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_member_leave__anonymous__not_in_allow_denied(alpha, anonymous):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(anonymous, "member.leave", member=membership)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_leave__instance_admin__not_in_allow_denied(alpha, instance_admin):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(instance_admin, "member.leave", member=membership)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_leave__guest__not_in_allow_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "member.leave", member=membership)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_leave__assignment_link__not_in_allow_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "member.leave", member=membership)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_member_leave__family_admin__cross_family_404(alpha, beta):
    membership = beta.membership_of(beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.family_admin, "member.leave", member=membership)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_member_leave__member__cross_family_404(alpha, beta):
    membership = beta.membership_of(beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.member_giver, "member.leave", member=membership)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_member_leave__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    membership = beta.membership_of(beta.member_giver)
    before = db_state(beta)
    resp = call(grandma.beta_guest, "member.leave", member=membership)
    assert_denied(resp)
    assert db_state(beta) == before
