"""Matrix rules: assignment.* (surprise rule applies) (generated from docs/authz-matrix.yaml, version 1)."""

import pytest

from .helpers import (
    assert_allowed,
    assert_denied,
    assert_not_found,
    assert_rejected,
    call,
    db_state,
)

pytestmark = pytest.mark.django_db


def test_assignment_create__family_admin__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.family_admin, "assignment.create", item=item, data={"assignee": alpha.assignee_link.ref})
    assert_allowed(resp)


def test_assignment_create__member__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.member_giver, "assignment.create", item=item, data={"assignee": alpha.assignee_link.ref})
    assert_allowed(resp)


def test_assignment_create__member__is_recipient_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.member_recipient, "assignment.create", item=item, data={"assignee": alpha.assignee_link.ref})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_assignment_create__family_admin__is_recipient_denied(alpha):
    admin_list = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(admin_list)
    before = db_state(alpha)
    resp = call(alpha.family_admin, "assignment.create", item=item, data={"assignee": alpha.assignee_link.ref})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_assignment_create__member__assignee_is_recipient_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.member_giver, "assignment.create", item=item, data={"assignee": alpha.member_recipient.ref})
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_assignment_create__family_admin__assignee_is_recipient_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.family_admin, "assignment.create", item=item, data={"assignee": alpha.member_recipient.ref})
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_assignment_create__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(anonymous, "assignment.create", item=item, data={"assignee": alpha.assignee_link.ref})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_create__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(instance_admin, "assignment.create", item=item, data={"assignee": alpha.assignee_link.ref})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_create__guest__not_in_allow_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "assignment.create", item=item, data={"assignee": alpha.assignee_link.ref})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_create__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "assignment.create", item=item, data={"assignee": alpha.assignee_link.ref})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_create__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.family_admin, "assignment.create", item=item, data={"assignee": beta.assignee_link.ref})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_assignment_create__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.member_giver, "assignment.create", item=item, data={"assignee": beta.assignee_link.ref})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_assignment_create__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(instance_admin, "assignment.create", item=item, data={"assignee": alpha.assignee_link.ref})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_assignment_create__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(grandma.beta_guest, "assignment.create", item=item, data={"assignee": beta.assignee_link.ref})
    assert_denied(resp)
    assert db_state(beta) == before


def test_assignment_view__family_admin__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.family_admin, "assignment.view", assignment=assignment)
    assert_allowed(resp, shows=assignment)


def test_assignment_view__member__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.member_giver, "assignment.view", assignment=assignment)
    assert_allowed(resp, shows=assignment)


def test_assignment_view__assignment_link__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.assignee_link, "assignment.view", assignment=assignment)
    assert_allowed(resp, shows=assignment)


def test_assignment_view__assignment_link__not_is_assignee_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.family_admin)
    resp = call(alpha.assignee_link, "assignment.view", assignment=assignment)
    assert_denied(resp, hides=assignment)


def test_assignment_view__member__is_recipient_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.member_recipient, "assignment.view", assignment=assignment)
    assert_not_found(resp, hides=assignment)


def test_assignment_view__family_admin__is_recipient_denied(alpha):
    admin_list = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(admin_list)
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.family_admin, "assignment.view", assignment=assignment)
    assert_not_found(resp, hides=assignment)


def test_assignment_view__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(anonymous, "assignment.view", assignment=assignment)
    assert_denied(resp, hides=assignment)


def test_assignment_view__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(instance_admin, "assignment.view", assignment=assignment)
    assert_denied(resp, hides=assignment)


def test_assignment_view__guest__not_in_allow_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.guest_scoped, "assignment.view", assignment=assignment)
    assert_denied(resp, hides=assignment)


def test_assignment_view__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.family_admin, "assignment.view", assignment=assignment)
    assert_not_found(resp, hides=assignment)


def test_assignment_view__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.member_giver, "assignment.view", assignment=assignment)
    assert_not_found(resp, hides=assignment)


def test_assignment_view__assignment_link__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.assignee_link, "assignment.view", assignment=assignment)
    assert_not_found(resp, hides=assignment)


def test_assignment_view__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(instance_admin, "assignment.view", assignment=assignment)
    assert_not_found(resp, hides=assignment)


def test_assignment_view__assignment_link__revoked_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    alpha.assignee_link.revoke()
    resp = call(alpha.assignee_link, "assignment.view", assignment=assignment)
    assert_denied(resp, hides=assignment)


def test_assignment_view__assignment_link__expired_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    alpha.assignee_link.expire()
    resp = call(alpha.assignee_link, "assignment.view", assignment=assignment)
    assert_denied(resp, hides=assignment)


def test_assignment_view__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(grandma.beta_guest, "assignment.view", assignment=assignment)
    assert_denied(resp, hides=assignment)


def test_assignment_mark_bought__family_admin__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.family_admin, "assignment.mark_bought", assignment=assignment)
    assert_allowed(resp)


def test_assignment_mark_bought__member__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.member_giver, "assignment.mark_bought", assignment=assignment)
    assert_allowed(resp)


def test_assignment_mark_bought__assignment_link__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.assignee_link, "assignment.mark_bought", assignment=assignment)
    assert_allowed(resp)


