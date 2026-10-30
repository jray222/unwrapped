import pytest
from django.core.exceptions import ValidationError

from apps.families.models import AuditLog


@pytest.fixture
def entry(family, admin_user):
    return AuditLog.objects.create(
        family=family, actor=admin_user, action=AuditLog.Action.CLAIM, target_type="item", target_id=1
    )


def test_audit_log_can_be_appended(entry):
    assert AuditLog.objects.count() == 1


def test_audit_log_row_cannot_be_updated(entry):
    entry.action = AuditLog.Action.RELEASE
    with pytest.raises(TypeError):
        entry.save()


def test_audit_log_row_cannot_be_deleted(entry):
    with pytest.raises(TypeError):
        entry.delete()


def test_audit_log_queryset_cannot_update_or_delete(entry):
    with pytest.raises(TypeError):
        AuditLog.objects.update(action="login")
    with pytest.raises(TypeError):
        AuditLog.objects.all().delete()
    assert AuditLog.objects.get().action == AuditLog.Action.CLAIM


def test_audit_log_metadata_rejects_tokens(family):
    for metadata in ({"token": "x"}, {"link": {"raw_Token": "x"}}, {"items": [{"token_hash": "x"}]}):
        with pytest.raises(ValidationError):
            AuditLog.objects.create(family=family, action=AuditLog.Action.LINK_ISSUE, metadata=metadata)


def test_audit_log_covers_required_actions():
    assert {c.value for c in AuditLog.Action} == {
        "claim", "release", "assign", "invite", "link_issue", "link_revoke", "role_change", "login",
    }
