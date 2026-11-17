import type { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { moneyFromSql } from '@/core/money';
import { DEFAULT_PAGE_LIMIT } from '@/core/sales';
import {
  applyMapping,
  naturalKey,
  type ColumnMapping,
  type ImportKind,
  type SourceRow,
} from './mapping';
import { IMPORT_CHUNK_SIZE } from './csv';

export interface ImportJob {
  jobId: string;
  kind: ImportKind;
  status: 'draft' | 'validated' | 'invalid' | 'committed';
  totalRows: number;
  errorRows: number;
}

export interface ImportRowError {
  field: string;
  message: string;
}

/** A staged row exactly as `app.import_job_rows` returns it (snake_case JSON keys). */
export interface ImportRow {
  row_id: string;
  row_no: number;
  status: 'pending' | 'valid' | 'invalid' | 'skipped' | 'committed';
  data: Record<string, string>;
  errors: ImportRowError[];
}

export interface ImportValidation {
  jobId: string;
  status: 'validated' | 'invalid';
  totalRows: number;
  invalidRows: number;
  skippedRows: number;
}

export interface ImportCommitResult {
  jobId: string;
  status: 'committed';
  kind: ImportKind;
  created: number;
  updated: number;
  skipped: number;
  committedRows: number;
  journalId: string | null;
  totalValue: Decimal;
}

/** Open a job. The mapping is stored on the job so a re-run is reproducible. */
export async function createImportJob(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    kind: ImportKind;
    sourceName?: string | null;
    mapping: ColumnMapping;
  },
): Promise<ImportJob> {
  const result = await client.query<{ app: { job_id: string; status: string; kind: ImportKind } }>(
    `select app.import_job_create($1, $2, $3, $4, $5::jsonb) as app`,
    [input.orgId, input.branchId, input.kind, input.sourceName ?? null, JSON.stringify(input.mapping)],
  );
  const payload = result.rows[0]!.app;
  return {
    jobId: payload.job_id,
    kind: payload.kind,
    status: 'draft',
    totalRows: 0,
    errorRows: 0,
  };
}

/**
 * Load one chunk of mapped rows into the staging table with COPY. The rows are already mapped to
 * our fields in the browser; the branch just streams them in. `startRowNo` keeps the row numbers
 * contiguous across chunks so an error can always be pointed at a line in the original file.
 */
export async function loadImportChunk(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    jobId: string;
    startRowNo: number;
    rows: readonly Record<string, string>[];
  },
): Promise<number> {
  if (input.rows.length === 0) return 0;

  // One set-based INSERT per chunk, from a JSON array. A request path runs as `authenticated`,
  // and Postgres refuses `COPY FROM` under row-level security (0A000), so COPY cannot be the
  // request path's loader. A single INSERT ... SELECT from jsonb_array_elements is RLS-safe (the
  // INSERT policy still checks the org and branch) and stays one statement per chunk, which is
  // what keeps a 5,000-row file to ten round trips (ADR-0075).
  await client.query(
    `insert into public.import_rows (org_id, branch_id, job_id, row_no, data)
     select $1, $2, $3, $4 + (ordinality - 1), value
       from jsonb_array_elements($5::jsonb) with ordinality as t(value, ordinality)`,
    [input.orgId, input.branchId, input.jobId, input.startRowNo, JSON.stringify(input.rows)],
  );

  return input.rows.length;
}

/** Stage a whole file: chunk it, map it, load each chunk in one INSERT. Returns the number staged. */
export async function stageImportRows(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    jobId: string;
    kind: ImportKind;
    mapping: ColumnMapping;
    rows: readonly SourceRow[];
    chunkSize?: number;
  },
): Promise<number> {
  const size = input.chunkSize ?? IMPORT_CHUNK_SIZE;
  let staged = 0;
  for (let offset = 0; offset < input.rows.length; offset += size) {
    const chunk = input.rows.slice(offset, offset + size);
    const mapped = chunk.map((row) => applyMapping(input.mapping, row));
    await loadImportChunk(client, {
      orgId: input.orgId,
      branchId: input.branchId,
      jobId: input.jobId,
      startRowNo: offset + 1,
      rows: mapped,
    });
    staged += mapped.length;
  }
  return staged;
}

