"""Matrix rules: audit_log.* (generated from docs/authz-matrix.yaml, version 1)."""

import pytest

from .helpers import (
    assert_allowed,
    assert_denied,
    assert_not_found,
    call,
)

pytestmark = pytest.mark.django_db


def test_audit_log_view__family_admin__allowed(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    family = alpha.family
    resp = call(alpha.family_admin, "audit_log.view", family=family)
    assert_allowed(resp, shows=claim)


def test_audit_log_view__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    family = alpha.family
    resp = call(anonymous, "audit_log.view", family=family)
    assert_denied(resp, hides=claim)


def test_audit_log_view__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    family = alpha.family
    resp = call(instance_admin, "audit_log.view", family=family)
    assert_denied(resp, hides=claim)


def test_audit_log_view__member__not_in_allow_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    family = alpha.family
    resp = call(alpha.member_giver, "audit_log.view", family=family)
    assert_denied(resp, hides=claim)


def test_audit_log_view__guest__not_in_allow_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    family = alpha.family
    resp = call(alpha.guest_scoped, "audit_log.view", family=family)
    assert_denied(resp, hides=claim)


def test_audit_log_view__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    family = alpha.family
    resp = call(alpha.assignee_link, "audit_log.view", family=family)
    assert_denied(resp, hides=claim)


def test_audit_log_view__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.member_giver)
    family = beta.family
    resp = call(alpha.family_admin, "audit_log.view", family=family)
    assert_not_found(resp, hides=claim)


def test_audit_log_view__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    family = alpha.family
    resp = call(instance_admin, "audit_log.view", family=family)
    assert_not_found(resp, hides=claim)


def test_audit_log_view__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.member_giver)
    family = beta.family
    resp = call(grandma.beta_guest, "audit_log.view", family=family)
    assert_denied(resp, hides=claim)
