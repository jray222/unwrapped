"""Matrix rules: item.* (generated from docs/authz-matrix.yaml, version 1)."""

import pytest

from .helpers import (
    assert_allowed,
    assert_denied,
    assert_not_found,
    call,
    db_state,
)

pytestmark = pytest.mark.django_db


def test_item_view__family_admin__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.family_admin, "item.view", item=item)
    assert_allowed(resp, shows=item)


def test_item_view__member__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.member_giver, "item.view", item=item)
    assert_allowed(resp, shows=item)


def test_item_view__guest__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.guest_scoped, "item.view", item=item)
    assert_allowed(resp, shows=item)


def test_item_view__guest__not_in_guest_scope_denied(alpha):
    item = alpha.new_item()
    resp = call(alpha.guest_unscoped, "item.view", item=item)
    assert_denied(resp, hides=item)


def test_item_view__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    resp = call(anonymous, "item.view", item=item)
    assert_denied(resp, hides=item)


def test_item_view__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    resp = call(instance_admin, "item.view", item=item)
    assert_denied(resp, hides=item)


def test_item_view__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    resp = call(alpha.assignee_link, "item.view", item=item)
    assert_denied(resp, hides=item)


def test_item_view__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.family_admin, "item.view", item=item)
    assert_not_found(resp, hides=item)


def test_item_view__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.member_giver, "item.view", item=item)
    assert_not_found(resp, hides=item)


def test_item_view__guest__cross_family_404(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.guest_scoped, "item.view", item=item)
    assert_not_found(resp, hides=item)


def test_item_view__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    resp = call(instance_admin, "item.view", item=item)
    assert_not_found(resp, hides=item)


def test_item_view__guest__revoked_denied(alpha):
    item = alpha.new_item()
    alpha.guest_scoped.revoke()
    resp = call(alpha.guest_scoped, "item.view", item=item)
    assert_denied(resp, hides=item)


def test_item_view__guest__expired_denied(alpha):
    item = alpha.new_item()
    alpha.guest_scoped.expire()
    resp = call(alpha.guest_scoped, "item.view", item=item)
    assert_denied(resp, hides=item)


def test_item_view__member__grandma_cross_family_404(beta, grandma):
    item = beta.new_item()
    resp = call(grandma.alpha_member, "item.view", item=item)
    assert_not_found(resp, hides=item)


def test_item_view__guest__grandma_cross_family_404(alpha, grandma):
    item = alpha.new_item()
    resp = call(grandma.beta_guest, "item.view", item=item)
    assert_not_found(resp, hides=item)


def test_item_view__guest__grandma_in_scope_allowed(beta, grandma):
    item = beta.new_item()
    resp = call(grandma.beta_guest, "item.view", item=item)
    assert_allowed(resp, shows=item)


def test_item_create__family_admin__allowed(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.family_admin, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_allowed(resp)


def test_item_create__member__allowed(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.member_recipient, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_allowed(resp)


def test_item_create__member__not_is_list_manager_denied(alpha):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(alpha.member_giver, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_create__anonymous__not_in_allow_denied(alpha, anonymous):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(anonymous, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_create__instance_admin__not_in_allow_denied(alpha, instance_admin):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(instance_admin, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_create__guest__not_in_allow_denied(alpha):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_create__assignment_link__not_in_allow_denied(alpha):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_create__family_admin__cross_family_404(alpha, beta):
    lst = beta.recipient_list
    before = db_state(beta)
    resp = call(alpha.family_admin, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_item_create__member__cross_family_404(alpha, beta):
    lst = beta.recipient_list
    before = db_state(beta)
    resp = call(alpha.member_giver, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_item_create__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(instance_admin, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_item_create__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    lst = beta.recipient_list
    before = db_state(beta)
    resp = call(grandma.beta_guest, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_denied(resp)
    assert db_state(beta) == before


def test_item_update__family_admin__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.family_admin, "item.update", item=item, data={"name": "Green scarf"})
    assert_allowed(resp)


def test_item_update__member__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.member_recipient, "item.update", item=item, data={"name": "Green scarf"})
    assert_allowed(resp)


def test_item_update__member__not_is_list_manager_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.member_giver, "item.update", item=item, data={"name": "Green scarf"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_update__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(anonymous, "item.update", item=item, data={"name": "Green scarf"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_update__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(instance_admin, "item.update", item=item, data={"name": "Green scarf"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_update__guest__not_in_allow_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "item.update", item=item, data={"name": "Green scarf"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_update__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "item.update", item=item, data={"name": "Green scarf"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_update__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.family_admin, "item.update", item=item, data={"name": "Green scarf"})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_item_update__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.member_giver, "item.update", item=item, data={"name": "Green scarf"})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_item_update__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(instance_admin, "item.update", item=item, data={"name": "Green scarf"})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_item_update__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(grandma.beta_guest, "item.update", item=item, data={"name": "Green scarf"})
    assert_denied(resp)
    assert db_state(beta) == before


def test_item_delete__family_admin__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.family_admin, "item.delete", item=item)
    assert_allowed(resp)


def test_item_delete__member__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.member_recipient, "item.delete", item=item)
    assert_allowed(resp)


def test_item_delete__member__not_is_list_manager_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.member_giver, "item.delete", item=item)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_delete__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(anonymous, "item.delete", item=item)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_delete__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(instance_admin, "item.delete", item=item)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_delete__guest__not_in_allow_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "item.delete", item=item)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_delete__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "item.delete", item=item)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_item_delete__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.family_admin, "item.delete", item=item)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_item_delete__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.member_giver, "item.delete", item=item)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_item_delete__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(instance_admin, "item.delete", item=item)
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_item_delete__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(grandma.beta_guest, "item.delete", item=item)
    assert_denied(resp)
    assert db_state(beta) == before
