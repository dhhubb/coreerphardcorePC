import { NextResponse } from 'next/server';
import { BRANCH_PROTOCOL_VERSION, branchMode, isBranchMode } from '@/branch/config';

/**
 * GET /api/branch/config — how this deployment signs in.
 *
 * The /login page reads this to decide whether to render the cashier PIN picker (branch mode) or
 * the email/password form (cloud mode). It is deliberately unauthenticated: it is the first request
 * a till makes, before anyone has signed in, and it exposes nothing but the mode.
 */

export function GET(): NextResponse {
  return NextResponse.json({
    mode: branchMode(),
    branch_mode: isBranchMode(),
    pin_login: isBranchMode(),
    protocol_version: BRANCH_PROTOCOL_VERSION,
    org_id: isBranchMode() ? (process.env.BRANCH_ORG_ID ?? null) : null,
    branch_id: isBranchMode() ? (process.env.BRANCH_ID ?? null) : null,
  });
}
