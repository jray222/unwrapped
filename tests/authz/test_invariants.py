"""Invariants I1-I5 (generated from docs/authz-matrix.yaml, version 1)."""

import logging
import re

import pytest

from .helpers import (
    TABLES,
    app_role_flags,
    assert_allowed,
    assert_exchanged,
    assert_mfa_required,
    assert_not_found,
    assert_rejected,
    call,
    call_missing,
    db_state,
    logout_url,
    mfa_enroll_url,
    normalize,
    random_token,
    rls_count_for_list,
    rls_family_ids,
    rls_update_rowcount,
    sha256_hex,
    stored_token_values,
    table_rls_flags,
    text_of,
    token_lifetime_days,
)

pytestmark = pytest.mark.django_db


def _seed(f):
    return f.recipient_list, [f.new_item() for _ in range(3)]


def _recipient_views(f, lst, items):
    responses = [call(f.member_recipient, "list.view", list=lst)]
    responses += [call(f.member_recipient, "item.view", item=item) for item in items]
    assert all(r.status_code == 200 for r in responses)
    return [normalize(r, lst, *items) for r in responses]


def test_i1_recipient_views__claim_added_response_unchanged(alpha):
    lst, items = _seed(alpha)
    before = _recipient_views(alpha, lst, items)
    alpha.new_claim(items[1], by=alpha.member_giver)
    assert _recipient_views(alpha, lst, items) == before


def test_i1_recipient_views__all_items_claimed_response_unchanged(alpha):
    lst, items = _seed(alpha)
    before = _recipient_views(alpha, lst, items)
    for item in items:
        alpha.new_claim(item, by=alpha.member_giver)
    assert _recipient_views(alpha, lst, items) == before


def test_i1_recipient_views__claim_released_response_unchanged(alpha):
    lst, items = _seed(alpha)
    before = _recipient_views(alpha, lst, items)
    claim = alpha.new_claim(items[1], by=alpha.member_giver)
    assert_allowed(call(alpha.member_giver, "claim.release", claim=claim))
    assert _recipient_views(alpha, lst, items) == before


def test_i1_recipient_views__pledge_added_response_unchanged(alpha):
    lst, items = _seed(alpha)
    before = _recipient_views(alpha, lst, items)
    alpha.new_pledge(items[1], by=alpha.family_admin)
    assert _recipient_views(alpha, lst, items) == before


def test_i1_recipient_views__assignment_added_response_unchanged(alpha):
    lst, items = _seed(alpha)
    before = _recipient_views(alpha, lst, items)
    alpha.new_assignment(items[1], assigner=alpha.member_giver, assignee=alpha.assignee_link)
    assert _recipient_views(alpha, lst, items) == before


def test_i1_recipient_views__assignment_couldnt_get_response_unchanged(alpha):
    lst, items = _seed(alpha)
    before = _recipient_views(alpha, lst, items)
    assignment = alpha.new_assignment(
        items[1], assigner=alpha.member_giver, assignee=alpha.assignee_link
    )
    resp = call(alpha.assignee_link, "assignment.mark_couldnt_get", assignment=assignment)
    assert_allowed(resp)
    assert _recipient_views(alpha, lst, items) == before


def test_i1_recipient_pages__no_claim_pledge_or_assignment_markers(alpha):
    lst, items = _seed(alpha)
    alpha.new_claim(items[0], by=alpha.member_giver)
    alpha.new_pledge(items[1], by=alpha.family_admin)
    alpha.new_assignment(items[2], assigner=alpha.member_giver, assignee=alpha.assignee_link)
    pages = [call(alpha.member_recipient, "list.view", list=lst)]
    pages += [call(alpha.member_recipient, "item.view", item=item) for item in items]
    leaks = [
        "Taken by",
        alpha.member_giver.first_name,
        alpha.family_admin.first_name,
        alpha.assignee_link.first_name,
    ]
    for page in pages:
        assert page.status_code == 200
        for leak in leaks:
            assert leak not in text_of(page)


def test_i1_non_recipient_sees_claim_state__control(alpha):
    lst, items = _seed(alpha)
    alpha.new_claim(items[0], by=alpha.family_admin)
    resp = call(alpha.member_giver, "list.view", list=lst)
    assert_allowed(resp)
    assert f"Taken by {alpha.family_admin.first_name}" in text_of(resp)


def test_i1_recipient_claim_endpoints__claimed_matches_unclaimed(alpha):
    plain, claimed = alpha.new_item(), alpha.new_item()
    alpha.new_claim(claimed, by=alpha.member_giver)
    for rule_name, data in (("claim.view", None), ("claim.create", {})):
        a = call(alpha.member_recipient, rule_name, data=data, item=plain)
        b = call(alpha.member_recipient, rule_name, data=data, item=claimed)
        assert_not_found(a)
        assert normalize(a, plain) == normalize(b, claimed)


def test_i1_recipient_pledge_endpoints__pledged_matches_unpledged(alpha):
    plain, pledged = alpha.new_item(), alpha.new_item()
    alpha.new_pledge(pledged, by=alpha.member_giver)
    for rule_name, data in (("pledge.view", None), ("pledge.create", {"amount_cents": 2500})):
        a = call(alpha.member_recipient, rule_name, data=data, item=plain)
        b = call(alpha.member_recipient, rule_name, data=data, item=pledged)
        assert_not_found(a)
        assert normalize(a, plain) == normalize(b, pledged)


