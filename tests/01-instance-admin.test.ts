import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { withInstanceAdminContext } from '../src/db/index.js';
import { SESSION_COOKIE_NAME } from '../src/security/middleware.js';
import { resetRateLimiters } from '../src/security/middleware.js';
import { extractCookie } from './helpers/fixtures.js';

describe('Unwrapped v2 — Section 1: Instance Admin & Content Blindness', () => {
  const app = createApp();

  let instanceAdminCookie = '';
  let instanceAdminCsrf = '';
  let familyAlphaId = '';
  let alphaInviteToken = '';
  let familyBetaId = '';
  let betaInviteToken = '';

  beforeAll(async () => {
    await initDb();
    resetRateLimiters();
  });

  beforeEach(() => {
    resetRateLimiters();
  });

  // =========================================================================
  // SECTION 1: Instance Admin & Content Blindness
  // =========================================================================
  describe('1. Instance Admin & Content Blindness (App + PostgreSQL Role Enforcement)', () => {
    it('rejects instance admin login with invalid token', async () => {
      const res = await request(app)
        .post('/api/instance-admin/login')
        .send({ token: 'wrong-token' });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid instance admin token/i);
    });

    it('logs in successfully with config.bootstrapInstanceAdminToken', async () => {
      const res = await request(app)
        .post('/api/instance-admin/login')
        .send({ token: config.bootstrapInstanceAdminToken });

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('instance_admin');
      expect(res.body.sessionToken).toBeDefined();
      expect(res.body.csrfToken).toBeDefined();

      instanceAdminCookie = extractCookie(res);
      instanceAdminCsrf = res.body.csrfToken;
      expect(instanceAdminCookie).toContain(SESSION_COOKIE_NAME);
    });

    it('creates Family Alpha and returns single-use bootstrap family_admin invite token', async () => {
      const res = await request(app)
        .post('/api/instance-admin/families')
        .set('Cookie', instanceAdminCookie)
        .set('x-csrf-token', instanceAdminCsrf)
        .send({
          name: 'Family Alpha',
          slug: 'family-alpha',
          adminEmail: 'alice@example.com',
        });

      expect(res.status).toBe(201);
      expect(res.body.family).toBeDefined();
      expect(res.body.family.name).toBe('Family Alpha');
      expect(res.body.family.slug).toBe('family-alpha');
      expect(res.body.bootstrapInviteToken).toBeDefined();

      familyAlphaId = res.body.family.id;
      alphaInviteToken = res.body.bootstrapInviteToken;
    });

    it('creates Family Beta and returns single-use bootstrap family_admin invite token', async () => {
      const res = await request(app)
        .post('/api/instance-admin/families')
        .set('Cookie', instanceAdminCookie)
        .set('x-csrf-token', instanceAdminCsrf)
        .send({
          name: 'Family Beta',
          slug: 'family-beta',
          adminEmail: 'beta-admin@example.com',
        });

      expect(res.status).toBe(201);
      expect(res.body.family).toBeDefined();
      expect(res.body.family.name).toBe('Family Beta');
      expect(res.body.bootstrapInviteToken).toBeDefined();

      familyBetaId = res.body.family.id;
      betaInviteToken = res.body.bootstrapInviteToken;
    });

    it('lists all created families', async () => {
      const res = await request(app)
        .get('/api/instance-admin/families')
        .set('Cookie', instanceAdminCookie);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.families)).toBe(true);
      const names = res.body.families.map((f: any) => f.name);
      expect(names).toContain('Family Alpha');
      expect(names).toContain('Family Beta');
    });

    it('blocks Instance Admin from reading family content at HTTP route layer (403)', async () => {
      const res = await request(app)
        .get(`/api/families/${familyAlphaId}/lists`)
        .set('Cookie', instanceAdminCookie);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/instance admin cannot access family content/i);
    });

    it('strictly enforces content blindness at the PostgreSQL role level (withInstanceAdminContext)', async () => {
      // Direct query execution with app_instance_admin role MUST throw PostgreSQL permission error
      await expect(
        withInstanceAdminContext(async (client) => {
          return client.query('SELECT * FROM lists');
        })
      ).rejects.toThrow(/permission denied for table lists/i);

      await expect(
        withInstanceAdminContext(async (client) => {
          return client.query('SELECT * FROM items');
        })
      ).rejects.toThrow(/permission denied for table items/i);

      // Verify server attempt-read-content endpoint also reports denial
      const res = await request(app)
        .get('/api/instance-admin/attempt-read-content')
        .set('Cookie', instanceAdminCookie);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/access denied by database policy/i);
    });
  });

});
