"""Matrix rules: claim.* (surprise rule applies) (generated from docs/authz-matrix.yaml, version 1)."""

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


def test_claim_view__family_admin__allowed(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(alpha.family_admin, "claim.view", item=item)
    assert_allowed(resp, shows=claim)


def test_claim_view__member__allowed(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(alpha.member_giver, "claim.view", item=item)
    assert_allowed(resp, shows=claim)


def test_claim_view__guest__allowed(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(alpha.guest_scoped, "claim.view", item=item)
    assert_allowed(resp, shows=claim)


def test_claim_view__guest__not_in_guest_scope_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(alpha.guest_unscoped, "claim.view", item=item)
    assert_denied(resp, hides=claim)


def test_claim_view__member__is_recipient_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(alpha.member_recipient, "claim.view", item=item)
    assert_not_found(resp, hides=claim)


def test_claim_view__family_admin__is_recipient_denied(alpha):
    admin_list = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(admin_list)
    claim = alpha.new_claim(item, by=alpha.member_giver)
    resp = call(alpha.family_admin, "claim.view", item=item)
    assert_not_found(resp, hides=claim)


def test_claim_view__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(anonymous, "claim.view", item=item)
    assert_denied(resp, hides=claim)


def test_claim_view__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(instance_admin, "claim.view", item=item)
    assert_denied(resp, hides=claim)


def test_claim_view__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(alpha.assignee_link, "claim.view", item=item)
    assert_denied(resp, hides=claim)


def test_claim_view__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.family_admin)
    resp = call(alpha.family_admin, "claim.view", item=item)
    assert_not_found(resp, hides=claim)


def test_claim_view__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.family_admin)
    resp = call(alpha.member_giver, "claim.view", item=item)
    assert_not_found(resp, hides=claim)


def test_claim_view__guest__cross_family_404(alpha, beta):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.family_admin)
    resp = call(alpha.guest_scoped, "claim.view", item=item)
    assert_not_found(resp, hides=claim)


def test_claim_view__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(instance_admin, "claim.view", item=item)
    assert_not_found(resp, hides=claim)


def test_claim_view__guest__revoked_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    alpha.guest_scoped.revoke()
    resp = call(alpha.guest_scoped, "claim.view", item=item)
    assert_denied(resp, hides=claim)


def test_claim_view__guest__expired_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    alpha.guest_scoped.expire()
    resp = call(alpha.guest_scoped, "claim.view", item=item)
    assert_denied(resp, hides=claim)


def test_claim_view__member__grandma_cross_family_404(beta, grandma):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.family_admin)
    resp = call(grandma.alpha_member, "claim.view", item=item)
    assert_not_found(resp, hides=claim)


def test_claim_view__guest__grandma_cross_family_404(alpha, grandma):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(grandma.beta_guest, "claim.view", item=item)
    assert_not_found(resp, hides=claim)


def test_claim_view__guest__grandma_in_scope_allowed(beta, grandma):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.family_admin)
    resp = call(grandma.beta_guest, "claim.view", item=item)
    assert_allowed(resp, shows=claim)


def test_claim_create__family_admin__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.family_admin, "claim.create", item=item, data={})
    assert_allowed(resp)


def test_claim_create__member__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.member_giver, "claim.create", item=item, data={})
    assert_allowed(resp)


def test_claim_create__guest__allowed(alpha):
    item = alpha.new_item()
    resp = call(alpha.guest_scoped, "claim.create", item=item, data={})
    assert_allowed(resp)


def test_claim_create__guest__not_in_guest_scope_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.guest_unscoped, "claim.create", item=item, data={})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_create__member__is_recipient_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.member_recipient, "claim.create", item=item, data={})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_claim_create__family_admin__is_recipient_denied(alpha):
    admin_list = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(admin_list)
    before = db_state(alpha)
    resp = call(alpha.family_admin, "claim.create", item=item, data={})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_claim_create__family_admin__quantity_exhausted_and_no_duplicates_denied(alpha):
    item = alpha.new_item(quantity=1, allow_duplicates=False)
    alpha.new_claim(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.family_admin, "claim.create", item=item, data={})
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_claim_create__member__quantity_exhausted_and_no_duplicates_denied(alpha):
    item = alpha.new_item(quantity=1, allow_duplicates=False)
    alpha.new_claim(item, by=alpha.family_admin)
    before = db_state(alpha)
    resp = call(alpha.member_giver, "claim.create", item=item, data={})
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_claim_create__guest__quantity_exhausted_and_no_duplicates_denied(alpha):
    item = alpha.new_item(quantity=1, allow_duplicates=False)
    alpha.new_claim(item, by=alpha.family_admin)
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "claim.create", item=item, data={})
    assert_rejected(resp)
    assert db_state(alpha) == before