def test_i1_recipient_assignment_create__assigned_matches_unassigned(alpha):
    plain, assigned = alpha.new_item(), alpha.new_item()
    alpha.new_assignment(assigned, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    data = {"assignee": alpha.assignee_link.ref}
    a = call(alpha.member_recipient, "assignment.create", data=data, item=plain)
    b = call(alpha.member_recipient, "assignment.create", data=data, item=assigned)
    assert_not_found(a)
    assert normalize(a, plain) == normalize(b, assigned)


def test_i1_recipient_claim_release__existing_matches_nonexistent(alpha):
    claim = alpha.new_claim(alpha.new_item(), by=alpha.member_giver)
    real = call(alpha.member_recipient, "claim.release", claim=claim)
    fake, missing = call_missing(alpha.member_recipient, "claim.release")
    assert_not_found(real)
    assert normalize(real, claim) == normalize(fake, missing)


def test_i1_recipient_pledge_update__existing_matches_nonexistent(alpha):
    pledge = alpha.new_pledge(alpha.new_item(), by=alpha.member_giver)
    data = {"amount_cents": 3000}
    real = call(alpha.member_recipient, "pledge.update", data=data, pledge=pledge)
    fake, missing = call_missing(alpha.member_recipient, "pledge.update", data=data)
    assert_not_found(real)
    assert normalize(real, pledge) == normalize(fake, missing)


def test_i1_recipient_assignment_view__existing_matches_nonexistent(alpha):
    assignment = alpha.new_assignment(
        alpha.new_item(), assigner=alpha.member_giver, assignee=alpha.assignee_link
    )
    real = call(alpha.member_recipient, "assignment.view", assignment=assignment)
    fake, missing = call_missing(alpha.member_recipient, "assignment.view")
    assert_not_found(real)
    assert normalize(real, assignment) == normalize(fake, missing)


def test_i1_recipient_assignment_actions__existing_matches_nonexistent(alpha):
    assignment = alpha.new_assignment(
        alpha.new_item(), assigner=alpha.member_giver, assignee=alpha.assignee_link
    )
    for rule_name in (
        "assignment.mark_bought",
        "assignment.mark_couldnt_get",
        "assignment.cancel",
        "assignment.share_card",
    ):
        real = call(alpha.member_recipient, rule_name, assignment=assignment)
        fake, missing = call_missing(alpha.member_recipient, rule_name)
        assert_not_found(real)
        assert normalize(real, assignment) == normalize(fake, missing)


def test_i1_recipient_item_update__claimed_matches_unclaimed(alpha):
    plain, claimed = alpha.new_item(), alpha.new_item()
    alpha.new_claim(claimed, by=alpha.member_giver)
    data = {"name": "Green scarf"}
    a = call(alpha.member_recipient, "item.update", data=data, item=plain)
    b = call(alpha.member_recipient, "item.update", data=data, item=claimed)
    assert_allowed(a)
    assert normalize(a, plain) == normalize(b, claimed)


def test_i1_recipient_item_delete__claimed_matches_unclaimed(alpha):
    plain, claimed = alpha.new_item(), alpha.new_item()
    alpha.new_claim(claimed, by=alpha.member_giver)
    a = call(alpha.member_recipient, "item.delete", item=plain)
    b = call(alpha.member_recipient, "item.delete", item=claimed)
    assert_allowed(a)
    assert normalize(a, plain) == normalize(b, claimed)


def test_i1_recipient_item_update__claimer_notified_recipient_not(alpha):
    item = alpha.new_item()
    alpha.new_claim(item, by=alpha.member_giver)
    giver_before = len(alpha.notifications_for(alpha.member_giver))
    recipient_before = len(alpha.notifications_for(alpha.member_recipient))
    resp = call(alpha.member_recipient, "item.update", data={"name": "Green scarf"}, item=item)
    assert_allowed(resp)
    assert len(alpha.notifications_for(alpha.member_giver)) == giver_before + 1
    assert len(alpha.notifications_for(alpha.member_recipient)) == recipient_before


def test_i1_recipient_item_delete__claimer_notified_recipient_not(alpha):
    item = alpha.new_item()
    alpha.new_claim(item, by=alpha.member_giver)
    giver_before = len(alpha.notifications_for(alpha.member_giver))
    recipient_before = len(alpha.notifications_for(alpha.member_recipient))
    assert_allowed(call(alpha.member_recipient, "item.delete", item=item))
    assert len(alpha.notifications_for(alpha.member_giver)) == giver_before + 1
    assert len(alpha.notifications_for(alpha.member_recipient)) == recipient_before


def test_i1_audit_log__family_admin_recipient_cannot_see_claim_entries(alpha):
    admin_list = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(admin_list)
    claim = alpha.new_claim(item, by=alpha.member_giver)
    resp = call(alpha.family_admin, "audit_log.view", family=alpha.family)
    assert_allowed(resp)
    assert claim.marker not in text_of(resp)


def test_i2_family_view_settings__family_admin__cross_family_matches_nonexistent(alpha, beta):
    family = beta.family
    resp = call(alpha.family_admin, "family.view_settings", family=family)
    missing_resp, missing = call_missing(alpha.family_admin, "family.view_settings")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, family) == normalize(missing_resp, missing)


def test_i2_family_update_settings__family_admin__cross_family_matches_nonexistent(alpha, beta):
    family = beta.family
    resp = call(alpha.family_admin, "family.update_settings", family=family, data={"name": "Renamed family"})
    missing_resp, missing = call_missing(alpha.family_admin, "family.update_settings", data={"name": "Renamed family"})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, family) == normalize(missing_resp, missing)


def test_i2_invite_create__family_admin__cross_family_matches_nonexistent(alpha, beta):
    family = beta.family
    resp = call(alpha.family_admin, "invite.create", family=family, data={"email": "new.person@example.test"})
    missing_resp, missing = call_missing(alpha.family_admin, "invite.create", data={"email": "new.person@example.test"})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, family) == normalize(missing_resp, missing)


def test_i2_invite_revoke__family_admin__cross_family_matches_nonexistent(alpha, beta):
    invite = beta.new_invite()
    resp = call(alpha.family_admin, "invite.revoke", invite=invite)
    missing_resp, missing = call_missing(alpha.family_admin, "invite.revoke")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, invite) == normalize(missing_resp, missing)


def test_i2_member_list__family_admin__cross_family_matches_nonexistent(alpha, beta):
    family = beta.family
    beta.member_recipient
    resp = call(alpha.family_admin, "member.list", family=family)
    missing_resp, missing = call_missing(alpha.family_admin, "member.list")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, family) == normalize(missing_resp, missing)


def test_i2_member_list__member__cross_family_matches_nonexistent(alpha, beta):
    family = beta.family
    beta.member_recipient
    resp = call(alpha.member_giver, "member.list", family=family)
    missing_resp, missing = call_missing(alpha.member_giver, "member.list")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, family) == normalize(missing_resp, missing)


def test_i2_member_remove__family_admin__cross_family_matches_nonexistent(alpha, beta):
    membership = beta.membership_of(beta.member_giver)
    resp = call(alpha.family_admin, "member.remove", member=membership)
    missing_resp, missing = call_missing(alpha.family_admin, "member.remove")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, membership) == normalize(missing_resp, missing)


def test_i2_member_change_role__family_admin__cross_family_matches_nonexistent(alpha, beta):
    membership = beta.membership_of(beta.member_giver)
    resp = call(alpha.family_admin, "member.change_role", member=membership, data={"role": "family_admin"})
    missing_resp, missing = call_missing(alpha.family_admin, "member.change_role", data={"role": "family_admin"})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, membership) == normalize(missing_resp, missing)


def test_i2_member_leave__family_admin__cross_family_matches_nonexistent(alpha, beta):
    membership = beta.membership_of(beta.member_giver)
    resp = call(alpha.family_admin, "member.leave", member=membership)
    missing_resp, missing = call_missing(alpha.family_admin, "member.leave")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, membership) == normalize(missing_resp, missing)


