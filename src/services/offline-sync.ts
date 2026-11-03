import type { AuthContext } from '../types.js';
import { HttpError } from '../errors.js';
import { claimItem, updateClaimBought, findFamilyIdForClaim } from './claims.js';
import { updateAssignmentStatus, findFamilyIdForAssignment } from './assignments.js';

export interface OfflineSyncResult {
  type: string;
  success: boolean;
  error?: string;
}

const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const NOT_FOUND = 'Not found';

/**
 * Same family-access rules as the online `requireFamilyAccess(..., allowGuest = true)` middleware,
 * applied to the family an offline action targets. Cross-tenant attempts get a generic "Not found"
 * so they are indistinguishable from missing records.
 */
function assertFamilyAccess(auth: AuthContext, familyId: unknown): asserts familyId is string {
  if (typeof familyId !== 'string' || !UUID_RE.test(familyId)) {
    throw new HttpError(404, NOT_FOUND);
  }

  switch (auth.kind) {
    case 'guest':
      if (auth.guestLink?.family_id === familyId) return;
      break;
    case 'assignment':
      if (auth.assignmentLink?.family_id === familyId) return;
      break;
    case 'user':
      if (
        auth.user?.mfa_enrolled &&
        auth.memberships?.some((m) => m.family_id === familyId)
      ) {
        return;
      }
      break;
    // instance_admin must never touch family content
  }
  throw new HttpError(404, NOT_FOUND);
}

/** Resolve the target family: prefer the one named on the action, else look it up by record id. */
async function resolveFamilyId(
  action: any,
  recordId: unknown,
  lookup: (id: string) => Promise<string | undefined>
): Promise<unknown> {
  if (action.familyId) return action.familyId;
  if (typeof recordId !== 'string' || !UUID_RE.test(recordId)) return undefined;
  return lookup(recordId);
}

async function markBought(auth: AuthContext, action: any): Promise<void> {
  if (action.claimId) {
    const familyId = await resolveFamilyId(action, action.claimId, findFamilyIdForClaim);
    assertFamilyAccess(auth, familyId);
    const claim = await updateClaimBought(auth, familyId, action.claimId, true);
    if (!claim) throw new HttpError(404, NOT_FOUND);
  } else if (action.assignmentId) {
    const familyId = await resolveFamilyId(action, action.assignmentId, findFamilyIdForAssignment);
    assertFamilyAccess(auth, familyId);
    const assignment = await updateAssignmentStatus(
      auth,
      familyId,
      action.assignmentId,
      'bought',
      undefined
    );
    if (!assignment) throw new HttpError(404, NOT_FOUND);
  } else {
    throw new Error('MARK_BOUGHT requires claimId or assignmentId');
  }
}

async function claimItemOffline(auth: AuthContext, action: any): Promise<void> {
  const { itemId, familyId } = action;
  if (!itemId || !familyId) {
    throw new Error('CLAIM_ITEM requires itemId and familyId');
  }
  assertFamilyAccess(auth, familyId);
  const claim = await claimItem(auth, familyId, itemId, {
    quantity: action.quantity,
    bought: action.bought,
  });
  if (!claim) throw new HttpError(404, NOT_FOUND);
}

async function updateAssignmentOffline(auth: AuthContext, action: any): Promise<void> {
  const { assignmentId, status } = action;
  if (!assignmentId || !status) {
    throw new Error('UPDATE_ASSIGNMENT requires assignmentId and status');
  }
  if (!['assigned', 'bought', 'couldnt_get_it'].includes(status)) {
    throw new Error(`Invalid assignment status: ${status}`);
  }

  const familyId = await resolveFamilyId(action, assignmentId, findFamilyIdForAssignment);
  assertFamilyAccess(auth, familyId);
  const assignment = await updateAssignmentStatus(
    auth,
    familyId,
    assignmentId,
    status,
    action.reassignToFirstName
  );
  if (!assignment) throw new HttpError(404, NOT_FOUND);
}

/** Replay queued offline actions; per-action failures are reported, never thrown. */
export async function processOfflineActions(auth: AuthContext, actions: any[]) {
  const results: OfflineSyncResult[] = [];
  let syncedCount = 0;

  for (const action of actions) {
    try {
      if (!action || typeof action !== 'object') {
        results.push({ type: 'UNKNOWN', success: false, error: 'Invalid action payload' });
        continue;
      }

      if (action.type === 'MARK_BOUGHT') {
        await markBought(auth, action);
      } else if (action.type === 'CLAIM_ITEM') {
        await claimItemOffline(auth, action);
      } else if (action.type === 'UPDATE_ASSIGNMENT') {
        await updateAssignmentOffline(auth, action);
      } else {
        results.push({
          type: action.type || 'UNKNOWN',
          success: false,
          error: 'Unknown action type',
        });
        continue;
      }

      syncedCount++;
      results.push({ type: action.type, success: true });
    } catch (err: any) {
      results.push({
        type: action?.type || 'UNKNOWN',
        success: false,
        error: err.message || 'Action failed',
      });
    }
  }

  return { syncedCount, results };
}
