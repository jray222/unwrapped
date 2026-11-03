import { HttpError } from '../errors.js';
import type { AuthenticatedRequest } from '../types.js';

/** True when the authenticated user is a family_admin of the given family. */
export function isFamilyAdminOf(req: AuthenticatedRequest, familyId: string): boolean {
  return Boolean(
    req.auth?.memberships?.some((m) => m.family_id === familyId && m.role === 'family_admin')
  );
}

/**
 * Only the list owner, the list recipient, or a family_admin may manage a list.
 * Throws a 403 HttpError otherwise.
 */
export function assertCanManageList(
  list: { owner_user_id: string; recipient_user_id: string | null },
  currentUserId: string,
  isFamilyAdmin: boolean,
  message: string
): void {
  if (
    list.owner_user_id !== currentUserId &&
    list.recipient_user_id !== currentUserId &&
    !isFamilyAdmin
  ) {
    throw new HttpError(403, message);
  }
}
