"""INTERNAL: delete the accounts of an organization that is being deleted from the CRM.

Called only by the Organization Service (shared key INTERNAL_API_KEY, like the other internal routes), after it has locked the organization and had every business
service delete its data. Only users whose organization_id IS this organization are deleted: Super Admins have no organization and can never match. Idempotent.
Their sessions end with them: a token is only ever valid while its user exists.
"""
import uuid
from typing import Dict

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.models import User


def purge_organization_users(db: Session, organization_id: uuid.UUID) -> Dict[str, int]:
    count = db.execute(delete(User).where(User.organization_id == organization_id)).rowcount
    db.commit()
    return {"users": count} if count else {}