def test_i2_member_leave__member__cross_family_matches_nonexistent(alpha, beta):
    membership = beta.membership_of(beta.member_giver)
    resp = call(alpha.member_giver, "member.leave", member=membership)
    missing_resp, missing = call_missing(alpha.member_giver, "member.leave")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, membership) == normalize(missing_resp, missing)


def test_i2_guest_link_issue__family_admin__cross_family_matches_nonexistent(alpha, beta):
    family = beta.family
    resp = call(alpha.family_admin, "guest_link.issue", family=family, data={"lists": [beta.recipient_list.ref], "person": "Aunt May"})
    missing_resp, missing = call_missing(alpha.family_admin, "guest_link.issue", data={"lists": [beta.recipient_list.ref], "person": "Aunt May"})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, family) == normalize(missing_resp, missing)


def test_i2_guest_link_issue__member__cross_family_matches_nonexistent(alpha, beta):
    family = beta.family
    resp = call(alpha.member_giver, "guest_link.issue", family=family, data={"lists": [beta.recipient_list.ref], "person": "Aunt May"})
    missing_resp, missing = call_missing(alpha.member_giver, "guest_link.issue", data={"lists": [beta.recipient_list.ref], "person": "Aunt May"})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, family) == normalize(missing_resp, missing)


def test_i2_guest_link_revoke__family_admin__cross_family_matches_nonexistent(alpha, beta):
    guest_link = beta.new_guest_link(issued_by=beta.member_giver)
    resp = call(alpha.family_admin, "guest_link.revoke", guest_link=guest_link)
    missing_resp, missing = call_missing(alpha.family_admin, "guest_link.revoke")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, guest_link) == normalize(missing_resp, missing)


def test_i2_guest_link_revoke__member__cross_family_matches_nonexistent(alpha, beta):
    guest_link = beta.new_guest_link(issued_by=beta.member_giver)
    resp = call(alpha.member_giver, "guest_link.revoke", guest_link=guest_link)
    missing_resp, missing = call_missing(alpha.member_giver, "guest_link.revoke")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, guest_link) == normalize(missing_resp, missing)


def test_i2_list_create__family_admin__cross_family_matches_nonexistent(alpha, beta):
    family = beta.family
    resp = call(alpha.family_admin, "list.create", family=family, data={"title": "Spring wishes", "recipient": beta.member_recipient.ref})
    missing_resp, missing = call_missing(alpha.family_admin, "list.create", data={"title": "Spring wishes", "recipient": beta.member_recipient.ref})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, family) == normalize(missing_resp, missing)


def test_i2_list_create__member__cross_family_matches_nonexistent(alpha, beta):
    family = beta.family
    resp = call(alpha.member_giver, "list.create", family=family, data={"title": "Spring wishes", "recipient": beta.member_recipient.ref})
    missing_resp, missing = call_missing(alpha.member_giver, "list.create", data={"title": "Spring wishes", "recipient": beta.member_recipient.ref})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, family) == normalize(missing_resp, missing)


def test_i2_list_view__family_admin__cross_family_matches_nonexistent(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.family_admin, "list.view", list=lst)
    missing_resp, missing = call_missing(alpha.family_admin, "list.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, lst) == normalize(missing_resp, missing)


def test_i2_list_view__member__cross_family_matches_nonexistent(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.member_giver, "list.view", list=lst)
    missing_resp, missing = call_missing(alpha.member_giver, "list.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, lst) == normalize(missing_resp, missing)


def test_i2_list_view__guest__cross_family_matches_nonexistent(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.guest_scoped, "list.view", list=lst)
    missing_resp, missing = call_missing(alpha.guest_scoped, "list.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, lst) == normalize(missing_resp, missing)


def test_i2_list_update__family_admin__cross_family_matches_nonexistent(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.family_admin, "list.update", list=lst, data={"title": "Renamed list"})
    missing_resp, missing = call_missing(alpha.family_admin, "list.update", data={"title": "Renamed list"})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, lst) == normalize(missing_resp, missing)


def test_i2_list_update__member__cross_family_matches_nonexistent(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.member_giver, "list.update", list=lst, data={"title": "Renamed list"})
    missing_resp, missing = call_missing(alpha.member_giver, "list.update", data={"title": "Renamed list"})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, lst) == normalize(missing_resp, missing)


def test_i2_list_delete__family_admin__cross_family_matches_nonexistent(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.family_admin, "list.delete", list=lst)
    missing_resp, missing = call_missing(alpha.family_admin, "list.delete")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, lst) == normalize(missing_resp, missing)


def test_i2_list_delete__member__cross_family_matches_nonexistent(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.member_giver, "list.delete", list=lst)
    missing_resp, missing = call_missing(alpha.member_giver, "list.delete")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, lst) == normalize(missing_resp, missing)


def test_i2_item_view__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.family_admin, "item.view", item=item)
    missing_resp, missing = call_missing(alpha.family_admin, "item.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_item_view__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.member_giver, "item.view", item=item)
    missing_resp, missing = call_missing(alpha.member_giver, "item.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_item_view__guest__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.guest_scoped, "item.view", item=item)
    missing_resp, missing = call_missing(alpha.guest_scoped, "item.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_item_create__family_admin__cross_family_matches_nonexistent(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.family_admin, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    missing_resp, missing = call_missing(alpha.family_admin, "item.create", data={"name": "Blue scarf", "quantity": 1})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, lst) == normalize(missing_resp, missing)


def test_i2_item_create__member__cross_family_matches_nonexistent(alpha, beta):
    lst = beta.recipient_list
    resp = call(alpha.member_giver, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    missing_resp, missing = call_missing(alpha.member_giver, "item.create", data={"name": "Blue scarf", "quantity": 1})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, lst) == normalize(missing_resp, missing)


def test_i2_item_update__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.family_admin, "item.update", item=item, data={"name": "Green scarf"})
    missing_resp, missing = call_missing(alpha.family_admin, "item.update", data={"name": "Green scarf"})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_item_update__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.member_giver, "item.update", item=item, data={"name": "Green scarf"})
    missing_resp, missing = call_missing(alpha.member_giver, "item.update", data={"name": "Green scarf"})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_item_delete__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.family_admin, "item.delete", item=item)
    missing_resp, missing = call_missing(alpha.family_admin, "item.delete")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_item_delete__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.member_giver, "item.delete", item=item)
    missing_resp, missing = call_missing(alpha.member_giver, "item.delete")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_claim_view__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    beta.new_claim(item, by=beta.family_admin)
    resp = call(alpha.family_admin, "claim.view", item=item)
    missing_resp, missing = call_missing(alpha.family_admin, "claim.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_claim_view__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    beta.new_claim(item, by=beta.family_admin)
    resp = call(alpha.member_giver, "claim.view", item=item)
    missing_resp, missing = call_missing(alpha.member_giver, "claim.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_claim_view__guest__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    beta.new_claim(item, by=beta.family_admin)
    resp = call(alpha.guest_scoped, "claim.view", item=item)
    missing_resp, missing = call_missing(alpha.guest_scoped, "claim.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_claim_create__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.family_admin, "claim.create", item=item, data={})
    missing_resp, missing = call_missing(alpha.family_admin, "claim.create", data={})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_claim_create__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.member_giver, "claim.create", item=item, data={})
    missing_resp, missing = call_missing(alpha.member_giver, "claim.create", data={})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_claim_create__guest__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.guest_scoped, "claim.create", item=item, data={})
    missing_resp, missing = call_missing(alpha.guest_scoped, "claim.create", data={})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_claim_release__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.member_giver)
    resp = call(alpha.family_admin, "claim.release", claim=claim)
    missing_resp, missing = call_missing(alpha.family_admin, "claim.release")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, claim) == normalize(missing_resp, missing)