/** Validate every staged row in SQL. Per-row errors are stored against the row number. */
export async function validateImportJob(
  client: PoolClient,
  input: { orgId: string; branchId: string; jobId: string },
): Promise<ImportValidation> {
  const result = await client.query<{
    app: {
      job_id: string;
      status: 'validated' | 'invalid';
      total_rows: number;
      invalid_rows: number;
      skipped_rows: number;
    };
  }>(`select app.import_validate_job($1, $2, $3) as app`, [
    input.orgId,
    input.branchId,
    input.jobId,
  ]);
  const payload = result.rows[0]!.app;
  return {
    jobId: payload.job_id,
    status: payload.status,
    totalRows: payload.total_rows,
    invalidRows: payload.invalid_rows,
    skippedRows: payload.skipped_rows,
  };
}

/** Fix one row's data and revalidate it. The caller revalidates the job afterwards. */
export async function updateImportRow(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    rowId: string;
    data: Record<string, string>;
  },
): Promise<ImportRow> {
  const result = await client.query<{
    app: { row_id: string; row_no: number; status: ImportRow['status']; errors: ImportRowError[] };
  }>(`select app.import_update_row($1, $2, $3, $4::jsonb) as app`, [
    input.orgId,
    input.branchId,
    input.rowId,
    JSON.stringify(input.data),
  ]);
  const payload = result.rows[0]!.app;
  return {
    row_id: payload.row_id,
    row_no: payload.row_no,
    status: payload.status,
    data: input.data,
    errors: payload.errors,
  };
}

/** Commit the whole job in one transaction. Any invalid row blocks it. */
export async function commitImportJob(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    jobId: string;
    postingDate?: string | null;
  },
): Promise<ImportCommitResult> {
  const result = await client.query<{
    app: {
      job_id: string;
      status: 'committed';
      kind: ImportKind;
      created: number;
      updated: number;
      skipped: number;
      committed_rows: number;
      journal_id: string | null;
      total_value: string;
    };
  }>(`select app.import_commit_job($1, $2, $3, $4::date) as app`, [
    input.orgId,
    input.branchId,
    input.jobId,
    input.postingDate ?? null,
  ]);
  const payload = result.rows[0]!.app;
  return {
    jobId: payload.job_id,
    status: 'committed',
    kind: payload.kind,
    created: payload.created,
    updated: payload.updated,
    skipped: payload.skipped,
    committedRows: payload.committed_rows,
    journalId: payload.journal_id,
    totalValue: moneyFromSql(payload.total_value),
  };
}

/** A keyset page of rows and their errors, ordered by row number. */
export async function listImportRows(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    jobId: string;
    limit?: number;
    afterRowNo?: number;
  },
): Promise<{ rows: ImportRow[]; next_after_row_no: number | null }> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_LIMIT, 1), 100);
  const result = await client.query<{
    app: { rows: ImportRow[]; next_after_row_no: number | null };
  }>(`select app.import_job_rows($1, $2, $3, $4, $5) as app`, [
    input.orgId,
    input.branchId,
    input.jobId,
    limit,
    input.afterRowNo ?? 0,
  ]);
  const payload = result.rows[0]!.app;
  return { rows: payload.rows, next_after_row_no: payload.next_after_row_no };
}

/** The saved mapping for a shop, or an empty mapping. */
export async function getImportMapping(
  client: PoolClient,
  input: { orgId: string; branchId: string; kind: ImportKind },
): Promise<ColumnMapping> {
  const result = await client.query<{ app: ColumnMapping }>(
    `select app.import_get_mapping($1, $2, $3) as app`,
    [input.orgId, input.branchId, input.kind],
  );
  return result.rows[0]!.app;
}

/** Save the mapping for a shop so the next run does not remap the columns. */
export async function saveImportMapping(
  client: PoolClient,
  input: { orgId: string; branchId: string; kind: ImportKind; mapping: ColumnMapping },
): Promise<ColumnMapping> {
  const result = await client.query<{ app: ColumnMapping }>(
    `select app.import_save_mapping($1, $2, $3, $4::jsonb) as app`,
    [input.orgId, input.branchId, input.kind, JSON.stringify(input.mapping)],
  );
  return result.rows[0]!.app;
}

export { naturalKey };
