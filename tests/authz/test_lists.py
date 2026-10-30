"""Matrix rules: list.* (generated from docs/authz-matrix.yaml, version 1)."""

import pytest

from .helpers import (
    assert_allowed,
    assert_denied,
    assert_not_found,
    call,
    db_state,
)

pytestmark = pytest.mark.django_db


def test_list_create__family_admin__allowed(alpha):
    family = alpha.family
    resp = call(alpha.family_admin, "list.create", family=family, data={"title": "Spring wishes", "recipient": alpha.member_recipient.ref})
    assert_allowed(resp)


def test_list_create__member__allowed(alpha):
    family = alpha.family
    resp = call(alpha.member_giver, "list.create", family=family, data={"title": "Spring wishes", "recipient": alpha.member_recipient.ref})
    assert_allowed(resp)


def test_list_create__anonymous__not_in_allow_denied(alpha, anonymous):
    family = alpha.family
    before = db_state(alpha)
    resp = call(anonymous, "list.create", family=family, data={"title": "Spring wishes", "recipient": alpha.member_recipient.ref})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_create__instance_admin__not_in_allow_denied(alpha, instance_admin):
    family = alpha.family
    before = db_state(alpha)
    resp = call(instance_admin, "list.create", family=family, data={"title": "Spring wishes", "recipient": alpha.member_recipient.ref})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_create__guest__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "list.create", family=family, data={"title": "Spring wishes", "recipient": alpha.member_recipient.ref})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_create__assignment_link__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "list.create", family=family, data={"title": "Spring wishes", "recipient": alpha.member_recipient.ref})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_create__family_admin__cross_family_404(alpha, beta):
    family = beta.family
    before = db_state(beta)
    resp = call(alpha.family_admin, "list.create", family=family, data={"title": "Spring wishes", "recipient": beta.member_recipient.ref})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_list_create__member__cross_family_404(alpha, beta):
    family = beta.family
    before = db_state(beta)
    resp = call(alpha.member_giver, "list.create", family=family, data={"title": "Spring wishes", "recipient": beta.member_recipient.ref})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_list_create__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    family = beta.family
    before = db_state(beta)
    resp = call(grandma.beta_guest, "list.create", family=family, data={"title": "Spring wishes", "recipient": beta.member_recipient.ref})
    assert_denied(resp)
    assert db_state(beta) == before


def test_list_view__family_admin__allowed(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.family_admin, "list.view", list=lst)
    assert_allowed(resp, shows=lst)


def test_list_view__member__allowed(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.member_giver, "list.view", list=lst)
    assert_allowed(resp, shows=lst)


def test_list_view__guest__allowed(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.guest_scoped, "list.view", list=lst)
    assert_allowed(resp, shows=lst)


def test_list_view__guest__not_in_guest_scope_denied(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.guest_unscoped, "list.view", list=lst)
    assert_denied(resp, hides=lst)


def test_list_view__anonymous__not_in_allow_denied(alpha, anonymous):
    lst = alpha.recipient_list
    resp = call(anonymous, "list.view", list=lst)
    assert_denied(resp, hides=lst)


def test_list_view__instance_admin__not_in_allow_denied(alpha, instance_admin):
    lst = alpha.recipient_list
    resp = call(instance_admin, "list.view", list=lst)
    assert_denied(resp, hides=lst)


def test_list_view__assignment_link__not_in_allow_denied(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.assignee_link, "list.view", list=lst)
    assert_denied(resp, hides=lst)


def test_list_view__family_admin__cross_family_404(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.family_admin, "list.view", list=lst)
    assert_not_found(resp, hides=lst)


def test_list_view__member__cross_family_404(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.member_giver, "list.view", list=lst)
    assert_not_found(resp, hides=lst)


def test_list_view__guest__cross_family_404(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.guest_scoped, "list.view", list=lst)
    assert_not_found(resp, hides=lst)


def test_list_view__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    lst = alpha.recipient_list
    resp = call(instance_admin, "list.view", list=lst)
    assert_not_found(resp, hides=lst)


def test_list_view__guest__revoked_denied(alpha):
    lst = alpha.recipient_list
    alpha.guest_scoped.revoke()
    resp = call(alpha.guest_scoped, "list.view", list=lst)
    assert_denied(resp, hides=lst)


