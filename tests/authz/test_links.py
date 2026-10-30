"""Matrix rules: guest_link.* (generated from docs/authz-matrix.yaml, version 1)."""

import pytest

from .helpers import (
    assert_allowed,
    assert_denied,
    assert_exchanged,
    assert_no_session_cookie,
    assert_not_found,
    assert_rejected,
    call,
    db_state,
    random_token,
)

pytestmark = pytest.mark.django_db


def test_guest_link_issue__family_admin__allowed(alpha):
    family = alpha.family
    resp = call(alpha.family_admin, "guest_link.issue", family=family, data={"lists": [alpha.recipient_list.ref], "person": "Aunt May"})
    assert_allowed(resp)


def test_guest_link_issue__member__allowed(alpha):
    family = alpha.family
    resp = call(alpha.member_giver, "guest_link.issue", family=family, data={"lists": [alpha.recipient_list.ref], "person": "Aunt May"})
    assert_allowed(resp)


def test_guest_link_issue__anonymous__not_in_allow_denied(alpha, anonymous):
    family = alpha.family
    before = db_state(alpha)
    resp = call(anonymous, "guest_link.issue", family=family, data={"lists": [alpha.recipient_list.ref], "person": "Aunt May"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_guest_link_issue__instance_admin__not_in_allow_denied(alpha, instance_admin):
    family = alpha.family
    before = db_state(alpha)
    resp = call(instance_admin, "guest_link.issue", family=family, data={"lists": [alpha.recipient_list.ref], "person": "Aunt May"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_guest_link_issue__guest__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "guest_link.issue", family=family, data={"lists": [alpha.recipient_list.ref], "person": "Aunt May"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_guest_link_issue__assignment_link__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "guest_link.issue", family=family, data={"lists": [alpha.recipient_list.ref], "person": "Aunt May"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_guest_link_issue__family_admin__cross_family_404(alpha, beta):
    family = beta.family
    before = db_state(beta)
    resp = call(alpha.family_admin, "guest_link.issue", family=family, data={"lists": [beta.recipient_list.ref], "person": "Aunt May"})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_guest_link_issue__member__cross_family_404(alpha, beta):
    family = beta.family
    before = db_state(beta)
    resp = call(alpha.member_giver, "guest_link.issue", family=family, data={"lists": [beta.recipient_list.ref], "person": "Aunt May"})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_guest_link_issue__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    family = beta.family
    before = db_state(beta)
    resp = call(grandma.beta_guest, "guest_link.issue", family=family, data={"lists": [beta.recipient_list.ref], "person": "Aunt May"})
    assert_denied(resp)
    assert db_state(beta) == before


def test_guest_link_revoke__family_admin__allowed(alpha):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    resp = call(alpha.family_admin, "guest_link.revoke", guest_link=guest_link)
    assert_allowed(resp)


def test_guest_link_revoke__member__allowed(alpha):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    resp = call(alpha.member_giver, "guest_link.revoke", guest_link=guest_link)
    assert_allowed(resp)


def test_guest_link_revoke__member__not_issued_by_actor_denied(alpha):
    guest_link = alpha.new_guest_link(issued_by=alpha.family_admin)
    before = db_state(alpha)
    resp = call(alpha.member_giver, "guest_link.revoke", guest_link=guest_link)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_guest_link_revoke__anonymous__not_in_allow_denied(alpha, anonymous):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(anonymous, "guest_link.revoke", guest_link=guest_link)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_guest_link_revoke__instance_admin__not_in_allow_denied(alpha, instance_admin):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(instance_admin, "guest_link.revoke", guest_link=guest_link)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_guest_link_revoke__guest__not_in_allow_denied(alpha):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "guest_link.revoke", guest_link=guest_link)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_guest_link_revoke__assignment_link__not_in_allow_denied(alpha):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "guest_link.revoke", guest_link=guest_link)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_guest_link_revoke__family_admin__cross_family_404(alpha, beta):
    guest_link = beta.new_guest_link(issued_by=beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.family_admin, "guest_link.revoke", guest_link=guest_link)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_guest_link_revoke__member__cross_family_404(alpha, beta):
    guest_link = beta.new_guest_link(issued_by=beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.member_giver, "guest_link.revoke", guest_link=guest_link)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_guest_link_revoke__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    guest_link = beta.new_guest_link(issued_by=beta.member_giver)
    before = db_state(beta)
    resp = call(grandma.beta_guest, "guest_link.revoke", guest_link=guest_link)
    assert_denied(resp)
    assert db_state(beta) == before


def test_guest_link_exchange__anonymous__allowed(alpha, anonymous):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    resp = call(anonymous, "guest_link.exchange", token=guest_link.token)
    assert_exchanged(resp, guest_link.token)


def test_guest_link_exchange__anonymous__not_token_valid_unknown_denied(alpha, anonymous):
    alpha.new_guest_link(issued_by=alpha.member_giver)
    resp = call(anonymous, "guest_link.exchange", token=random_token())
    assert_rejected(resp)
    assert_no_session_cookie(resp)


def test_guest_link_exchange__anonymous__not_token_valid_revoked_denied(alpha, anonymous):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    guest_link.revoke()
    resp = call(anonymous, "guest_link.exchange", token=guest_link.token)
    assert_rejected(resp)
    assert_no_session_cookie(resp)


def test_guest_link_exchange__anonymous__not_token_valid_expired_denied(alpha, anonymous):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    guest_link.expire()
    resp = call(anonymous, "guest_link.exchange", token=guest_link.token)
    assert_rejected(resp)
    assert_no_session_cookie(resp)


def test_guest_link_exchange__instance_admin__not_in_allow_denied(alpha, instance_admin):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    resp = call(instance_admin, "guest_link.exchange", token=guest_link.token)
    assert_denied(resp)


def test_guest_link_exchange__family_admin__not_in_allow_denied(alpha):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    resp = call(alpha.family_admin, "guest_link.exchange", token=guest_link.token)
    assert_denied(resp)


def test_guest_link_exchange__member__not_in_allow_denied(alpha):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    resp = call(alpha.member_giver, "guest_link.exchange", token=guest_link.token)
    assert_denied(resp)


def test_guest_link_exchange__guest__not_in_allow_denied(alpha):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    resp = call(alpha.guest_scoped, "guest_link.exchange", token=guest_link.token)
    assert_denied(resp)


def test_guest_link_exchange__assignment_link__not_in_allow_denied(alpha):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    resp = call(alpha.assignee_link, "guest_link.exchange", token=guest_link.token)
    assert_denied(resp)