def test_i2_claim_release__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.member_giver)
    resp = call(alpha.member_giver, "claim.release", claim=claim)
    missing_resp, missing = call_missing(alpha.member_giver, "claim.release")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, claim) == normalize(missing_resp, missing)


def test_i2_claim_release__guest__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    claim = beta.new_claim(item, by=beta.member_giver)
    resp = call(alpha.guest_scoped, "claim.release", claim=claim)
    missing_resp, missing = call_missing(alpha.guest_scoped, "claim.release")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, claim) == normalize(missing_resp, missing)


def test_i2_pledge_view__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    beta.new_pledge(item, by=beta.family_admin)
    resp = call(alpha.family_admin, "pledge.view", item=item)
    missing_resp, missing = call_missing(alpha.family_admin, "pledge.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_pledge_view__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    beta.new_pledge(item, by=beta.family_admin)
    resp = call(alpha.member_giver, "pledge.view", item=item)
    missing_resp, missing = call_missing(alpha.member_giver, "pledge.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_pledge_view__guest__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    beta.new_pledge(item, by=beta.family_admin)
    resp = call(alpha.guest_scoped, "pledge.view", item=item)
    missing_resp, missing = call_missing(alpha.guest_scoped, "pledge.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_pledge_create__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.family_admin, "pledge.create", item=item, data={"amount_cents": 2500})
    missing_resp, missing = call_missing(alpha.family_admin, "pledge.create", data={"amount_cents": 2500})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_pledge_create__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.member_giver, "pledge.create", item=item, data={"amount_cents": 2500})
    missing_resp, missing = call_missing(alpha.member_giver, "pledge.create", data={"amount_cents": 2500})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_pledge_create__guest__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.guest_scoped, "pledge.create", item=item, data={"amount_cents": 2500})
    missing_resp, missing = call_missing(alpha.guest_scoped, "pledge.create", data={"amount_cents": 2500})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_pledge_update__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.member_giver)
    resp = call(alpha.family_admin, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    missing_resp, missing = call_missing(alpha.family_admin, "pledge.update", data={"amount_cents": 3000})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, pledge) == normalize(missing_resp, missing)


def test_i2_pledge_update__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.member_giver)
    resp = call(alpha.member_giver, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    missing_resp, missing = call_missing(alpha.member_giver, "pledge.update", data={"amount_cents": 3000})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, pledge) == normalize(missing_resp, missing)


def test_i2_pledge_update__guest__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    pledge = beta.new_pledge(item, by=beta.member_giver)
    resp = call(alpha.guest_scoped, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    missing_resp, missing = call_missing(alpha.guest_scoped, "pledge.update", data={"amount_cents": 3000})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, pledge) == normalize(missing_resp, missing)


def test_i2_assignment_create__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.family_admin, "assignment.create", item=item, data={"assignee": beta.assignee_link.ref})
    missing_resp, missing = call_missing(alpha.family_admin, "assignment.create", data={"assignee": beta.assignee_link.ref})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_assignment_create__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    resp = call(alpha.member_giver, "assignment.create", item=item, data={"assignee": beta.assignee_link.ref})
    missing_resp, missing = call_missing(alpha.member_giver, "assignment.create", data={"assignee": beta.assignee_link.ref})
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, item) == normalize(missing_resp, missing)


def test_i2_assignment_view__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.family_admin, "assignment.view", assignment=assignment)
    missing_resp, missing = call_missing(alpha.family_admin, "assignment.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_view__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.member_giver, "assignment.view", assignment=assignment)
    missing_resp, missing = call_missing(alpha.member_giver, "assignment.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_view__assignment_link__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.assignee_link, "assignment.view", assignment=assignment)
    missing_resp, missing = call_missing(alpha.assignee_link, "assignment.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_mark_bought__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.family_admin, "assignment.mark_bought", assignment=assignment)
    missing_resp, missing = call_missing(alpha.family_admin, "assignment.mark_bought")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_mark_bought__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.member_giver, "assignment.mark_bought", assignment=assignment)
    missing_resp, missing = call_missing(alpha.member_giver, "assignment.mark_bought")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_mark_bought__assignment_link__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.assignee_link, "assignment.mark_bought", assignment=assignment)
    missing_resp, missing = call_missing(alpha.assignee_link, "assignment.mark_bought")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_mark_couldnt_get__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.family_admin, "assignment.mark_couldnt_get", assignment=assignment)
    missing_resp, missing = call_missing(alpha.family_admin, "assignment.mark_couldnt_get")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_mark_couldnt_get__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.member_giver, "assignment.mark_couldnt_get", assignment=assignment)
    missing_resp, missing = call_missing(alpha.member_giver, "assignment.mark_couldnt_get")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_mark_couldnt_get__assignment_link__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.assignee_link, "assignment.mark_couldnt_get", assignment=assignment)
    missing_resp, missing = call_missing(alpha.assignee_link, "assignment.mark_couldnt_get")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_cancel__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.family_admin, "assignment.cancel", assignment=assignment)
    missing_resp, missing = call_missing(alpha.family_admin, "assignment.cancel")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_cancel__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.member_giver, "assignment.cancel", assignment=assignment)
    missing_resp, missing = call_missing(alpha.member_giver, "assignment.cancel")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_share_card__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.family_admin, "assignment.share_card", assignment=assignment)
    missing_resp, missing = call_missing(alpha.family_admin, "assignment.share_card")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_assignment_share_card__member__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    assignment = beta.new_assignment(item, assigner=beta.member_giver, assignee=beta.assignee_link)
    resp = call(alpha.member_giver, "assignment.share_card", assignment=assignment)
    missing_resp, missing = call_missing(alpha.member_giver, "assignment.share_card")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, assignment) == normalize(missing_resp, missing)


