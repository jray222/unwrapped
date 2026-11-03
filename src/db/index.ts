import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

let pgliteInstance: PGlite | null = null;
let pgPool: pg.Pool | null = null;
let initialized = false;
let txMutex: Promise<void> = Promise.resolve();

function createPGliteClient(db: PGlite): DbClient {
  return {
    async query<T = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
      const res = await db.query<T>(sql, params);
      return {
        rows: res.rows,
        rowCount: res.affectedRows ?? res.rows.length,
      };
    },
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
  };
}

function createPgPoolClient(client: pg.PoolClient): DbClient {
  return {
    async query<T = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
      const res = await client.query(sql, params);
      return {
        rows: res.rows as T[],
        rowCount: res.rowCount ?? res.rows.length,
      };
    },
    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },
  };
}

export async function initDb(): Promise<void> {
  if (initialized) return;

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  if (config.databaseUrl.startsWith('pglite://')) {
    const target = config.databaseUrl.replace('pglite://', '');
    pgliteInstance = target === 'memory' || !target ? new PGlite() : new PGlite(target);
    await pgliteInstance.waitReady;
    await pgliteInstance.exec(schemaSql);
  } else {
    pgPool = new pg.Pool({ connectionString: config.databaseUrl });
    const client = await pgPool.connect();
    try {
      await client.query(schemaSql);
    } finally {
      client.release();
    }
  }

  initialized = true;
}

export async function resetDb(): Promise<void> {
  if (pgliteInstance) {
    await pgliteInstance.close();
    pgliteInstance = null;
  }
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  initialized = false;
  await initDb();
}

async function runSerialized<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  await initDb();
  if (pgPool) {
    const poolClient = await pgPool.connect();
    try {
      return await fn(createPgPoolClient(poolClient));
    } finally {
      poolClient.release();
    }
  }
  // PGlite uses a single connection in-process, so serialize transactions cleanly
  const prev = txMutex;
  let release!: () => void;
  txMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn(createPGliteClient(pgliteInstance!));
  } finally {
    release();
  }
}

/**
 * Executes a callback inside a transaction scoped to a single family using
 * PostgreSQL Row-Level Security (`SET LOCAL ROLE app_tenant` + `app.current_family_id`).
 * Even if application SQL omits a `WHERE family_id = ...` filter, PostgreSQL RLS
 * blocks reading or writing rows belonging to any other family.
 */
export async function withFamilyContext<T>(
  familyId: string,
  fn: (client: DbClient) => Promise<T>
): Promise<T> {
  if (!familyId || !/^[0-9a-fA-F-]{36}$/.test(familyId)) {
    throw new Error('Invalid familyId for tenant context');
  }
  return runSerialized(async (client) => {
    await client.exec('BEGIN');
    try {
      await client.query(`SELECT set_config('app.current_family_id', $1, true)`, [familyId]);
      await client.exec('SET LOCAL ROLE app_tenant');
      const result = await fn(client);
      await client.exec('COMMIT');
      return result;
    } catch (err) {
      await client.exec('ROLLBACK');
      throw err;
    }
  });
}

/**
 * Executes a callback inside a transaction using the `app_instance_admin` PostgreSQL role.
 * This database role has NO SELECT privilege on lists, items, claims, pledges, assignments,
 * guest_links, assignment_links, notifications, images, or audit_logs.
 */
export async function withInstanceAdminContext<T>(
  fn: (client: DbClient) => Promise<T>
): Promise<T> {
  return runSerialized(async (client) => {
    await client.exec('BEGIN');
    try {
      await client.query(`SELECT set_config('app.current_family_id', '', true)`);
      await client.exec('SET LOCAL ROLE app_instance_admin');
      const result = await fn(client);
      await client.exec('COMMIT');
      return result;
    } catch (err) {
      await client.exec('ROLLBACK');
      throw err;
    }
  });
}

/**
 * Executes a system-level query ( strictly for authentication/session lookup,
 * token hash resolution before family_id is known, and cross-family membership listing ).
 */
export async function withSystemContext<T>(
  fn: (client: DbClient) => Promise<T>
): Promise<T> {
  return runSerialized(async (client) => {
    await client.exec('BEGIN');
    try {
      await client.exec('RESET ROLE');
      const result = await fn(client);
      await client.exec('COMMIT');
      return result;
    } catch (err) {
      await client.exec('ROLLBACK');
      throw err;
    }
  });
}

export async function recordAuditLog(
  client: DbClient,
  params: {
    familyId: string;
    actorUserId?: string | null;
    actorLabel: string;
    action: string;
    targetRecipientUserId?: string | null;
    isSurpriseSensitive?: boolean;
    metadata?: Record<string, any>;
  }
): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  await client.query(
    `INSERT INTO audit_logs (
      id, family_id, actor_user_id, actor_label, action,
      target_recipient_user_id, is_surprise_sensitive, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      randomUUID(),
      params.familyId,
      params.actorUserId ?? null,
      params.actorLabel,
      params.action,
      params.targetRecipientUserId ?? null,
      Boolean(params.isSurpriseSensitive),
      JSON.stringify(params.metadata ?? {}),
    ]
  );
}
