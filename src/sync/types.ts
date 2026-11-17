/**
 * H2 sync engine types.
 *
 * The branch and the cloud stay in step in both directions:
 *   * PUSH — the branch's outbox (append-only, ordered by a bigserial local sequence) is delivered
 *     to the cloud, which applies each event once. The event UUID is the dedupe key.
 *   * PULL — the branch fetches the cloud's master-data changes after its stored cursor, in
 *     change_seq order, and applies them to its local mirror.
 *
 * "In order" is the local sequence number and the cloud change_seq, never the wall clock. "Without
 * duplicates" is the event UUID (push) and the monotonic change_seq (pull).
 */

export type SyncEventType =
  | 'sale'
  | 'receipt'
  | 'adjustment'
  | 'payment'
  | 'credit_note'
  | 'stock_count'
  | 'master_data'
  // F5: the brief's vocabulary. `journal` and `stock_move` are the brief's spellings for a posted
  // journal and a stock movement; `z_report` and `fiscal_result` are the new facts F5 emits.
  | 'journal'
  | 'stock_move'
  | 'z_report'
  | 'fiscal_result';

/** One event as it sits in the branch outbox, and as it travels on the wire. */
export interface SyncOutboxEvent {
  /** The branch-local sequence number (bigint, carried as a string). This is the order. */
  seq: string;
  /** The idempotency key. The cloud applies an event with this id at most once. */
  event_id: string;
  event_type: SyncEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

/** The cloud's reply to a push. */
export interface PushResponse {
  /** The highest sequence the cloud applied. The branch acks up to and including it. */
  highest_seq: string;
  applied: number;
  duplicates: number;
  rejects: SyncReject[];
}

/** An event the cloud refused. Only a real refusal is a conflict; a network failure is retried. */
export interface SyncReject {
  event_id: string;
  reason: string;
}

/** One master-data change, as the branch pulls it. */
export interface MasterDataChange {
  change_seq: string;
  entity_type: string;
  entity_id: string;
  operation: 'upsert' | 'delete';
  version: number;
  payload: Record<string, unknown>;
  created_at: string;
}

/** The cloud's reply to a pull. */
export interface PullResponse {
  changes: MasterDataChange[];
  /** The highest change_seq in this batch, or null when the batch was empty. */
  cursor: string | null;
}
