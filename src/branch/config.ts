/**
 * Branch-mode configuration.
 *
 * One codebase, two deployments. `BRANCH_MODE=branch` runs the branch server: a local Postgres, a
 * local PIN sign-in, and no dependency on the cloud. The cloud-only features (Supabase Auth,
 * Realtime, Redis) are switched off by this setting rather than by a separate build, so the same
 * code and the same migrations run on both sides (ADR-0023).
 */

export type BranchMode = 'cloud' | 'branch';

/** The mode this process runs in. Defaults to `cloud`, so an unset variable is never branch mode. */
export function branchMode(): BranchMode {
  return (process.env.BRANCH_MODE ?? 'cloud').trim().toLowerCase() === 'branch' ? 'branch' : 'cloud';
}

export function isBranchMode(): boolean {
  return branchMode() === 'branch';
}

/**
 * The branch/cloud sync protocol version. The cloud is master; a branch refuses to push to a cloud
 * whose version it does not understand and shows a warning (ADR-0025). This constant must match
 * `app.branch_protocol_version()` in the schema.
 */
export const BRANCH_PROTOCOL_VERSION = 1;

/** The cloud base URL the branch pushes to. Null when unset, which is a valid offline state. */
export function cloudUrl(): string | null {
  const url = process.env.CLOUD_URL;
  return url && url.trim() !== '' ? url.trim().replace(/\/+$/, '') : null;
}

/** How long a cloud probe may take before the branch treats the cloud as unreachable. */
export function cloudProbeTimeoutMs(): number {
  const raw = Number.parseInt(process.env.CLOUD_PROBE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_500;
}

/**
 * How often the till polls the branch health endpoint. The brief fixes five seconds: often enough
 * that a cashier sees the cloud come back promptly, cheap enough that the branch (a single process
 * on a shop mini PC) is not busy answering. `BRANCH_HEALTH_POLL_MS` overrides it for a test.
 */
export function branchHealthPollMs(): number {
  const raw = Number.parseInt(process.env.BRANCH_HEALTH_POLL_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
}
