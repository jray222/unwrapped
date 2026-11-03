import { Router } from 'express';
import { authRateLimiter, setSessionCookie } from '../../security/middleware.js';
import { getInvitePreview, registerFromInvite } from '../../services/invite-signup.js';

const router = Router();

/**
 * GET /api/auth/invite-info/:token
 * Returns public invite preview info (email, role, familyName).
 */
router.get('/invite-info/:token', async (req, res, next) => {
  try {
    const rawToken = req.params.token;
    if (!rawToken) {
      res.status(404).json({ error: 'Invite not found or expired' });
      return;
    }

    const invite = await getInvitePreview(rawToken);

    if (!invite) {
      res.status(404).json({ error: 'Invite not found or expired' });
      return;
    }

    res.json({
      email: invite.email,
      role: invite.role,
      familyName: invite.family_name,
      isAssistedEnrollment: invite.is_assisted_enrollment,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/register-from-invite
 * Accepts inviteToken, firstName, lastName, password.
 * Creates local account and family membership, issuing a pre-MFA session.
 */
router.post(['/register-from-invite', '/accept-invite'], authRateLimiter, async (req, res, next) => {
  try {
    const inviteToken = req.body?.inviteToken ?? req.body?.invite_token;
    const firstName = req.body?.firstName ?? req.body?.first_name;
    const lastName = req.body?.lastName ?? req.body?.last_name;
    const password = req.body?.password;
    if (!inviteToken || !firstName || !password) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const result = await registerFromInvite({ inviteToken, firstName, lastName, password });

    setSessionCookie(res, result.sessionToken, result.maxAgeMs);
    res.clearCookie('unwrapped_pending_invite', { path: '/' });

    res.status(201).json({
      user: result.user,
      sessionToken: result.sessionToken,
      csrfToken: result.csrfToken,
      mfaEnrollmentRequired: true,
    });
  } catch (err: any) {
    if (err?.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

export default router;
