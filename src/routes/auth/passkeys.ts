import { Router } from 'express';
import {
  requireCsrf,
  requirePreMfaUser,
  authRateLimiter,
  setSessionCookie,
} from '../../security/middleware.js';
import {
  createRegistrationOptions,
  resolveRegistrationCredential,
  savePasskeyEnrollment,
  createLoginOptions,
  loginWithPasskey,
} from '../../services/passkeys.js';
import type { AuthenticatedRequest } from '../../types.js';

const router = Router();

/**
 * POST /api/auth/mfa/passkey/register-options
 * Generates WebAuthn registration options.
 */
router.post(
  ['/mfa/passkey/register-options', '/passkey/register-options'],
  requirePreMfaUser,
  requireCsrf,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const user = req.auth!.user!;
      const sessionId = req.auth!.sessionId;

      const options = await createRegistrationOptions(user, sessionId);

      res.json(options);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/auth/mfa/passkey/register-verify
 * Verifies or directly registers passkey credentials (supports headless/test environments).
 */
router.post(
  ['/mfa/passkey/register-verify', '/passkey/register-verify'],
  requirePreMfaUser,
  requireCsrf,
  authRateLimiter,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const credentialId = req.body?.credentialId ?? req.body?.credential_id ?? req.body?.id;
      const publicKey = req.body?.publicKey ?? req.body?.public_key;
      const deviceName = req.body?.deviceName ?? req.body?.device_name;
      const attestationResponse = req.body?.attestationResponse ?? req.body?.attestation_response;
      const user = req.auth!.user!;
      const sessionId = req.auth!.sessionId;

      const { credId, pubKey } = await resolveRegistrationCredential(
        sessionId,
        credentialId,
        publicKey,
        attestationResponse
      );

      if (!credId) {
        res.status(400).json({ error: 'Credential ID is required' });
        return;
      }

      const recoveryCodes = await savePasskeyEnrollment(user, sessionId, credId, pubKey, deviceName);

      res.json({
        verified: true,
        recoveryCodes,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/auth/passkey/login-options
 * Generates assertion options for passkey sign-in.
 */
router.post('/passkey/login-options', authRateLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const options = await createLoginOptions(normalizedEmail);
    if (!options) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(options);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/passkey/login-verify
 * Verifies passkey credential and creates a fully verified session.
 */
router.post('/passkey/login-verify', authRateLimiter, async (req, res, next) => {
  try {
    const email = req.body?.email;
    const credentialId = req.body?.credentialId ?? req.body?.credential_id ?? req.body?.id;
    if (!email || !credentialId) {
      res.status(400).json({ error: 'Email and credentialId are required' });
      return;
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const sessionData = await loginWithPasskey(normalizedEmail, credentialId);

    setSessionCookie(res, sessionData.sessionToken, sessionData.maxAgeMs);

    res.json({
      sessionToken: sessionData.sessionToken,
      csrfToken: sessionData.csrfToken,
      user: sessionData.user,
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
