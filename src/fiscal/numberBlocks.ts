import type { PoolClient } from 'pg';

/**
 * Number blocks (H3). Invoice numbers are gapless and never reused. The cloud reserves a
 * contiguous block for each branch; the branch takes numbers from its local block and requests the
 * NEXT block before the current one runs out, so a branch that goes offline still has headroom.
 *
 * When a block runs out while the branch is offline and no block is left to claim, the sale fails
 * with a clear message and no number is reused (`app.claim_invoice_number` raises).
 */

export interface NumberBlockStatus {
  exhausted: boolean;
  remaining: number;
  blockNo: string | null;
  firstValue?: string;
  lastValue?: string;
  nextValue?: string;
}

interface RawBlockStatus {
  exhausted: boolean;
  remaining: number | string;
  block_no: string | null;
  first_value?: string | null;
  last_value?: string | null;
  next_value?: string | null;
}

function toStatus(raw: RawBlockStatus): NumberBlockStatus {
  return {
    exhausted: raw.exhausted,
    remaining: Number(raw.remaining),
    blockNo: raw.block_no,
    ...(raw.first_value != null ? { firstValue: String(raw.first_value) } : {}),
    ...(raw.last_value != null ? { lastValue: String(raw.last_value) } : {}),
    ...(raw.next_value != null ? { nextValue: String(raw.next_value) } : {}),
  };
}

/** The branch's current block state (remaining numbers, bounds, exhaustion). */
export async function numberBlockStatus(
  client: PoolClient,
  input: { orgId: string; branchId: string; seriesCode?: string },
): Promise<NumberBlockStatus> {
  const result = await client.query<{ app: RawBlockStatus }>(
    `select app.number_block_status($1, $2, $3) as app`,
    [input.orgId, input.branchId, input.seriesCode ?? 'INVOICE'],
  );
  return toStatus(result.rows[0]!.app);
}

/** A block as the cloud issues it. */
export interface IssuedBlock {
  blockNo: string;
  firstValue: string;
  lastValue: string;
  size: number;
}

interface RawIssuedBlock {
  block_no: string | number;
  first_value: string | number;
  last_value: string | number;
  size: number;
}

function toIssued(raw: RawIssuedBlock): IssuedBlock {
  return {
    blockNo: String(raw.block_no),
    firstValue: String(raw.first_value),
    lastValue: String(raw.last_value),
    size: Number(raw.size),
  };
}

/** Cloud: reserve the next block for a branch. */
export async function issueNumberBlock(
  client: PoolClient,
  input: { orgId: string; branchId: string; seriesCode?: string; size?: number },
): Promise<IssuedBlock> {
  const result = await client.query<{ app: RawIssuedBlock }>(
    `select app.issue_number_block($1, $2, $3, $4) as app`,
    [input.orgId, input.branchId, input.seriesCode ?? 'INVOICE', input.size ?? 200],
  );
  return toIssued(result.rows[0]!.app);
}

/** Branch: store a block the cloud issued (idempotent on the block number). */
export async function storeNumberBlock(
  client: PoolClient,
  input: {
    orgId: string;
    branchId: string;
    block: IssuedBlock;
    seriesCode?: string;
  },
): Promise<NumberBlockStatus> {
  const result = await client.query<{ app: RawBlockStatus }>(
    `select app.store_number_block($1, $2, $3, $4, $5, $6) as app`,
    [
      input.orgId,
      input.branchId,
      input.block.blockNo,
      input.block.firstValue,
      input.block.lastValue,
      input.seriesCode ?? 'INVOICE',
    ],
  );
  return toStatus(result.rows[0]!.app);
}

/**
 * A block fetcher: how the branch asks the cloud for the next block. The gate injects a local
 * fetcher; a real deployment uses `cloudBlockFetcher`, which POSTs to the cloud.
 */
export type NumberBlockFetcher = () => Promise<IssuedBlock>;