def test_list_view__guest__expired_denied(alpha):
    lst = alpha.recipient_list
    alpha.guest_scoped.expire()
    resp = call(alpha.guest_scoped, "list.view", list=lst)
    assert_denied(resp, hides=lst)


def test_list_view__member__grandma_cross_family_404(beta, grandma):
    lst = beta.recipient_list
    resp = call(grandma.alpha_member, "list.view", list=lst)
    assert_not_found(resp, hides=lst)


def test_list_view__guest__grandma_cross_family_404(alpha, grandma):
    lst = alpha.recipient_list
    resp = call(grandma.beta_guest, "list.view", list=lst)
    assert_not_found(resp, hides=lst)


def test_list_view__guest__grandma_in_scope_allowed(beta, grandma):
    lst = beta.recipient_list
    resp = call(grandma.beta_guest, "list.view", list=lst)
    assert_allowed(resp, shows=lst)


def test_list_update__family_admin__allowed(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.family_admin, "list.update", list=lst, data={"title": "Renamed list"})
    assert_allowed(resp)


def test_list_update__member__allowed(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.member_recipient, "list.update", list=lst, data={"title": "Renamed list"})
    assert_allowed(resp)


def test_list_update__member__not_is_list_manager_denied(alpha):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(alpha.member_giver, "list.update", list=lst, data={"title": "Renamed list"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_update__anonymous__not_in_allow_denied(alpha, anonymous):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(anonymous, "list.update", list=lst, data={"title": "Renamed list"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_update__instance_admin__not_in_allow_denied(alpha, instance_admin):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(instance_admin, "list.update", list=lst, data={"title": "Renamed list"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_update__guest__not_in_allow_denied(alpha):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "list.update", list=lst, data={"title": "Renamed list"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_update__assignment_link__not_in_allow_denied(alpha):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "list.update", list=lst, data={"title": "Renamed list"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_update__family_admin__cross_family_404(alpha, beta):
    lst = beta.recipient_list
    before = db_state(beta)
    resp = call(alpha.family_admin, "list.update", list=lst, data={"title": "Renamed list"})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_list_update__member__cross_family_404(alpha, beta):
    lst = beta.recipient_list
    before = db_state(beta)
    resp = call(alpha.member_giver, "list.update", list=lst, data={"title": "Renamed list"})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_list_update__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(instance_admin, "list.update", list=lst, data={"title": "Renamed list"})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_list_update__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    lst = beta.recipient_list
    before = db_state(beta)
    resp = call(grandma.beta_guest, "list.update", list=lst, data={"title": "Renamed list"})
    assert_denied(resp)
    assert db_state(beta) == before


def test_list_delete__family_admin__allowed(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.family_admin, "list.delete", list=lst)
    assert_allowed(resp)


def test_list_delete__member__allowed(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.member_recipient, "list.delete", list=lst)
    assert_allowed(resp)


def test_list_delete__member__not_is_list_manager_denied(alpha):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(alpha.member_giver, "list.delete", list=lst)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_delete__anonymous__not_in_allow_denied(alpha, anonymous):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(anonymous, "list.delete", list=lst)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_delete__instance_admin__not_in_allow_denied(alpha, instance_admin):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(instance_admin, "list.delete", list=lst)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_delete__guest__not_in_allow_denied(alpha):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "list.delete", list=lst)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_delete__assignment_link__not_in_allow_denied(alpha):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "list.delete", list=lst)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_list_delete__family_admin__cross_family_404(alpha, beta):
    lst = beta.recipient_list
    before = db_state(beta)
    resp = call(alpha.family_admin, "list.delete", list=lst)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_list_delete__member__cross_family_404(alpha, beta):
    lst = beta.recipient_list
    before = db_state(beta)
    resp = call(alpha.member_giver, "list.delete", list=lst)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_list_delete__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    lst = alpha.recipient_list
    before = db_state(alpha)
    resp = call(instance_admin, "list.delete", list=lst)
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_list_delete__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    lst = beta.recipient_list
    before = db_state(beta)
    resp = call(grandma.beta_guest, "list.delete", list=lst)
    assert_denied(resp)
    assert db_state(beta) == before
