"""Matrix rules: family.* (generated from docs/authz-matrix.yaml, version 1)."""

import pytest

from .helpers import (
    assert_allowed,
    assert_denied,
    assert_not_found,
    call,
    db_state,
)

pytestmark = pytest.mark.django_db


def test_family_create__instance_admin__allowed(instance_admin):
    resp = call(instance_admin, "family.create", data={"name": "Gamma"})
    assert_allowed(resp)


def test_family_create__anonymous__not_in_allow_denied(anonymous):
    before = db_state(None)
    resp = call(anonymous, "family.create", data={"name": "Gamma"})
    assert_denied(resp)
    assert db_state(None) == before


def test_family_create__family_admin__not_in_allow_denied(alpha):
    before = db_state(None)
    resp = call(alpha.family_admin, "family.create", data={"name": "Gamma"})
    assert_denied(resp)
    assert db_state(None) == before


def test_family_create__member__not_in_allow_denied(alpha):
    before = db_state(None)
    resp = call(alpha.member_giver, "family.create", data={"name": "Gamma"})
    assert_denied(resp)
    assert db_state(None) == before


def test_family_create__guest__not_in_allow_denied(alpha):
    before = db_state(None)
    resp = call(alpha.guest_scoped, "family.create", data={"name": "Gamma"})
    assert_denied(resp)
    assert db_state(None) == before


def test_family_create__assignment_link__not_in_allow_denied(alpha):
    before = db_state(None)
    resp = call(alpha.assignee_link, "family.create", data={"name": "Gamma"})
    assert_denied(resp)
    assert db_state(None) == before


def test_family_delete__instance_admin__allowed(alpha, instance_admin):
    family = alpha.family
    resp = call(instance_admin, "family.delete", family=family)
    assert_allowed(resp)


def test_family_delete__anonymous__not_in_allow_denied(alpha, anonymous):
    family = alpha.family
    before = db_state(None)
    resp = call(anonymous, "family.delete", family=family)
    assert_denied(resp)
    assert db_state(None) == before


def test_family_delete__family_admin__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(None)
    resp = call(alpha.family_admin, "family.delete", family=family)
    assert_denied(resp)
    assert db_state(None) == before


def test_family_delete__member__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(None)
    resp = call(alpha.member_giver, "family.delete", family=family)
    assert_denied(resp)
    assert db_state(None) == before


def test_family_delete__guest__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(None)
    resp = call(alpha.guest_scoped, "family.delete", family=family)
    assert_denied(resp)
    assert db_state(None) == before


def test_family_delete__assignment_link__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(None)
    resp = call(alpha.assignee_link, "family.delete", family=family)
    assert_denied(resp)
    assert db_state(None) == before


def test_family_view_settings__family_admin__allowed(alpha):
    family = alpha.family
    resp = call(alpha.family_admin, "family.view_settings", family=family)
    assert_allowed(resp, shows=family)


def test_family_view_settings__anonymous__not_in_allow_denied(alpha, anonymous):
    family = alpha.family
    resp = call(anonymous, "family.view_settings", family=family)
    assert_denied(resp, hides=family)


def test_family_view_settings__instance_admin__not_in_allow_denied(alpha, instance_admin):
    family = alpha.family
    resp = call(instance_admin, "family.view_settings", family=family)
    assert_denied(resp, hides=family)


def test_family_view_settings__member__not_in_allow_denied(alpha):
    family = alpha.family
    resp = call(alpha.member_giver, "family.view_settings", family=family)
    assert_denied(resp, hides=family)


def test_family_view_settings__guest__not_in_allow_denied(alpha):
    family = alpha.family
    resp = call(alpha.guest_scoped, "family.view_settings", family=family)
    assert_denied(resp, hides=family)


def test_family_view_settings__assignment_link__not_in_allow_denied(alpha):
    family = alpha.family
    resp = call(alpha.assignee_link, "family.view_settings", family=family)
    assert_denied(resp, hides=family)


def test_family_view_settings__family_admin__cross_family_404(alpha, beta):
    family = beta.family
    resp = call(alpha.family_admin, "family.view_settings", family=family)
    assert_not_found(resp, hides=family)


def test_family_view_settings__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    family = beta.family
    resp = call(grandma.beta_guest, "family.view_settings", family=family)
    assert_denied(resp, hides=family)


def test_family_update_settings__family_admin__allowed(alpha):
    family = alpha.family
    resp = call(alpha.family_admin, "family.update_settings", family=family, data={"name": "Renamed family"})
    assert_allowed(resp)


def test_family_update_settings__anonymous__not_in_allow_denied(alpha, anonymous):
    family = alpha.family
    before = db_state(alpha)
    resp = call(anonymous, "family.update_settings", family=family, data={"name": "Renamed family"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_family_update_settings__instance_admin__not_in_allow_denied(alpha, instance_admin):
    family = alpha.family
    before = db_state(alpha)
    resp = call(instance_admin, "family.update_settings", family=family, data={"name": "Renamed family"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_family_update_settings__member__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(alpha)
    resp = call(alpha.member_giver, "family.update_settings", family=family, data={"name": "Renamed family"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_family_update_settings__guest__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(alpha)
    resp = call(alpha.guest_scoped, "family.update_settings", family=family, data={"name": "Renamed family"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_family_update_settings__assignment_link__not_in_allow_denied(alpha):
    family = alpha.family
    before = db_state(alpha)
    resp = call(alpha.assignee_link, "family.update_settings", family=family, data={"name": "Renamed family"})
    assert_denied(resp)
    assert db_state(alpha) == before


def test_family_update_settings__family_admin__cross_family_404(alpha, beta):
    family = beta.family
    before = db_state(beta)
    resp = call(alpha.family_admin, "family.update_settings", family=family, data={"name": "Renamed family"})
    assert_not_found(resp)
    assert db_state(beta) == before


def test_family_update_settings__guest__grandma_beta_guest_not_member_denied(beta, grandma):
    family = beta.family
    before = db_state(beta)
    resp = call(grandma.beta_guest, "family.update_settings", family=family, data={"name": "Renamed family"})
    assert_denied(resp)
    assert db_state(beta) == before
