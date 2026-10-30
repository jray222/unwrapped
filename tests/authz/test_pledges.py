"""Matrix rules: pledge.* (surprise rule applies) (generated from docs/authz-matrix.yaml, version 1)."""

import pytest

from .helpers import (
    assert_allowed,
    assert_denied,
    assert_not_found,
    call,
    db_state,
)

pytestmark = pytest.mark.django_db


def test_pledge_view__family_admin__allowed(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(alpha.family_admin, "pledge.view", item=item)
    assert_allowed(resp, shows=pledge)


def test_pledge_view__member__allowed(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(alpha.member_giver, "pledge.view", item=item)
    assert_allowed(resp, shows=pledge)


def test_pledge_view__guest__allowed(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(alpha.guest_scoped, "pledge.view", item=item)
    assert_allowed(resp, shows=pledge)


def test_pledge_view__guest__not_in_guest_scope_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(alpha.guest_unscoped, "pledge.view", item=item)
    assert_denied(resp, hides=pledge)


def test_pledge_view__member__is_recipient_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(alpha.member_recipient, "pledge.view", item=item)
    assert_not_found(resp, hides=pledge)


def test_pledge_view__family_admin__is_recipient_denied(alpha):
    admin_list = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(admin_list)
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    resp = call(alpha.family_admin, "pledge.view", item=item)
    assert_not_found(resp, hides=pledge)


def test_pledge_view__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(anonymous, "pledge.view", item=item)
    assert_denied(resp, hides=pledge)


def test_pledge_view__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(instance_admin, "pledge.view", item=item)
    assert_denied(resp, hides=pledge)


def test_pledge_view__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(alpha.assignee_link, "pledge.view", item=item)
    assert_denied(resp, hides=pledge)


def test_pledge_view__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.family_admin)
    resp = call(alpha.family_admin, "pledge.view", item=item)
    assert_not_found(resp, hides=pledge)


def test_pledge_view__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.family_admin)
    resp = call(alpha.member_giver, "pledge.view", item=item)
    assert_not_found(resp, hides=pledge)


def test_pledge_view__guest__cross_family_404(alpha, beta):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.family_admin)
    resp = call(alpha.guest_scoped, "pledge.view", item=item)
    assert_not_found(resp, hides=pledge)


def test_pledge_view__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(instance_admin, "pledge.view", item=item)
    assert_not_found(resp, hides=pledge)


def test_pledge_view__guest__revoked_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    alpha.guest_scoped.revoke()
    resp = call(alpha.guest_scoped, "pledge.view", item=item)
    assert_denied(resp, hides=pledge)


def test_pledge_view__guest__expired_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    alpha.guest_scoped.expire()
    resp = call(alpha.guest_scoped, "pledge.view", item=item)
    assert_denied(resp, hides=pledge)


def test_pledge_view__member__grandma_cross_family_404(beta, grandma):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.family_admin)
    resp = call(grandma.alpha_member, "pledge.view", item=item)
    assert_not_found(resp, hides=pledge)


def test_pledge_view__guest__grandma_cross_family_404(alpha, grandma):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(grandma.beta_guest, "pledge.view", item=item)
    assert_not_found(resp, hides=pledge)


def test_pledge_view__guest__grandma_in_scope_allowed(beta, grandma):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.family_admin)
    resp = call(grandma.beta_guest, "pledge.view", item=item)
    assert_allowed(resp, shows=pledge)


def test_pledge_create__family_admin__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.family_admin, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_allowed(resp)


def test_pledge_create__member__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.member_giver, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_allowed(resp)


def test_pledge_create__guest__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.guest_scoped, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_allowed(resp)


def test_pledge_create__guest__not_in_guest_scope_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.guest_unscoped, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_create__member__is_recipient_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.member_recipient, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_pledge_create__family_admin__is_recipient_denied(alpha):
    admin_list = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(admin_list)
    before = db_state(alpha)
    resp = call(alpha.family_admin, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_pledge_create__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(anonymous, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_create__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(instance_admin, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_create__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_create__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.family_admin, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_pledge_create__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.member_giver, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_pledge_create__guest__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.guest_scoped, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_pledge_create__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(instance_admin, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_pledge_create__guest__revoked_denied(alpha):
    item = alpha.new_item()
    alpha.guest_scoped.revoke()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_create__guest__expired_denied(alpha):
    item = alpha.new_item()
    alpha.guest_scoped.expire()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_create__member__grandma_cross_family_404(beta, grandma):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(grandma.alpha_member, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_pledge_create__guest__grandma_cross_family_404(alpha, grandma):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(grandma.beta_guest, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_pledge_create__guest__grandma_in_scope_allowed(beta, grandma):
    item = beta.new_item()
    resp = call(grandma.beta_guest, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_allowed(resp)


def test_pledge_update__family_admin__allowed(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(alpha.family_admin, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_allowed(resp)


def test_pledge_update__member__allowed(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    resp = call(alpha.member_giver, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_allowed(resp)


def test_pledge_update__guest__allowed(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.guest_scoped)
    resp = call(alpha.guest_scoped, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_allowed(resp)


def test_pledge_update__family_admin__not_is_claimer_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.family_admin, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_update__member__not_is_claimer_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    before = db_state(alpha)
    resp = call(alpha.member_giver, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_update__guest__not_is_claimer_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_update__member__is_recipient_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.member_recipient, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_pledge_update__family_admin__is_recipient_denied(alpha):
    admin_list = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(admin_list)
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.family_admin, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_pledge_update__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(anonymous, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_update__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(instance_admin, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_update__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_update__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.family_admin, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_pledge_update__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.member_giver, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_pledge_update__guest__cross_family_404(alpha, beta):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.guest_scoped, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_pledge_update__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(instance_admin, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_pledge_update__guest__revoked_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.guest_scoped)
    alpha.guest_scoped.revoke()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_update__guest__expired_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.guest_scoped)
    alpha.guest_scoped.expire()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_pledge_update__member__grandma_cross_family_404(beta, grandma):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.member_giver)
    before = db_state(beta)
    resp = call(grandma.alpha_member, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_pledge_update__guest__grandma_cross_family_404(alpha, grandma):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(grandma.beta_guest, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_not_found(resp)
    assert db_state(alpha) == before
