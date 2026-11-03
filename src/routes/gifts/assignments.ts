import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../types.js';
import { requireFamilyAccess, requireCsrf } from '../../security/middleware.js';
import { extractFirstName } from '../../security/surprise.js';
import {
  createAssignments,
  findFamilyIdForAssignment,
  updateAssignmentStatus,
  listAssignmentsForAssigner,
  listAssignmentReminders,
  getAssignmentViewData,
} from '../../services/assignments.js';
import { handleRouteError } from './http.js';

const router = Router();

/**
 * POST /families/:familyId/assignments
 * Assign one or more items to a giver (e.g. Grandma/Grandpa) and immediately create linked claims.
 */
router.post(
  '/families/:familyId/assignments',
  requireFamilyAccess(['family_admin', 'member']),
  requireCsrf,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId } = req.params;
      const itemIds = req.body?.itemIds ?? req.body?.item_ids;
      const assigneeFirstName = req.body?.assigneeFirstName ?? req.body?.assignee_first_name;
      const assignmentLinkId = req.body?.assignmentLinkId ?? req.body?.assignment_link_id;

      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        res.status(400).json({ error: 'itemIds array is required' });
        return;
      }

      if (!assigneeFirstName || typeof assigneeFirstName !== 'string' || !assigneeFirstName.trim()) {
        res.status(400).json({ error: 'assigneeFirstName is required' });
        return;
      }

      const cleanAssigneeName = extractFirstName(assigneeFirstName.trim());
      const currentUser = req.auth!.user!;

      const assignments = await createAssignments(
        currentUser,
        familyId,
        itemIds,
        cleanAssigneeName,
        assignmentLinkId
      );

      res.status(201).json({ assignments });
    } catch (err) {
      handleRouteError(err, res, next);
    }
  }
);

/**
 * PATCH /families/:familyId/assignments/:assignmentId
 * Update assignment status (e.g. bought or couldn't get it / reassign).
 */
const updateAssignmentHandler = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    let { familyId, assignmentId } = req.params;
    if (!familyId && assignmentId) {
      familyId = (await findFamilyIdForAssignment(assignmentId)) ?? familyId;
    }

    if (!familyId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const status = req.body?.status;
    const reassignToFirstName = req.body?.reassignToFirstName ?? req.body?.reassign_to_first_name;

    if (!status || !['assigned', 'bought', 'couldnt_get_it'].includes(status)) {
      res.status(400).json({ error: 'Valid status is required' });
      return;
    }

    const assignment = await updateAssignmentStatus(
      req.auth,
      familyId,
      assignmentId,
      status,
      reassignToFirstName
    );

    if (!assignment) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.status(200).json({ assignment });
  } catch (err) {
    handleRouteError(err, res, next);
  }
};

router.patch('/families/:familyId/assignments/:assignmentId', requireCsrf, updateAssignmentHandler);
router.put('/families/:familyId/assignments/:assignmentId', requireCsrf, updateAssignmentHandler);
router.put(
  '/families/:familyId/assignments/:assignmentId/status',
  requireCsrf,
  updateAssignmentHandler
);
router.put('/assignments/:assignmentId/status', requireCsrf, updateAssignmentHandler);

/**
 * GET /families/:familyId/assignments
 * Lists assignments created by the current user in this family.
 */
router.get(
  '/families/:familyId/assignments',
  requireFamilyAccess(['family_admin', 'member']),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId } = req.params;
      const currentUser = req.auth!.user!;
      const assignments = await listAssignmentsForAssigner(familyId, currentUser.id);
      res.json({ assignments });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /families/:familyId/assignments/reminders
 * Upcoming assignment reminders for events within reminderDaysBeforeEvent.
 */
router.get(
  '/families/:familyId/assignments/reminders',
  requireFamilyAccess(['family_admin', 'member']),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { familyId } = req.params;
      const currentUser = req.auth!.user!;
      const reminders = await listAssignmentReminders(familyId, currentUser.id);
      res.json({ reminders });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /assignment/view
 * Dedicated view for an assignment recipient using their assignment link.
 */
router.get(
  '/assignment/view',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.auth || req.auth.kind !== 'assignment' || !req.auth.assignmentLink) {
        res.status(401).json({ error: 'Assignment session required' });
        return;
      }

      const {
        id: assignmentLinkId,
        family_id: familyId,
        assignee_first_name: assigneeFirstName,
      } = req.auth.assignmentLink;

      const data = await getAssignmentViewData(familyId, assignmentLinkId, assigneeFirstName);
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
