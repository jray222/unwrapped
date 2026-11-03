import { Router } from 'express';
import { authRateLimiter, setSessionCookie } from '../../security/middleware.js';
import { redeemAssistedEnrollment } from '../../services/assisted-enrollment.js';

const router = Router();

/**
 * POST /api/auth/assisted-enroll
 * Admin-assisted enrollment & recovery token redemption.
 * Enrolls a passkey, marks invite used, creates verified session, returns recovery codes.
 */
router.post('/assisted-enroll', authRateLimiter, async (req, res, next) => {
  try {
    const token = req.body?.token;
    const firstName = req.body?.firstName ?? req.body?.first_name;
    const deviceName = req.body?.deviceName ?? req.body?.device_name;
    const credentialId = req.body?.credentialId ?? req.body?.credential_id ?? req.body?.id;
    const publicKey = req.body?.publicKey ?? req.body?.public_key;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const result = await redeemAssistedEnrollment({
      token,
      firstName,
      deviceName,
      credentialId,
      publicKey,
    });

    setSessionCookie(res, result.sessionToken, result.maxAgeMs);
    res.clearCookie('unwrapped_pending_assisted', { path: '/' });

    res.json({
      sessionToken: result.sessionToken,
      csrfToken: result.csrfToken,
      user: result.user,
      recoveryCodes: result.recoveryCodes,
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
