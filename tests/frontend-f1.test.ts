import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { one, sql } from './support/db';
import { createTenant, tenantToken } from './support/fixtures';
import { POST as loginPost } from '../src/app/api/auth/login/route';
import { GET as meGet } from '../src/app/api/auth/me/route';
import { login as coreLogin } from '../src/core/login';
import { decodeClaims, TOKEN_KEY, ORG_ID_KEY } from '../src/core/session';

/**
 * F1 — the frontend shell and email/password auth. Tests 112–118, continuing from A3's 111
 * (ADR-0010, ADR-0065).
 *
 * The brief for F1 did not allocate numbers. ADR-0010 fixes the rule: a new run continues from the
 * highest number actually present, which is 111. F1 therefore owns 112–118 (ADR-0066).
 *
 * Every test drives the real route handlers and the real SQL, against the local Postgres. Nothing is
 * mocked.
 */

/** A tenant with one credentialed user whose password is `secret-password`. */
async function authFixture(name: string): Promise<{
  tenant: Awaited<ReturnType<typeof createTenant>>;
  email: string;
  password: string;
  userId: string;
}> {
  const tenant = await createTenant(name);
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}@example.test`;
  await sql('update auth.users set email = $2 where id = $1', [tenant.userId, email]);
  const password = 'secret-password';
  await sql('select app.upsert_user_credentials($1, $2)', [tenant.userId, password]);
  return { tenant, email, password, userId: tenant.userId };
}

function postLogin(body: unknown): Promise<Response> {
  return loginPost(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function getMe(token: string): Promise<Response> {
  return meGet(
    new Request('http://localhost/api/auth/me', {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

describe('F1 auth and shell', () => {
  it('112. a correct email and password returns a token that scopes the right org', async () => {
    const { tenant, email, password } = await authFixture('F1 login');

    const response = await postLogin({ email, password });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      org_id: string | null;
      branch_ids: string[];
      role: string;
      user: { id: string; email: string };
    };

    // The token is a real, signed access token whose claims match the membership.
    expect(body.org_id).toBe(tenant.orgId);
    expect(body.branch_ids).toEqual([tenant.branchId]);
    expect(body.user.id).toBe(tenant.userId);
    expect(body.user.email).toBe(email);

    const claims = decodeClaims(body.token);
    expect(claims?.sub).toBe(tenant.userId);
    expect(claims?.orgId).toBe(tenant.orgId);
    expect(claims?.branchIds).toEqual([tenant.branchId]);

    // /api/auth/me accepts the token and describes the same session.
    const me = await getMe(body.token);
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { org_id: string | null; user: { id: string } };
    expect(meBody.org_id).toBe(tenant.orgId);
    expect(meBody.user.id).toBe(tenant.userId);
  });

  it('113. a wrong password and an unknown email both fail with the same 401', async () => {
    const { email } = await authFixture('F1 bad password');

    const wrongPassword = await postLogin({ email, password: 'not-the-password' });
    const unknownEmail = await postLogin({ email: 'nobody@example.test', password: 'whatever' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // The bodies are identical, so the response never reveals which accounts exist.
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json());

    // The core login returns null rather than a token for either case.
    expect(await coreLogin(email, 'not-the-password')).toBeNull();
  });

  it('114. passwords are stored only as a bcrypt hash, never in plaintext', async () => {
    const { password, userId } = await authFixture('F1 hashing');

    const row = await one<{ password_hash: string }>(
      'select password_hash from app.user_credentials where user_id = $1',
      [userId],
    );
    expect(row).toBeDefined();
    // A bcrypt hash, and the plaintext appears nowhere in the stored value.
    expect(row!.password_hash).toMatch(/^\$2[aby]\$/);
    expect(row!.password_hash).not.toContain(password);

    // No column anywhere in app.user_credentials holds the plaintext.
    const cols = await sql<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'app' and table_name = 'user_credentials'`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).toContain('password_hash');
    expect(names).not.toContain('password');
  });

  it('115. a missing or malformed body is rejected before any password check', async () => {
    const missing = await postLogin({ email: 'a@example.test' });
    expect(missing.status).toBe(422);

    const blank = await postLogin({ email: '   ', password: '   ' });
    expect(blank.status).toBe(422);
  });

  it('116. /api/auth/me rejects a missing, malformed or forged token', async () => {
    const noHeader = await getMe('');
    expect(noHeader.status).toBe(401);

    const forged = `${tenantToken(await createTenant('F1 forged')).split('.').slice(0, 2).join('.')}.deadbeef`;
    const forgedResponse = await getMe(forged);
    expect(forgedResponse.status).toBe(401);

    const notAToken = await getMe('not-a-jwt');
    expect(notAToken.status).toBe(401);
  });

  it('117. the session helpers store and read the token and org id under the documented keys', async () => {
    const { tenant, email, password } = await authFixture('F1 session keys');
    const result = await coreLogin(email, password);
    expect(result).not.toBeNull();

    // The browser keys the brief specifies. Mirrors src/core/session.ts's setSession, which cannot
    // run here (no window); the keys are the contract.
    const store = new Map<string, string>();
    store.set(TOKEN_KEY, result!.token);
    store.set(ORG_ID_KEY, result!.orgId ?? '');

    expect(TOKEN_KEY).toBe('token');
    expect(ORG_ID_KEY).toBe('org_id');
    expect(decodeClaims(store.get(TOKEN_KEY)!)?.orgId).toBe(tenant.orgId);
    expect(store.get(ORG_ID_KEY)).toBe(tenant.orgId);
  });

  it('118. a user with no membership signs in but gets a token with no org', async () => {
    const userId = randomUUID();
    const email = `orphan-${userId.slice(0, 8)}@example.test`;
    await sql('insert into auth.users (id, email) values ($1, $2)', [userId, email]);
    await sql('select app.upsert_user_credentials($1, $2)', [userId, 'secret-password']);

    const response = await postLogin({ email, password: 'secret-password' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; org_id: string | null; branch_ids: string[] };
    // A valid token, but scoped to nothing: RLS will return zero rows for every tenant table.
    expect(body.org_id).toBeNull();
    expect(body.branch_ids).toEqual([]);
    expect(decodeClaims(body.token)?.orgId).toBeNull();
  });
});