/** Ask the cloud for the next block over HTTP. Needs the cloud URL and a branch token. */
export function cloudBlockFetcher(input: {
  cloudUrl: string;
  token: string;
  branchId: string;
  seriesCode?: string;
  size?: number;
  fetchImpl?: typeof fetch;
}): NumberBlockFetcher {
  const fetchImpl = input.fetchImpl ?? fetch;
  return async () => {
    const response = await fetchImpl(`${input.cloudUrl.replace(/\/+$/, '')}/api/branch/numbers/claim`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({
        branch_id: input.branchId,
        series_code: input.seriesCode ?? 'INVOICE',
        size: input.size ?? 200,
      }),
    });
    if (!response.ok) {
      throw new Error(`cloud refused a number block: ${response.status}`);
    }
    const body = (await response.json()) as { block: Record<string, unknown> };
    // The cloud claim route returns the block in the camelCase `IssuedBlock` shape. Accept the
    // snake_case spelling too, so a proxy that renames keys cannot silently yield an undefined block.
    const block = body.block;
    return {
      blockNo: String(block.blockNo ?? block.block_no),
      firstValue: String(block.firstValue ?? block.first_value),
      lastValue: String(block.lastValue ?? block.last_value),
      size: Number(block.size),
    };
  };
}

/** How many numbers must remain before the branch asks the cloud for the next block. */
export const NUMBER_BLOCK_LOW_WATER = 20;

/**
 * The brief's low-water mark: top up when less than 20% of the active block is left. Expressed as a
 * percentage so it scales with the block size the cloud issued.
 */
export const NUMBER_BLOCK_LOW_WATER_PERCENT = 20;

/**
 * The low-water threshold for a block: 20% of its size, at least one number. Falls back to the fixed
 * `NUMBER_BLOCK_LOW_WATER` count when the active block's bounds are unknown (for example when the
 * branch is already exhausted).
 */
export function lowWaterForBlock(status: NumberBlockStatus): number {
  const first = status.firstValue != null ? Number(status.firstValue) : null;
  const last = status.lastValue != null ? Number(status.lastValue) : null;
  if (first === null || last === null || !Number.isFinite(first) || !Number.isFinite(last) || last < first) {
    return NUMBER_BLOCK_LOW_WATER;
  }
  const size = last - first + 1;
  return Math.max(1, Math.ceil((size * NUMBER_BLOCK_LOW_WATER_PERCENT) / 100));
}

/**
 * How many numbers are left in the ACTIVE block alone. The brief tops up when the CURRENT block is
 * nearly used up, so this is what the low-water test compares against — not the total headroom,
 * which also counts any blocks already fetched ahead. Falls back to the total when the active
 * block's bounds are unknown.
 */
export function activeBlockRemaining(status: NumberBlockStatus): number {
  const next = status.nextValue != null ? Number(status.nextValue) : null;
  const last = status.lastValue != null ? Number(status.lastValue) : null;
  if (next === null || last === null || !Number.isFinite(next) || !Number.isFinite(last)) {
    return status.remaining;
  }
  return Math.max(0, last - next + 1);
}

export interface EnsureBlockResult {
  status: NumberBlockStatus;
  requested: boolean;
}

/**
 * Request the next block BEFORE the current one is used up. Called on the branch after each sale
 * (or on a timer): when the ACTIVE block's remaining count falls to the low-water mark — 20% of the
 * block by default, or an explicit `lowWater` count — fetch a block and store it. A failed fetch is
 * not fatal — the branch keeps using what it has — so an offline branch keeps selling until its
 * block really runs out.
 */
export async function ensureNextBlock(
  client: PoolClient,
  fetchBlock: NumberBlockFetcher,
  input: { orgId: string; branchId: string; seriesCode?: string; lowWater?: number },
): Promise<EnsureBlockResult> {
  const before = await numberBlockStatus(client, input);

  // Nothing to top up while the current block still has more than the low-water mark left. When the
  // branch is exhausted we fall through and try a fetch (a fetch only helps if the cloud is
  // reachable; the sale path handles the truly-exhausted case).
  if (!before.exhausted) {
    const threshold = input.lowWater ?? lowWaterForBlock(before);
    if (activeBlockRemaining(before) > threshold) {
      return { status: before, requested: false };
    }
  }

  try {
    const block = await fetchBlock();
    const status = await storeNumberBlock(client, {
      orgId: input.orgId,
      branchId: input.branchId,
      block,
      ...(input.seriesCode !== undefined ? { seriesCode: input.seriesCode } : {}),
    });
    return { status, requested: true };
  } catch {
    // Offline: keep the current block. The branch keeps selling until it truly runs out.
    return { status: before, requested: false };
  }
}