def test_assignment_mark_bought__member__not_is_assigner_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.family_admin, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(alpha.member_giver, "assignment.mark_bought", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_bought__assignment_link__not_is_assignee_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.family_admin)
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "assignment.mark_bought", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_bought__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(anonymous, "assignment.mark_bought", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_bought__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(instance_admin, "assignment.mark_bought", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_bought__guest__not_in_allow_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "assignment.mark_bought", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_bought__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    before = db_state(beta)
    resp = call(alpha.family_admin, "assignment.mark_bought", assignment=assignment)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_assignment_mark_bought__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    before = db_state(beta)
    resp = call(alpha.member_giver, "assignment.mark_bought", assignment=assignment)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_assignment_mark_bought__assignment_link__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    before = db_state(beta)
    resp = call(alpha.assignee_link, "assignment.mark_bought", assignment=assignment)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_assignment_mark_bought__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(instance_admin, "assignment.mark_bought", assignment=assignment)
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_assignment_mark_bought__assignment_link__revoked_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    alpha.assignee_link.revoke()
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "assignment.mark_bought", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_bought__assignment_link__expired_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    alpha.assignee_link.expire()
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "assignment.mark_bought", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_bought__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    before = db_state(beta)
    resp = call(grandma.beta_guest, "assignment.mark_bought", assignment=assignment)
    assert_denied(resp)
    assert db_state(beta) == before


def test_assignment_mark_couldnt_get__family_admin__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.family_admin, "assignment.mark_couldnt_get", assignment=assignment)
    assert_allowed(resp)


def test_assignment_mark_couldnt_get__member__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.member_giver, "assignment.mark_couldnt_get", assignment=assignment)
    assert_allowed(resp)


def test_assignment_mark_couldnt_get__assignment_link__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.assignee_link, "assignment.mark_couldnt_get", assignment=assignment)
    assert_allowed(resp)


def test_assignment_mark_couldnt_get__member__not_is_assigner_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.family_admin, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(alpha.member_giver, "assignment.mark_couldnt_get", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_couldnt_get__assignment_link__not_is_assignee_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.family_admin)
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "assignment.mark_couldnt_get", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_couldnt_get__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(anonymous, "assignment.mark_couldnt_get", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_couldnt_get__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(instance_admin, "assignment.mark_couldnt_get", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_couldnt_get__guest__not_in_allow_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "assignment.mark_couldnt_get", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_couldnt_get__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    before = db_state(beta)
    resp = call(alpha.family_admin, "assignment.mark_couldnt_get", assignment=assignment)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_assignment_mark_couldnt_get__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    before = db_state(beta)
    resp = call(alpha.member_giver, "assignment.mark_couldnt_get", assignment=assignment)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_assignment_mark_couldnt_get__assignment_link__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    before = db_state(beta)
    resp = call(alpha.assignee_link, "assignment.mark_couldnt_get", assignment=assignment)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_assignment_mark_couldnt_get__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(instance_admin, "assignment.mark_couldnt_get", assignment=assignment)
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_assignment_mark_couldnt_get__assignment_link__revoked_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    alpha.assignee_link.revoke()
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "assignment.mark_couldnt_get", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_couldnt_get__assignment_link__expired_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    alpha.assignee_link.expire()
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "assignment.mark_couldnt_get", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_mark_couldnt_get__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    before = db_state(beta)
    resp = call(grandma.beta_guest, "assignment.mark_couldnt_get", assignment=assignment)
    assert_denied(resp)
    assert db_state(beta) == before


def test_assignment_cancel__family_admin__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.family_admin, "assignment.cancel", assignment=assignment)
    assert_allowed(resp)


def test_assignment_cancel__member__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.member_giver, "assignment.cancel", assignment=assignment)
    assert_allowed(resp)


def test_assignment_cancel__member__not_is_assigner_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.family_admin, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(alpha.member_giver, "assignment.cancel", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_cancel__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(anonymous, "assignment.cancel", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_cancel__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(instance_admin, "assignment.cancel", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_cancel__guest__not_in_allow_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "assignment.cancel", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_cancel__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "assignment.cancel", assignment=assignment)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_assignment_cancel__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    before = db_state(beta)
    resp = call(alpha.family_admin, "assignment.cancel", assignment=assignment)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_assignment_cancel__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    before = db_state(beta)
    resp = call(alpha.member_giver, "assignment.cancel", assignment=assignment)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_assignment_cancel__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    before = db_state(alpha)
    resp = call(instance_admin, "assignment.cancel", assignment=assignment)
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_assignment_cancel__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    before = db_state(beta)
    resp = call(grandma.beta_guest, "assignment.cancel", assignment=assignment)
    assert_denied(resp)
    assert db_state(beta) == before


def test_assignment_share_card__family_admin__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.family_admin, "assignment.share_card", assignment=assignment)
    assert_allowed(resp)
    assert resp["Content-Type"] in ("application/pdf", "image/png")


def test_assignment_share_card__member__allowed(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.member_giver, "assignment.share_card", assignment=assignment)
    assert_allowed(resp)
    assert resp["Content-Type"] in ("application/pdf", "image/png")


def test_assignment_share_card__member__not_is_assigner_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.family_admin, assignee=alpha.assignee_link)
    resp = call(alpha.member_giver, "assignment.share_card", assignment=assignment)
    assert_denied(resp)


def test_assignment_share_card__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(anonymous, "assignment.share_card", assignment=assignment)
    assert_denied(resp)


def test_assignment_share_card__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(instance_admin, "assignment.share_card", assignment=assignment)
    assert_denied(resp)


def test_assignment_share_card__guest__not_in_allow_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.guest_scoped, "assignment.share_card", assignment=assignment)
    assert_denied(resp)


def test_assignment_share_card__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.assignee_link, "assignment.share_card", assignment=assignment)
    assert_denied(resp)


def test_assignment_share_card__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.family_admin, "assignment.share_card", assignment=assignment)
    assert_not_found(resp)


def test_assignment_share_card__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.member_giver, "assignment.share_card", assignment=assignment)
    assert_not_found(resp)


def test_assignment_share_card__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(instance_admin, "assignment.share_card", assignment=assignment)
    assert_not_found(resp)


def test_assignment_share_card__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(grandma.beta_guest, "assignment.share_card", assignment=assignment)
    assert_denied(resp)
