import { Router } from 'express';
import QRCode from 'qrcode';
import { authRateLimiter } from '../../security/middleware.js';
import {
  createTotpSetup,
  storeTotpSecret,
  enableTotp,
  verifyTotpLogin,
  redeemRecoveryCode,
} from '../../services/mfa.js';
import type { AuthenticatedRequest } from '../../types.js';

const router = Router();

/**
 * POST /api/auth/mfa/totp/setup
 * Generates TOTP secret, URI, and QR code Data URL.
 */
router.post('/mfa/totp/setup', async (req: AuthenticatedRequest, res, next) => {
  try {
    const user = req.auth!.user!;
    const { secret, otpauthUri } = await createTotpSetup(user);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri);

    await storeTotpSecret(user.id, secret);

    res.json({
      secret,
      otpauthUri,
      qrCodeDataUrl,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/mfa/totp/enable
 * Verifies the first TOTP code, enables TOTP, verifies the session, and generates 8 recovery codes.
 */
router.post('/mfa/totp/enable', authRateLimiter, async (req: AuthenticatedRequest, res, next) => {
  try {
    const rawCode = req.body?.code ?? req.body?.token;
    const code = rawCode !== undefined && rawCode !== null ? String(rawCode).trim() : '';
    const user = req.auth!.user!;
    const sessionId = req.auth!.sessionId;

    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: 'Verification code is required' });
      return;
    }

    const recoveryCodes = await enableTotp(user.id, sessionId, code);

    if (!recoveryCodes) {
      res.status(400).json({ error: 'Invalid verification code' });
      return;
    }

    res.json({
      enabled: true,
      recoveryCodes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/mfa/totp/verify
 * Verifies TOTP code on subsequent logins.
 */
router.post('/mfa/totp/verify', authRateLimiter, async (req: AuthenticatedRequest, res, next) => {
  try {
    const rawCode = req.body?.code ?? req.body?.token;
    const code = rawCode !== undefined && rawCode !== null ? String(rawCode).trim() : '';
    const user = req.auth!.user!;
    const sessionId = req.auth!.sessionId;

    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: 'Verification code is required' });
      return;
    }

    const verified = await verifyTotpLogin(user, sessionId, code);

    if (!verified) {
      res.status(400).json({ error: 'Invalid verification code' });
      return;
    }

    res.json({ verified: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/mfa/recovery/verify
 * Redeems a single-use 2FA recovery code.
 */
router.post(
  ['/mfa/recovery/verify', '/mfa/recovery'],
  authRateLimiter,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const rawRecovery = req.body?.recoveryCode ?? req.body?.recovery_code ?? req.body?.code;
      const recoveryCode =
        rawRecovery !== undefined && rawRecovery !== null ? String(rawRecovery).trim() : '';
      const user = req.auth!.user!;
      const sessionId = req.auth!.sessionId;

      if (!recoveryCode || typeof recoveryCode !== 'string') {
        res.status(400).json({ error: 'Recovery code is required' });
        return;
      }

      const verified = await redeemRecoveryCode(user.id, sessionId, recoveryCode);

      if (!verified) {
        res.status(400).json({ error: 'Invalid or already used recovery code' });
        return;
      }

      res.json({ verified: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
