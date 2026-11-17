/**
 * The push worker: branch -> cloud.
 *
 * One batch is read from the outbox in sequence order, sent to the cloud, and acked only when the
 * cloud confirms it. The rules:
 *
 *   * Only ONE push is ever in flight per branch, so two ticks cannot deliver the same batch twice.
 *   * A batch is acked up to the highest sequence the cloud PROCESSED. The cloud applies every
 *     event it can and reports the highest sequence it handled, so a rejected event no longer
 *     blocks the events after it (F5) and the outbox can drain.
 *   * A network failure is retried forever with exponential backoff and jitter (never a conflict).
 *   * A real rejection is recorded as a durable conflict carrying BOTH versions (what the branch
 *     sent and what the cloud said), so the status page shows both and a human can re-queue it.
 */

import type { PoolClient } from 'pg';
import { SYNC_PUSH_BATCH_SIZE, syncTimeoutMs } from './config';
import { ackUpTo, outboxMaxSeq, pendingEvents } from './outbox';
import {
  SyncNetworkError,
  SyncRejectionError,
  SyncServerError,
  isRetryable,
  retryDelayMs,
} from './retry';
import type { PushResponse, SyncOutboxEvent, SyncReject } from './types';

/** How a batch reaches the cloud. Injectable so the worker can be tested without a live cloud. */
export type PushDeliver = (events: import('./types').SyncOutboxEvent[]) => Promise<PushResponse>;

export interface PushOutcome {
  /** The highest sequence the cloud applied and the branch acked. '0' when nothing was sent. */
  ackedSeq: string;
  sent: number;
  applied: number;
  duplicates: number;
  /** Events the cloud refused, now recorded as conflicts. */
  rejected: SyncReject[];
  /** True when there was nothing to push. */
  idle: boolean;
  /** When the next attempt should run, after a retryable failure. Null on success. */
  retryAtMs: number | null;
}

let inFlight = false;

/** True while a push is running, so a caller can skip a tick. */
export function pushInFlight(): boolean {
  return inFlight;
}

export interface PushContext {
  client: PoolClient;
  orgId: string;
  branchId: string;
  deliver: PushDeliver;
  /** Injected for deterministic tests; defaults to Math.random. */
  random?: () => number;
  /** The attempt number for backoff; the caller keeps this across ticks. */
  attempt?: number;
}

/**
 * Run one push tick. Returns the outcome. On a retryable failure it returns `retryAtMs` and the
 * caller should wait before the next tick; the unacked events stay in the outbox.
 */
export async function pushOnce(ctx: PushContext): Promise<PushOutcome> {
  const idle: PushOutcome = {
    ackedSeq: '0',
    sent: 0,
    applied: 0,
    duplicates: 0,
    rejected: [],
    idle: true,
    retryAtMs: null,
  };

  if (inFlight) return idle;
  const events = await pendingEvents(ctx.client, ctx.orgId, ctx.branchId, SYNC_PUSH_BATCH_SIZE);
  if (events.length === 0) return idle;

  inFlight = true;
  try {
    const response = await ctx.deliver(events);
    const rejected = response.rejects ?? [];

    // Record a durable conflict for every rejection, carrying both versions, then ack up to the
    // highest sequence the cloud processed. The cloud applies every event it can and reports the
    // highest sequence it handled, so a rejected event is resolved (recorded as a conflict) and the
    // outbox drains instead of re-pushing the same bad event forever.
    for (const reject of rejected) {
      await recordConflict(ctx, events, reject);
    }

    const ackTo = response.highest_seq ?? '0';
    const acked = ackTo !== '0' ? await ackUpTo(ctx.client, ctx.orgId, ctx.branchId, ackTo) : 0;

    return {
      ackedSeq: acked > 0 ? ackTo : '0',
      sent: events.length,
      applied: response.applied ?? 0,
      duplicates: response.duplicates ?? 0,
      rejected,
      idle: false,
      retryAtMs: null,
    };
  } catch (error) {
    if (error instanceof SyncRejectionError) {
      // Should be rare: the cloud returns rejects inside a 200. Handled for completeness.
      for (const reject of error.rejects) await recordConflict(ctx, events, reject);
      const ackTo = highestSeqOf(events, error.rejects);
      if (ackTo !== '0') await ackUpTo(ctx.client, ctx.orgId, ctx.branchId, ackTo);
      return { ...idle, idle: false, sent: events.length, rejected: error.rejects, ackedSeq: ackTo };
    }
    if (isRetryable(error)) {
      const attempt = (ctx.attempt ?? 0) + 1;
      return {
        ...idle,
        idle: false,
        sent: events.length,
        retryAtMs: Date.now() + retryDelayMs(attempt, ctx.random),
      };
    }
    throw error;
  } finally {
    inFlight = false;
  }
}

async function recordConflict(
  ctx: PushContext,
  events: SyncOutboxEvent[],
  reject: SyncReject,
): Promise<void> {
  const event = events.find((candidate) => candidate.event_id === reject.event_id);
  const bothVersions = {
    local: event
      ? { seq: event.seq, event_type: event.event_type, payload: event.payload }
      : { seq: '0', event_type: 'unknown', payload: {} },
    cloud: { reason: reject.reason },
  };
  await ctx.client.query(
    'select app.sync_record_conflict($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)',
    [
      ctx.orgId,
      ctx.branchId,
      reject.event_id,
      event ? event.seq : '0',
      event ? event.event_type : 'unknown',
      reject.reason,
      JSON.stringify({}),
      JSON.stringify(bothVersions),
    ],
  );
}

/** The highest sequence among the rejected events, or '0' when none is in this batch. */
function highestSeqOf(events: SyncOutboxEvent[], rejects: SyncReject[]): string {
  const ids = new Set(rejects.map((reject) => reject.event_id));
  let best = '0';
  for (const event of events) {
    if (ids.has(event.event_id) && compareSeq(event.seq, best) > 0) best = event.seq;
  }
  return best;
}

/** Compare two bigint-as-string sequence numbers without losing precision. */
export function compareSeq(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export { SyncNetworkError, SyncServerError, SyncRejectionError };
export { outboxMaxSeq };
export { syncTimeoutMs };
