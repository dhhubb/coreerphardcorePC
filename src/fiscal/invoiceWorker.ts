import { getPool } from '@/core/db';
import { applyUserContext, type AuthClaims } from '@/core/auth';
import type { FdmsClient } from './fdms';
import { FISCAL_WORKER_BATCH, runFiscalPassOn, type FiscalPassResult } from './queue';

/**
 * The fiscal worker (H3). It runs on the branch server as a LOOP, not a 30-second cron: the branch
 * process owns a long-lived worker that drains the pending fiscal invoices continuously, and the
 * loop is what a real deployment starts at boot.
 *
 * The claim (`app.fiscal_claim_pending`) uses FOR UPDATE SKIP LOCKED and the row lock is held for
 * the whole pass, so two workers running at once never submit the same invoice twice (test 68).
 */

export interface FiscalPassOptions {
  orgId: string;
  branchId: string;
  /** Claims the pass runs under. The submission is a branch-side operation, so a member's claims. */
  claims: AuthClaims;
  limit?: number;
}

/**
 * One submission pass in its own transaction. The whole pass is one transaction, so the claim locks
 * every claimed row until its outcome is recorded; a concurrent pass skips the locked rows.
 */
export async function runFiscalPass(
  fdms: FdmsClient,
  options: FiscalPassOptions,
): Promise<FiscalPassResult> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await applyUserContext(client, options.claims);
    const result = await runFiscalPassOn(client, fdms, {
      orgId: options.orgId,
      branchId: options.branchId,
      limit: options.limit ?? FISCAL_WORKER_BATCH,
    });
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface FiscalLoopOptions extends FiscalPassOptions {
  /** Milliseconds between passes. Default 5s — a loop, not a 30-second cron. */
  intervalMs?: number;
  /** Called after each pass; useful for logging. */
  onPass?: (result: FiscalPassResult) => void;
  /** Called when a pass throws; the loop keeps running. */
  onError?: (error: unknown) => void;
}

export interface FiscalLoopHandle {
  stop: () => void;
  /** Resolves after the in-flight pass finishes and the loop has stopped. */
  done: Promise<void>;
}

/**
 * Start the fiscal worker loop on the branch server. It keeps draining until `stop()` is called.
 * A pass that throws does not stop the loop: the next tick tries again, so an outage or a transient
 * database error never wedges the worker.
 */
export function startFiscalLoop(
  fdms: FdmsClient,
  options: FiscalLoopOptions,
): FiscalLoopHandle {
  const intervalMs = options.intervalMs ?? 5_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const done = (async () => {
    while (!stopped) {
      try {
        const result = await runFiscalPass(fdms, options);
        options.onPass?.(result);
      } catch (error) {
        options.onError?.(error);
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, intervalMs);
      });
    }
  })();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    done,
  };
}