def test_i2_audit_log_view__family_admin__cross_family_matches_nonexistent(alpha, beta):
    item = beta.new_item()
    beta.new_claim(item, by=beta.member_giver)
    family = beta.family
    resp = call(alpha.family_admin, "audit_log.view", family=family)
    missing_resp, missing = call_missing(alpha.family_admin, "audit_log.view")
    assert resp.status_code == 404
    assert missing_resp.status_code == 404
    assert normalize(resp, family) == normalize(missing_resp, missing)


def test_i3_guest_exchange__redirect_has_no_token(alpha, anonymous):
    token = alpha.guest_scoped.token
    resp = call(anonymous, "guest_link.exchange", token=token)
    assert_exchanged(resp, token)


def test_i3_guest_exchange__session_cookie_flags(alpha, anonymous):
    token = alpha.guest_scoped.token
    resp = call(anonymous, "guest_link.exchange", token=token)
    assert resp.cookies
    for cookie in resp.cookies.values():
        assert cookie["httponly"]
        assert cookie["secure"]
        assert cookie["samesite"] == "Lax"
        assert token not in cookie.value


def test_i3_guest_exchange__final_page_has_no_token_and_no_referrer(alpha, anonymous):
    token = alpha.guest_scoped.token
    resp = call(anonymous, "guest_link.exchange", token=token)
    clean = anonymous.client.get(resp["Location"])
    assert clean.status_code == 200
    for page in (resp, clean):
        assert page["Referrer-Policy"] == "no-referrer"
        assert token not in text_of(page)
    assert token not in resp["Location"]
    assert token not in clean.request["PATH_INFO"]
    assert token not in clean.request["QUERY_STRING"]


def test_i3_assignment_exchange__redirect_has_no_token(alpha, anonymous):
    token = alpha.assignee_link.token
    resp = call(anonymous, "assignment_link.exchange", token=token)
    assert_exchanged(resp, token)


def test_i3_assignment_exchange__session_cookie_flags(alpha, anonymous):
    token = alpha.assignee_link.token
    resp = call(anonymous, "assignment_link.exchange", token=token)
    assert resp.cookies
    for cookie in resp.cookies.values():
        assert cookie["httponly"]
        assert cookie["secure"]
        assert cookie["samesite"] == "Lax"
        assert token not in cookie.value


def test_i3_assignment_exchange__final_page_has_no_token_and_no_referrer(alpha, anonymous):
    token = alpha.assignee_link.token
    resp = call(anonymous, "assignment_link.exchange", token=token)
    clean = anonymous.client.get(resp["Location"])
    assert clean.status_code == 200
    for page in (resp, clean):
        assert page["Referrer-Policy"] == "no-referrer"
        assert token not in text_of(page)
    assert token not in resp["Location"]
    assert token not in clean.request["PATH_INFO"]
    assert token not in clean.request["QUERY_STRING"]


def test_i3_guest_exchange__valid_token_not_logged(alpha, anonymous, caplog):
    caplog.set_level(logging.DEBUG)
    token = alpha.guest_scoped.token
    resp = call(anonymous, "guest_link.exchange", token=token)
    anonymous.client.get(resp["Location"])
    assert token not in caplog.text


def test_i3_guest_exchange__invalid_token_not_logged(anonymous, caplog):
    caplog.set_level(logging.DEBUG)
    token = random_token()
    call(anonymous, "guest_link.exchange", token=token)
    assert token not in caplog.text


def test_i3_assignment_exchange__valid_token_not_logged(alpha, anonymous, caplog):
    caplog.set_level(logging.DEBUG)
    token = alpha.assignee_link.token
    resp = call(anonymous, "assignment_link.exchange", token=token)
    anonymous.client.get(resp["Location"])
    assert token not in caplog.text


def test_i3_invite_accept__token_not_logged(alpha, anonymous, caplog):
    caplog.set_level(logging.DEBUG)
    invite = alpha.new_invite()
    call(anonymous, "invite.accept", data={"token": invite.token, "email": invite.email})
    assert invite.token not in caplog.text


def test_i3_invite_token__stored_only_as_hash(alpha):
    invite = alpha.new_invite()
    stored = [str(value) for value in stored_token_values("invite")]
    assert not any(invite.token in value for value in stored)
    assert sha256_hex(invite.token) in stored


def test_i3_guest_link_token__stored_only_as_hash(alpha):
    link = alpha.new_guest_link(issued_by=alpha.member_giver)
    stored = [str(value) for value in stored_token_values("guest_link")]
    assert not any(link.token in value for value in stored)
    assert sha256_hex(link.token) in stored


def test_i3_assignment_link_token__stored_only_as_hash(alpha):
    token = alpha.assignee_link.token
    stored = [str(value) for value in stored_token_values("assignment_link")]
    assert not any(token in value for value in stored)
    assert sha256_hex(token) in stored


def test_i3_invite_token__is_token_urlsafe_32(alpha):
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", alpha.new_invite().token)


def test_i3_guest_link_token__is_token_urlsafe_32(alpha):
    link = alpha.new_guest_link(issued_by=alpha.member_giver)
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", link.token)


def test_i3_assignment_link_token__is_token_urlsafe_32(alpha):
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", alpha.assignee_link.token)


def test_i3_invite_token__lifetime_at_most_seven_days(alpha):
    assert 0 < token_lifetime_days(alpha.new_invite()) <= 7


def test_i3_guest_link_token__lifetime_capped_at_365_days(alpha):
    data = {"lists": [alpha.recipient_list.ref], "person": "Aunt May", "expires_in_days": 400}
    resp = call(alpha.member_giver, "guest_link.issue", family=alpha.family, data=data)
    if resp.status_code < 300:
        assert token_lifetime_days(resp) <= 365
    else:
        assert_rejected(resp)


def test_i3_guest_pages__external_links_use_noopener_noreferrer(alpha):
    alpha.new_item(store_url="https://shop.example.test/scarf")
    resp = call(alpha.guest_scoped, "list.view", list=alpha.recipient_list)
    assert_allowed(resp)
    assert resp["Referrer-Policy"] == "no-referrer"
    anchors = re.findall(r'<a\b[^>]*href="https?://[^"]+"[^>]*>', text_of(resp))
    assert anchors
    assert all("noopener" in a and "noreferrer" in a for a in anchors)


def test_i4_family_create__instance_admin__without_mfa_denied(instance_admin):
    before = db_state(None)
    resp = call(instance_admin.without_mfa(), "family.create", data={"name": "Gamma"})
    assert_mfa_required(resp)
    assert db_state(None) == before


def test_i4_family_delete__instance_admin__without_mfa_denied(alpha, instance_admin):
    family = alpha.family
    before = db_state(None)
    resp = call(instance_admin.without_mfa(), "family.delete", family=family)
    assert_mfa_required(resp)
    assert db_state(None) == before


