import type { PoolClient } from 'pg';
import { DEFAULT_PAGE_LIMIT, type PageCursor } from '@/core/sales';
import type { FdmsClient, FdmsOutcome } from './fdms';

/**
 * The fiscal invoice queue (H3). A sale's invoice writes one pending `fiscal_invoices` row in the
 * invoice's own transaction; this module is everything that reads and advances those rows:
 * the worker's claim (FOR UPDATE SKIP LOCKED), the attempt recording, and the admin operations
 * (queue page, retry, manual submit).
 *
 * The rules the schema enforces and this module relies on:
 *   * A row is 'pending' until the device accepts it ('sent') or it has had 5 real rejections
 *     ('failed').
 *   * A network outage ('unreachable') leaves the row pending and does NOT count as an attempt.
 */

export const FISCAL_STATUSES = ['pending', 'sent', 'failed'] as const;
export type FiscalStatus = (typeof FISCAL_STATUSES)[number];

/** Real rejections before a row moves to 'failed'. */
export const FISCAL_MAX_ATTEMPTS = 5;

/**
 * The brief's worker batch: claim at most this many pending rows per pass. H3 claimed 50 by default;
 * the worker loop now uses 10, so a pass is short and the row locks are held briefly.
 */
export const FISCAL_WORKER_BATCH = 10;

export interface FiscalInvoiceRow {
  id: string;
  invoiceId: string;
  invoiceNo: string;
  status: FiscalStatus;
  attempts: number;
  lastError: string | null;
  fdmsResponse: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface FiscalSummary {
  pending: number;
  sent: number;
  failed: number;
  total: number;
}

export interface FiscalClaim {
  fiscalInvoiceId: string;
  invoiceId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface RawQueueRow {
  id: string;
  invoice_id: string;
  invoice_no: string;
  status: string;
  attempts: number;
  last_error: string | null;
  fdms_response: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

function toRow(raw: RawQueueRow): FiscalInvoiceRow {
  return {
    id: raw.id,
    invoiceId: raw.invoice_id,
    invoiceNo: raw.invoice_no,
    status: raw.status as FiscalStatus,
    attempts: raw.attempts,
    lastError: raw.last_error,
    fdmsResponse: raw.fdms_response,
    createdAt: raw.created_at.toISOString(),
    updatedAt: raw.updated_at.toISOString(),
  };
}

/** One keyset page of the branch's fiscal queue, newest first. Never OFFSET. */
export async function listFiscalQueue(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    limit?: number;
    cursor?: PageCursor | null;
  },
): Promise<{ rows: FiscalInvoiceRow[]; nextCursor: PageCursor | null }> {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await client.query<RawQueueRow>(
    `select id, invoice_id, invoice_no, status, attempts, last_error, fdms_response,
            created_at, updated_at
       from app.fiscal_invoice_queue($1, $2, $3, $4::timestamptz, $5::uuid)`,
    [input.orgId, input.branchId, limit, input.cursor?.createdAt ?? null, input.cursor?.id ?? null],
  );
  const rows = result.rows.map(toRow);
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? { createdAt: last.createdAt, id: last.id } : null;
  return { rows, nextCursor };
}

/** Counts by status for the branch, for the admin page header. */
export async function fiscalSummary(
  client: PoolClient,
  input: { orgId: string; branchId: string },
): Promise<FiscalSummary> {
  const result = await client.query<{ app: FiscalSummary }>(
    `select app.fiscal_invoice_summary($1, $2) as app`,
    [input.orgId, input.branchId],
  );
  return result.rows[0]!.app;
}

/** Admin: retry a failed row (clears the attempt counter, re-arms it as pending). */
export async function retryFiscalInvoice(
  client: PoolClient,
  input: { orgId: string; branchId: string; fiscalInvoiceId: string },
): Promise<void> {
  await client.query(`select app.fiscal_invoice_retry($1, $2, $3) as app`, [
    input.orgId,
    input.branchId,
    input.fiscalInvoiceId,
  ]);
}

/** Admin: manual submit — re-arm a pending or failed row as due now. */
export async function manualSendFiscalInvoice(
  client: PoolClient,
  input: { orgId: string; branchId: string; fiscalInvoiceId: string },
): Promise<void> {
  await client.query(`select app.fiscal_invoice_manual_send($1, $2, $3) as app`, [
    input.orgId,
    input.branchId,
    input.fiscalInvoiceId,
  ]);
}

/**
 * Claim the pending rows the worker may submit now, oldest first, with FOR UPDATE SKIP LOCKED.
 * The caller must hold the transaction open until each claimed row's outcome is recorded: the row
 * lock is what stops a second worker from submitting the same invoice.
 */
export async function claimPendingFiscalInvoices(
  client: PoolClient,
  input: { orgId: string; branchId: string; limit?: number },
): Promise<FiscalClaim[]> {
  const result = await client.query<{
    id: string;
    invoice_id: string;
    fdms_payload: Record<string, unknown>;
    attempts: number;
  }>(
    `select id, invoice_id, fdms_payload, attempts
       from app.fiscal_claim_pending($1, $2, $3)`,
    [input.orgId, input.branchId, input.limit ?? 50],
  );
  return result.rows.map((row) => ({
    fiscalInvoiceId: row.id,
    invoiceId: row.invoice_id,
    payload: row.fdms_payload,
    attempts: row.attempts,
  }));
}

/** Record the outcome of one real submission. Delegates to `app.fiscal_invoice_attempt`. */
export async function recordFiscalOutcome(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    fiscalInvoiceId: string;
    outcome: FdmsOutcome;
    response?: Record<string, unknown> | null;
    error?: string | null;
  },
): Promise<{ status: FiscalStatus; attempts: number }> {
  const result = await client.query<{ app: { status: string; attempts: number } }>(
    `select app.fiscal_invoice_attempt($1, $2, $3, $4, $5::jsonb, $6) as app`,
    [
      input.orgId,
      input.branchId,
      input.fiscalInvoiceId,
      input.outcome,
      input.response ? JSON.stringify(input.response) : null,
      input.error ?? null,
    ],
  );
  const app = result.rows[0]!.app;
  return { status: app.status as FiscalStatus, attempts: app.attempts };
}

export interface FiscalPassResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

/**
 * One submission pass over the branch's due rows, on an open connection. The caller owns the
 * transaction: the claim locks the rows, the submission happens, the outcome is recorded, and only
 * then is the transaction committed. Because the claim is SKIP LOCKED and the lock is held for the
 * whole pass, two passes running at once never submit the same invoice.
 */
export async function runFiscalPassOn(
  client: PoolClient,
  fdms: FdmsClient,
  input: { orgId: string; branchId: string; limit?: number },
): Promise<FiscalPassResult> {
  const claims = await claimPendingFiscalInvoices(client, input);

  let sent = 0;
  let retried = 0;
  let failed = 0;
  for (const claim of claims) {
    const submission = {
      invoiceId: claim.invoiceId,
      invoiceNo: String(claim.payload.invoice_no ?? ''),
      payload: claim.payload,
      attempt: claim.attempts,
    };
    const result = await fdms.submit(submission);
    const recorded = await recordFiscalOutcome(client, {
      orgId: input.orgId,
      branchId: input.branchId,
      fiscalInvoiceId: claim.fiscalInvoiceId,
      outcome: result.outcome,
      response: result.response ?? null,
      error: result.error ?? null,
    });
    if (result.outcome === 'sent') sent += 1;
    else if (recorded.status === 'failed') failed += 1;
    else retried += 1;
  }

  return { claimed: claims.length, sent, retried, failed };
}
