import { NextResponse } from 'next/server';
import { login } from '@/core/login';
import { jsonError, toErrorResponse } from '../../_lib';

/**
 * POST /api/auth/login — email and password sign-in.
 *
 * Exempt from the auth middleware (a signed-out user has no token yet). The password is verified in
 * Postgres against a bcrypt hash; on success the route returns a token and the org it scopes. A
 * wrong email and a wrong password both return 401 with the same body, so the response never
 * reveals which accounts exist.
 */

interface LoginBody {
  email?: string;
  password?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as LoginBody;
    const email = body.email?.trim();
    const password = body.password;
    if (!email || !password) {
      return jsonError(422, 'email and password are required');
    }

    const result = await login(email, password);
    if (!result) {
      return jsonError(401, 'invalid email or password');
    }

    return NextResponse.json({
      token: result.token,
      expires_at: result.expiresAt,
      org_id: result.orgId,
      org_name: result.orgName,
      branch_ids: result.branchIds,
      role: result.role,
      member_role: result.memberRole,
      user: { id: result.userId, email: result.email },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