def test_i4_family_view_settings__family_admin__without_mfa_denied(alpha):
    family = alpha.family
    resp = call(alpha.family_admin.without_mfa(), "family.view_settings", family=family)
    assert_mfa_required(resp)
    assert family.marker not in resp.content.decode()


def test_i4_family_update_settings__family_admin__without_mfa_denied(alpha):
    family = alpha.family
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "family.update_settings", family=family, data={"name": "Renamed family"})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_invite_create__family_admin__without_mfa_denied(alpha):
    family = alpha.family
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "invite.create", family=family, data={"email": "new.person@example.test"})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_invite_revoke__family_admin__without_mfa_denied(alpha):
    invite = alpha.new_invite()
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "invite.revoke", invite=invite)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_member_list__family_admin__without_mfa_denied(alpha):
    family = alpha.family
    shown = alpha.member_recipient
    resp = call(alpha.family_admin.without_mfa(), "member.list", family=family)
    assert_mfa_required(resp)
    assert shown.marker not in resp.content.decode()


def test_i4_member_list__member__without_mfa_denied(alpha):
    family = alpha.family
    shown = alpha.member_recipient
    resp = call(alpha.member_giver.without_mfa(), "member.list", family=family)
    assert_mfa_required(resp)
    assert shown.marker not in resp.content.decode()


def test_i4_member_remove__family_admin__without_mfa_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "member.remove", member=membership)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_member_change_role__family_admin__without_mfa_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "member.change_role", member=membership, data={"role": "family_admin"})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_member_leave__family_admin__without_mfa_denied(alpha):
    alpha.add_family_admin()
    membership = alpha.membership_of(alpha.family_admin)
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "member.leave", member=membership)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_member_leave__member__without_mfa_denied(alpha):
    membership = alpha.membership_of(alpha.member_giver)
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "member.leave", member=membership)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_guest_link_issue__family_admin__without_mfa_denied(alpha):
    family = alpha.family
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "guest_link.issue", family=family, data={"lists": [alpha.recipient_list.ref], "person": "Aunt May"})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_guest_link_issue__member__without_mfa_denied(alpha):
    family = alpha.family
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "guest_link.issue", family=family, data={"lists": [alpha.recipient_list.ref], "person": "Aunt May"})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_guest_link_revoke__family_admin__without_mfa_denied(alpha):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "guest_link.revoke", guest_link=guest_link)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_guest_link_revoke__member__without_mfa_denied(alpha):
    guest_link = alpha.new_guest_link(issued_by=alpha.member_giver)
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "guest_link.revoke", guest_link=guest_link)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_list_create__family_admin__without_mfa_denied(alpha):
    family = alpha.family
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "list.create", family=family, data={"title": "Spring wishes", "recipient": alpha.member_recipient.ref})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_list_create__member__without_mfa_denied(alpha):
    family = alpha.family
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "list.create", family=family, data={"title": "Spring wishes", "recipient": alpha.member_recipient.ref})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_list_view__family_admin__without_mfa_denied(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.family_admin.without_mfa(), "list.view", list=lst)
    assert_mfa_required(resp)
    assert lst.marker not in resp.content.decode()


def test_i4_list_view__member__without_mfa_denied(alpha):
    lst = alpha.recipient_list
    resp = call(alpha.member_giver.without_mfa(), "list.view", list=lst)
    assert_mfa_required(resp)
    assert lst.marker not in resp.content.decode()


def test_i4_list_update__family_admin__without_mfa_denied(alpha):
    lst = alpha.recipient_list
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "list.update", list=lst, data={"title": "Renamed list"})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_list_update__member__without_mfa_denied(alpha):
    lst = alpha.recipient_list
    _no_mfa_actor = alpha.member_recipient.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "list.update", list=lst, data={"title": "Renamed list"})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_list_delete__family_admin__without_mfa_denied(alpha):
    lst = alpha.recipient_list
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "list.delete", list=lst)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_list_delete__member__without_mfa_denied(alpha):
    lst = alpha.recipient_list
    _no_mfa_actor = alpha.member_recipient.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "list.delete", list=lst)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_item_view__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    resp = call(alpha.family_admin.without_mfa(), "item.view", item=item)
    assert_mfa_required(resp)
    assert item.marker not in resp.content.decode()


def test_i4_item_view__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    resp = call(alpha.member_giver.without_mfa(), "item.view", item=item)
    assert_mfa_required(resp)
    assert item.marker not in resp.content.decode()


def test_i4_item_create__family_admin__without_mfa_denied(alpha):
    lst = alpha.recipient_list
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_item_create__member__without_mfa_denied(alpha):
    lst = alpha.recipient_list
    _no_mfa_actor = alpha.member_recipient.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "item.create", list=lst, data={"name": "Blue scarf", "quantity": 1})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_item_update__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "item.update", item=item, data={"name": "Green scarf"})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_item_update__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    _no_mfa_actor = alpha.member_recipient.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "item.update", item=item, data={"name": "Green scarf"})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_item_delete__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "item.delete", item=item)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_item_delete__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    _no_mfa_actor = alpha.member_recipient.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "item.delete", item=item)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_claim_view__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(alpha.family_admin.without_mfa(), "claim.view", item=item)
    assert_mfa_required(resp)
    assert claim.marker not in resp.content.decode()


def test_i4_claim_view__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.family_admin)
    resp = call(alpha.member_giver.without_mfa(), "claim.view", item=item)
    assert_mfa_required(resp)
    assert claim.marker not in resp.content.decode()


def test_i4_claim_create__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "claim.create", item=item, data={})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_claim_create__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "claim.create", item=item, data={})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_claim_release__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "claim.release", claim=claim)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_claim_release__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "claim.release", claim=claim)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_pledge_view__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(alpha.family_admin.without_mfa(), "pledge.view", item=item)
    assert_mfa_required(resp)
    assert pledge.marker not in resp.content.decode()


def test_i4_pledge_view__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    resp = call(alpha.member_giver.without_mfa(), "pledge.view", item=item)
    assert_mfa_required(resp)
    assert pledge.marker not in resp.content.decode()


def test_i4_pledge_create__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_pledge_create__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "pledge.create", item=item, data={"amount_cents": 2500})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_pledge_update__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.family_admin)
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_pledge_update__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    pledge = alpha.new_pledge(item, by=alpha.member_giver)
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "pledge.update", pledge=pledge, data={"amount_cents": 3000})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_assignment_create__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "assignment.create", item=item, data={"assignee": alpha.assignee_link.ref})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_assignment_create__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "assignment.create", item=item, data={"assignee": alpha.assignee_link.ref})
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_assignment_view__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.family_admin.without_mfa(), "assignment.view", assignment=assignment)
    assert_mfa_required(resp)
    assert assignment.marker not in resp.content.decode()


