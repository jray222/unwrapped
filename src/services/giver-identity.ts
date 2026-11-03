import type { AuthContext } from '../types.js';
import { extractFirstName } from '../security/surprise.js';

export interface GiverIdentity {
  userId: string | null;
  guestLinkId: string | null;
  firstName: string;
}

/** Resolve who is acting (claimer/pledger) from the auth context. */
export function resolveGiverIdentity(auth: AuthContext | undefined): GiverIdentity {
  let userId: string | null = null;
  let guestLinkId: string | null = null;
  let firstName = 'Someone';

  if (auth?.kind === 'user' && auth.user) {
    userId = auth.user.id;
    firstName = extractFirstName(auth.user.first_name);
  } else if (auth?.kind === 'guest' && auth.guestLink) {
    guestLinkId = auth.guestLink.id;
    firstName = extractFirstName(auth.guestLink.guest_first_name);
  }

  return { userId, guestLinkId, firstName };
}

/** True if the caller is a family admin, the owning user, or the owning guest link of the claim. */
export function canManageClaim(
  auth: AuthContext | undefined,
  familyId: string,
  claim: { claimer_user_id: string | null; claimer_guest_link_id: string | null }
): boolean {
  const isFamilyAdmin = auth?.memberships?.some(
    (m) => m.family_id === familyId && m.role === 'family_admin'
  );
  const isOwnerUser =
    auth?.kind === 'user' && auth.user && claim.claimer_user_id === auth.user.id;
  const isOwnerGuest =
    auth?.kind === 'guest' &&
    auth.guestLink &&
    claim.claimer_guest_link_id === auth.guestLink.id;
  return Boolean(isFamilyAdmin || isOwnerUser || isOwnerGuest);
}