def test_claim_create__member__quantity_exhausted_with_duplicates_allowed(alpha):
    item = alpha.new_item(quantity=1, allow_duplicates=True)
    alpha.new_claim(item, by=alpha.family_admin)
    resp = call(alpha.member_giver, "claim.create", item=item, data={})
    assert_allowed(resp)


def test_claim_create__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(anonymous, "claim.create", item=item, data={})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_create__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(instance_admin, "claim.create", item=item, data={})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_create__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "claim.create", item=item, data={})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_create__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.family_admin, "claim.create", item=item, data={})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_claim_create__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.member_giver, "claim.create", item=item, data={})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_claim_create__guest__cross_family_404(alpha, beta):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(alpha.guest_scoped, "claim.create", item=item, data={})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_claim_create__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(instance_admin, "claim.create", item=item, data={})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_claim_create__guest__revoked_denied(alpha):
    item = alpha.new_item()
    alpha.guest_scoped.revoke()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "claim.create", item=item, data={})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_create__guest__expired_denied(alpha):
    item = alpha.new_item()
    alpha.guest_scoped.expire()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "claim.create", item=item, data={})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_create__member__grandma_cross_family_404(beta, grandma):
    item = beta.new_item()
    before = db_state(beta)
    resp = call(grandma.alpha_member, "claim.create", item=item, data={})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_claim_create__guest__grandma_cross_family_404(alpha, grandma):
    item = alpha.new_item()
    before = db_state(alpha)
    resp = call(grandma.beta_guest, "claim.create", item=item, data={})
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_claim_create__guest__grandma_in_scope_allowed(beta, grandma):
    item = beta.new_item()
    resp = call(grandma.beta_guest, "claim.create", item=item, data={})
    assert_allowed(resp)


def test_claim_release__family_admin__any_claim_allowed(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    resp = call(alpha.family_admin, "claim.release", claim=claim)
    assert_allowed(resp)


def test_claim_release__member__allowed(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    resp = call(alpha.member_giver, "claim.release", claim=claim)
    assert_allowed(resp)


def test_claim_release__guest__allowed(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.guest_scoped)
    resp = call(alpha.guest_scoped, "claim.release", claim=claim)
    assert_allowed(resp)


def test_claim_release__family_admin__is_claimer_allowed(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(alpha.family_admin, "claim.release", claim=claim)
    assert_allowed(resp)


def test_claim_release__member__not_is_claimer_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    before = db_state(alpha)
    resp = call(alpha.member_giver, "claim.release", claim=claim)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_release__guest__not_is_claimer_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "claim.release", claim=claim)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_release__member__is_recipient_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.member_recipient, "claim.release", claim=claim)
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_claim_release__family_admin__is_recipient_denied(alpha):
    admin_list = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(admin_list)
    claim = alpha.new_claim(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.family_admin, "claim.release", claim=claim)
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_claim_release__anonymous__not_in_allow_denied(alpha, anonymous):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(anonymous, "claim.release", claim=claim)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_release__instance_admin__not_in_allow_denied(alpha, instance_admin):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(instance_admin, "claim.release", claim=claim)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_release__assignment_link__not_in_allow_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "claim.release", claim=claim)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_release__family_admin__cross_family_404(alpha, beta):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.family_admin, "claim.release", claim=claim)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_claim_release__member__cross_family_404(alpha, beta):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.member_giver, "claim.release", claim=claim)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_claim_release__guest__cross_family_404(alpha, beta):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.member_giver)
    before = db_state(beta)
    resp = call(alpha.guest_scoped, "claim.release", claim=claim)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_claim_release__instance_admin__g2_not_same_family_404(alpha, instance_admin):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(instance_admin, "claim.release", claim=claim)
    assert_not_found(resp)
    assert db_state(alpha) == before


def test_claim_release__guest__revoked_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.guest_scoped)
    alpha.guest_scoped.revoke()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "claim.release", claim=claim)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_release__guest__expired_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.guest_scoped)
    alpha.guest_scoped.expire()
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "claim.release", claim=claim)
    assert_denied(resp)
    assert db_state(alpha) == before


def test_claim_release__member__grandma_cross_family_404(beta, grandma):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.member_giver)
    before = db_state(beta)
    resp = call(grandma.alpha_member, "claim.release", claim=claim)
    assert_not_found(resp)
    assert db_state(beta) == before


def test_claim_release__guest__grandma_cross_family_404(alpha, grandma):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    before = db_state(alpha)
    resp = call(grandma.beta_guest, "claim.release", claim=claim)
    assert_not_found(resp)
    assert db_state(alpha) == before