def test_i4_assignment_view__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.member_giver.without_mfa(), "assignment.view", assignment=assignment)
    assert_mfa_required(resp)
    assert assignment.marker not in resp.content.decode()


def test_i4_assignment_mark_bought__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "assignment.mark_bought", assignment=assignment)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_assignment_mark_bought__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "assignment.mark_bought", assignment=assignment)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_assignment_mark_couldnt_get__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "assignment.mark_couldnt_get", assignment=assignment)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_assignment_mark_couldnt_get__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "assignment.mark_couldnt_get", assignment=assignment)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_assignment_cancel__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    _no_mfa_actor = alpha.family_admin.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "assignment.cancel", assignment=assignment)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_assignment_cancel__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    _no_mfa_actor = alpha.member_giver.without_mfa()
    before = db_state(alpha)
    resp = call(_no_mfa_actor, "assignment.cancel", assignment=assignment)
    assert_mfa_required(resp)
    assert db_state(alpha) == before


def test_i4_assignment_share_card__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.family_admin.without_mfa(), "assignment.share_card", assignment=assignment)
    assert_mfa_required(resp)


def test_i4_assignment_share_card__member__without_mfa_denied(alpha):
    item = alpha.new_item()
    assignment = alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    resp = call(alpha.member_giver.without_mfa(), "assignment.share_card", assignment=assignment)
    assert_mfa_required(resp)


def test_i4_audit_log_view__family_admin__without_mfa_denied(alpha):
    item = alpha.new_item()
    claim = alpha.new_claim(item, by=alpha.member_giver)
    family = alpha.family
    resp = call(alpha.family_admin.without_mfa(), "audit_log.view", family=family)
    assert_mfa_required(resp)
    assert claim.marker not in resp.content.decode()


def test_i4_mfa_gate__enrollment_page_reachable_without_mfa(alpha):
    resp = alpha.member_giver.without_mfa().client.get(mfa_enroll_url())
    assert_allowed(resp)


def test_i4_mfa_gate__logout_reachable_without_mfa(alpha):
    resp = alpha.member_giver.without_mfa().client.post(logout_url())
    assert_allowed(resp, redirect=True)


def test_i4_mfa_gate__enrolled_totp_unlocks_access(alpha):
    actor = alpha.member_giver.without_mfa()
    assert_mfa_required(call(actor, "member.list", family=alpha.family))
    actor.enroll_totp()
    assert_allowed(call(actor, "member.list", family=alpha.family))


def test_i4_mfa_gate__passkey_only_account_allowed(alpha):
    actor = alpha.member_giver.passkey_only()
    assert_allowed(call(actor, "member.list", family=alpha.family))


def test_i5_rls_memberships__cross_family_rows_invisible(alpha, beta):
    table = TABLES["memberships"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    ids = rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert {str(i) for i in ids} == {str(alpha.family.ref)}


def test_i5_rls_memberships__no_context_returns_no_rows(alpha):
    table = TABLES["memberships"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table) == []


def test_i5_rls_memberships__cross_family_update_touches_no_rows(alpha, beta):
    table = TABLES["memberships"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    count = rls_update_rowcount(
        table, family=alpha, principal=alpha.family_admin, target_family=beta
    )
    assert count == 0


def test_i5_rls_memberships__force_rls_enabled():
    table = TABLES["memberships"]
    assert table_rls_flags(table) == {"relrowsecurity": True, "relforcerowsecurity": True}


def test_i5_rls_invites__cross_family_rows_invisible(alpha, beta):
    table = TABLES["invites"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    ids = rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert {str(i) for i in ids} == {str(alpha.family.ref)}


def test_i5_rls_invites__no_context_returns_no_rows(alpha):
    table = TABLES["invites"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table) == []


def test_i5_rls_invites__cross_family_update_touches_no_rows(alpha, beta):
    table = TABLES["invites"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    count = rls_update_rowcount(
        table, family=alpha, principal=alpha.family_admin, target_family=beta
    )
    assert count == 0


def test_i5_rls_invites__force_rls_enabled():
    table = TABLES["invites"]
    assert table_rls_flags(table) == {"relrowsecurity": True, "relforcerowsecurity": True}


def test_i5_rls_guest_links__cross_family_rows_invisible(alpha, beta):
    table = TABLES["guest_links"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    ids = rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert {str(i) for i in ids} == {str(alpha.family.ref)}


def test_i5_rls_guest_links__no_context_returns_no_rows(alpha):
    table = TABLES["guest_links"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table) == []


def test_i5_rls_guest_links__cross_family_update_touches_no_rows(alpha, beta):
    table = TABLES["guest_links"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    count = rls_update_rowcount(
        table, family=alpha, principal=alpha.family_admin, target_family=beta
    )
    assert count == 0


def test_i5_rls_guest_links__force_rls_enabled():
    table = TABLES["guest_links"]
    assert table_rls_flags(table) == {"relrowsecurity": True, "relforcerowsecurity": True}


def test_i5_rls_assignment_links__cross_family_rows_invisible(alpha, beta):
    table = TABLES["assignment_links"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    ids = rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert {str(i) for i in ids} == {str(alpha.family.ref)}


def test_i5_rls_assignment_links__no_context_returns_no_rows(alpha):
    table = TABLES["assignment_links"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table) == []


def test_i5_rls_assignment_links__cross_family_update_touches_no_rows(alpha, beta):
    table = TABLES["assignment_links"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    count = rls_update_rowcount(
        table, family=alpha, principal=alpha.family_admin, target_family=beta
    )
    assert count == 0


def test_i5_rls_assignment_links__force_rls_enabled():
    table = TABLES["assignment_links"]
    assert table_rls_flags(table) == {"relrowsecurity": True, "relforcerowsecurity": True}


def test_i5_rls_lists__cross_family_rows_invisible(alpha, beta):
    table = TABLES["lists"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    ids = rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert {str(i) for i in ids} == {str(alpha.family.ref)}


def test_i5_rls_lists__no_context_returns_no_rows(alpha):
    table = TABLES["lists"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table) == []


def test_i5_rls_lists__cross_family_update_touches_no_rows(alpha, beta):
    table = TABLES["lists"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    count = rls_update_rowcount(
        table, family=alpha, principal=alpha.family_admin, target_family=beta
    )
    assert count == 0


def test_i5_rls_lists__force_rls_enabled():
    table = TABLES["lists"]
    assert table_rls_flags(table) == {"relrowsecurity": True, "relforcerowsecurity": True}


def test_i5_rls_lists__instance_admin_reads_no_rows(alpha, instance_admin):
    table = TABLES["lists"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table, family=alpha, principal=instance_admin) == []


def test_i5_rls_items__cross_family_rows_invisible(alpha, beta):
    table = TABLES["items"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    ids = rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert {str(i) for i in ids} == {str(alpha.family.ref)}


def test_i5_rls_items__no_context_returns_no_rows(alpha):
    table = TABLES["items"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table) == []


def test_i5_rls_items__cross_family_update_touches_no_rows(alpha, beta):
    table = TABLES["items"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    count = rls_update_rowcount(
        table, family=alpha, principal=alpha.family_admin, target_family=beta
    )
    assert count == 0


def test_i5_rls_items__force_rls_enabled():
    table = TABLES["items"]
    assert table_rls_flags(table) == {"relrowsecurity": True, "relforcerowsecurity": True}


def test_i5_rls_items__instance_admin_reads_no_rows(alpha, instance_admin):
    table = TABLES["items"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table, family=alpha, principal=instance_admin) == []


def test_i5_rls_claims__cross_family_rows_invisible(alpha, beta):
    table = TABLES["claims"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    ids = rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert {str(i) for i in ids} == {str(alpha.family.ref)}


def test_i5_rls_claims__no_context_returns_no_rows(alpha):
    table = TABLES["claims"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table) == []


def test_i5_rls_claims__cross_family_update_touches_no_rows(alpha, beta):
    table = TABLES["claims"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    count = rls_update_rowcount(
        table, family=alpha, principal=alpha.family_admin, target_family=beta
    )
    assert count == 0


def test_i5_rls_claims__force_rls_enabled():
    table = TABLES["claims"]
    assert table_rls_flags(table) == {"relrowsecurity": True, "relforcerowsecurity": True}


def test_i5_rls_claims__instance_admin_reads_no_rows(alpha, instance_admin):
    table = TABLES["claims"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table, family=alpha, principal=instance_admin) == []


def test_i5_rls_pledges__cross_family_rows_invisible(alpha, beta):
    table = TABLES["pledges"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    ids = rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert {str(i) for i in ids} == {str(alpha.family.ref)}


def test_i5_rls_pledges__no_context_returns_no_rows(alpha):
    table = TABLES["pledges"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table) == []


def test_i5_rls_pledges__cross_family_update_touches_no_rows(alpha, beta):
    table = TABLES["pledges"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    count = rls_update_rowcount(
        table, family=alpha, principal=alpha.family_admin, target_family=beta
    )
    assert count == 0


def test_i5_rls_pledges__force_rls_enabled():
    table = TABLES["pledges"]
    assert table_rls_flags(table) == {"relrowsecurity": True, "relforcerowsecurity": True}


def test_i5_rls_pledges__instance_admin_reads_no_rows(alpha, instance_admin):
    table = TABLES["pledges"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table, family=alpha, principal=instance_admin) == []


def test_i5_rls_assignments__cross_family_rows_invisible(alpha, beta):
    table = TABLES["assignments"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    ids = rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert {str(i) for i in ids} == {str(alpha.family.ref)}


def test_i5_rls_assignments__no_context_returns_no_rows(alpha):
    table = TABLES["assignments"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table) == []


def test_i5_rls_assignments__cross_family_update_touches_no_rows(alpha, beta):
    table = TABLES["assignments"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    count = rls_update_rowcount(
        table, family=alpha, principal=alpha.family_admin, target_family=beta
    )
    assert count == 0


def test_i5_rls_assignments__force_rls_enabled():
    table = TABLES["assignments"]
    assert table_rls_flags(table) == {"relrowsecurity": True, "relforcerowsecurity": True}


def test_i5_rls_assignments__instance_admin_reads_no_rows(alpha, instance_admin):
    table = TABLES["assignments"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table, family=alpha, principal=instance_admin) == []


def test_i5_rls_audit_log__cross_family_rows_invisible(alpha, beta):
    table = TABLES["audit_log"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    ids = rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert {str(i) for i in ids} == {str(alpha.family.ref)}


def test_i5_rls_audit_log__no_context_returns_no_rows(alpha):
    table = TABLES["audit_log"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table) == []


def test_i5_rls_audit_log__cross_family_update_touches_no_rows(alpha, beta):
    table = TABLES["audit_log"]
    assert rls_family_ids(table, family=beta, principal=beta.family_admin)
    count = rls_update_rowcount(
        table, family=alpha, principal=alpha.family_admin, target_family=beta
    )
    assert count == 0


def test_i5_rls_audit_log__force_rls_enabled():
    table = TABLES["audit_log"]
    assert table_rls_flags(table) == {"relrowsecurity": True, "relforcerowsecurity": True}


def test_i5_rls_audit_log__instance_admin_reads_no_rows(alpha, instance_admin):
    table = TABLES["audit_log"]
    assert rls_family_ids(table, family=alpha, principal=alpha.family_admin)
    assert rls_family_ids(table, family=alpha, principal=instance_admin) == []


def test_i5_rls_claims__recipient_cannot_read_rows_on_own_list(alpha):
    table = TABLES["claims"]
    item = alpha.new_item()
    alpha.new_claim(item, by=alpha.member_giver)
    lst = alpha.recipient_list
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.member_giver) > 0
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.member_recipient) == 0


def test_i5_rls_claims__family_admin_recipient_cannot_read_rows_on_own_list(alpha):
    table = TABLES["claims"]
    lst = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(lst)
    alpha.new_claim(item, by=alpha.member_giver)
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.member_giver) > 0
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.family_admin) == 0


def test_i5_rls_pledges__recipient_cannot_read_rows_on_own_list(alpha):
    table = TABLES["pledges"]
    item = alpha.new_item()
    alpha.new_pledge(item, by=alpha.member_giver)
    lst = alpha.recipient_list
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.member_giver) > 0
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.member_recipient) == 0


def test_i5_rls_pledges__family_admin_recipient_cannot_read_rows_on_own_list(alpha):
    table = TABLES["pledges"]
    lst = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(lst)
    alpha.new_pledge(item, by=alpha.member_giver)
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.member_giver) > 0
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.family_admin) == 0


def test_i5_rls_assignments__recipient_cannot_read_rows_on_own_list(alpha):
    table = TABLES["assignments"]
    item = alpha.new_item()
    alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    lst = alpha.recipient_list
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.member_giver) > 0
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.member_recipient) == 0


def test_i5_rls_assignments__family_admin_recipient_cannot_read_rows_on_own_list(alpha):
    table = TABLES["assignments"]
    lst = alpha.new_list(recipient=alpha.family_admin)
    item = alpha.new_item(lst)
    alpha.new_assignment(item, assigner=alpha.member_giver, assignee=alpha.assignee_link)
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.member_giver) > 0
    assert rls_count_for_list(table, lst, family=alpha, principal=alpha.family_admin) == 0


def test_i5_rls__app_role_is_not_superuser_and_does_not_bypass_rls():
    assert app_role_flags() == {"rolsuper": False, "rolbypassrls": False}
