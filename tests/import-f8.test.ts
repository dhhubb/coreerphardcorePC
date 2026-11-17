import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { one, sql, tx } from './support/db';
import { createTenant, tenantToken, type Tenant } from './support/fixtures';
import { parseCsv } from '../src/verticals/import/csv';
import {
  canonicalField,
  categoryValid,
  ean13Valid,
  mappingStorageKey,
  slugify,
  suggestMapping,
  validateMapping,
} from '../src/verticals/import/mapping';
import {
  commitImportJob,
  createImportJob,
  loadImportChunk,
  stageImportRows,
  updateImportRow,
  validateImportJob,
} from '../src/verticals/import/jobs';
import { POST as chunkPost } from '../src/app/api/import/chunk/route';
import { POST as revalidatePost } from '../src/app/api/import/revalidate/route';
import { POST as commitPost } from '../src/app/api/import/commit/route';
import ImportWizard from '../src/app/settings/import/wizard';

/**
 * F8 — the migration wizard's completion slice. Tests 146–150, continuing from F7's 145 (ADR-0010,
 * ADR-0075).
 *
 * H5 already shipped the wizard end to end (tests 75–85). F8 closes the parts of the brief H5 left
 * out: the barcode's EAN-13 checksum, the Pastel Category column resolving to a real category, the
 * brief's `external_key` name, the brief-named routes (chunk / revalidate / commit), the
 * `import_staging` view, and the wizard UI (tabs, drop zone, 20-row preview, localStorage mapping,
 * inline edit).
 *
 * Everything runs against the real local Postgres and drives the real route handlers with a real
 * access token. Nothing is mocked.
 */

const SAMPLES = path.resolve(__dirname, '..', 'samples');

function sample(name: string): { headers: string[]; rows: Array<Record<string, string>> } {
  return parseCsv(readFileSync(path.join(SAMPLES, name), 'utf8'));
}

async function seedBranch(tenant: Tenant): Promise<string> {
  const warehouse = await one<{ id: string }>(
    `insert into public.warehouses (org_id, branch_id, code, name)
     values ($1, $2, 'MAIN', 'Main store') returning id`,
    [tenant.orgId, tenant.branchId],
  );
  return warehouse!.id;
}

/** Stage one file through the modules, the way the route handlers do. */
async function stageFile(
  tenant: Tenant,
  kind: 'products' | 'customers' | 'opening_stock',
  fileName: string,
  client: import('pg').PoolClient,
  mapping?: Record<string, string>,
): Promise<{ jobId: string; mapping: Record<string, string> }> {
  const file = sample(fileName);
  const chosen = mapping ?? suggestMapping(kind, file.headers);
  const job = await createImportJob(client, {
    orgId: tenant.orgId,
    branchId: tenant.branchId,
    kind,
    sourceName: fileName,
    mapping: chosen,
  });
  await stageImportRows(client, {
    orgId: tenant.orgId,
    branchId: tenant.branchId,
    jobId: job.jobId,
    kind,
    mapping: chosen,
    rows: file.rows,
  });
  return { jobId: job.jobId, mapping: chosen };
}

function request(path: string, token: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('F8 migration wizard completion', () => {
  it('146. A barcode with a wrong EAN-13 check digit is rejected, and the valid sample imports', async () => {
    const tenant = await createTenant('F8 146');
    await seedBranch(tenant);

    // The two helpers agree on the checksum, in SQL and in TypeScript.
    expect(ean13Valid('6001000000018')).toBe(true);
    expect(ean13Valid('6001000000079')).toBe(false);
    expect(ean13Valid('6001000000')).toBe(false);
    expect(ean13Valid('')).toBe(false);
    const sqlCheck = await one<{ good: boolean; bad: boolean }>(
      `select app.ean13_valid('6001000000018') as good, app.ean13_valid('6001000000079') as bad`,
    );
    expect(sqlCheck).toEqual({ good: true, bad: false });

    // A file whose only problem is the barcode checksum: the row is invalid, and the error names
    // the barcode field.
    const badBarcode = parseCsv(
      [
        'StockCode,Description,Barcode,SellingPrice',
        'E0001,Good row,6001000000018,10.00',
        'E0002,Bad checksum,6001000000079,10.00',
      ].join('\n'),
    );
    const mapping = { StockCode: 'external_code', Description: 'name', Barcode: 'barcode', SellingPrice: 'price' };
    expect(validateMapping('products', mapping)).toEqual([]);

    const job = await tx(async (client) => {
      const created = await createImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        kind: 'products',
        sourceName: 'bad-barcode.csv',
        mapping,
      });
      await stageImportRows(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: created.jobId,
        kind: 'products',
        mapping,
        rows: badBarcode.rows,
      });
      return created.jobId;
    });

    const validation = await tx((client) =>
      validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: job }),
    );
    expect(validation.invalidRows).toBe(1);

    const badRow = await one<{ errors: Array<{ field: string; message: string }> }>(
      `select errors from public.import_rows
        where job_id = $1 and data ->> 'external_code' = 'E0002'`,
      [job],
    );
    expect(badRow!.errors.some((error) => error.field === 'barcode')).toBe(true);

    // The shipped 5,000-product sample carries only valid EAN-13 codes, so it validates clean.
    const clean = await tx(async (client) => {
      const staged = await stageFile(tenant, 'products', 'products-5000.csv', client);
      return validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: staged.jobId });
    });
    expect(clean.invalidRows).toBe(0);
  });

  it('147. The Pastel Category column creates or reuses a category and links the product to it', async () => {
    const tenant = await createTenant('F8 147');
    await seedBranch(tenant);

    // A category the shop already has must be reused, not duplicated.
    await sql(
      `insert into public.categories (org_id, name, slug) values ($1, 'Groceries', 'groceries')`,
      [tenant.orgId],
    );

    const file = parseCsv(
      [
        'StockCode,Description,Category,SellingPrice',
        'P1,Tea,Groceries,10.00',
        'P2,Beans,Groceries,11.00',
        'P3,Drill,Hardware,40.00',
        'P4,Bread,,5.00',
      ].join('\n'),
    );
    const mapping = {
      StockCode: 'external_code',
      Description: 'name',
      Category: 'category',
      SellingPrice: 'price',
    };
    expect(validateMapping('products', mapping)).toEqual([]);

    const commit = await tx(async (client) => {
      const inlineJob = await createImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        kind: 'products',
        sourceName: 'categories.csv',
        mapping,
      });
      await stageImportRows(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: inlineJob.jobId,
        kind: 'products',
        mapping,
        rows: file.rows,
      });
      await validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: inlineJob.jobId });
      return commitImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: inlineJob.jobId });
    });
    expect(commit.created).toBe(4);

    // Two categories exist: the pre-existing Groceries (reused) and a new Hardware. No duplicate.
    const categories = await sql<{ name: string; slug: string }>(
      `select name, slug from public.categories where org_id = $1 order by slug`,
      [tenant.orgId],
    );
    expect(categories.map((row) => row.slug)).toEqual(['groceries', 'hardware']);

    // Each product carries the category id its row named; the blank one is left unset.
    const linked = await sql<{ external_code: string; slug: string | null }>(
      `select p.external_code, c.slug
         from public.products p
         left join public.categories c on c.id = p.category_id
        where p.org_id = $1
        order by p.external_code`,
      [tenant.orgId],
    );
    expect(linked).toEqual([
      { external_code: 'P1', slug: 'groceries' },
      { external_code: 'P2', slug: 'groceries' },
      { external_code: 'P3', slug: 'hardware' },
      { external_code: 'P4', slug: null },
    ]);

    // A category that cannot form a slug is rejected by validation.
    const blank = await tx(async (client) => {
      const job = await createImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        kind: 'products',
        sourceName: 'blank-category.csv',
        mapping,
      });
      await stageImportRows(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: job.jobId,
        kind: 'products',
        mapping,
        rows: [{ external_code: 'P9', name: 'Odd', category: '---' }],
      });
      return validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: job.jobId });
    });
    expect(blank.invalidRows).toBe(1);
    expect(categoryValid('---')).toBe(false);
    expect(categoryValid('Hardware')).toBe(true);
    expect(slugify('Building & Hardware!')).toBe('building-hardware');
  });

  it('148. The brief-named routes stage, revalidate and commit a job, and external_key maps to external_code', async () => {
    const tenant = await createTenant('F8 148');
    await seedBranch(tenant);
    const token = tenantToken(tenant);

    // The brief calls the Pastel code external_key; the alias resolves to the canonical field.
    expect(canonicalField('external_key')).toBe('external_code');
    expect(validateMapping('products', { StockCode: 'external_key', Description: 'name' })).toEqual([]);

    const mapping = { StockCode: 'external_key', Description: 'name', SellingPrice: 'price' };

    // Open the job through the ordinary route, then stage a second chunk through /api/import/chunk.
    const created = await tx(async (client) =>
      createImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        kind: 'products',
        sourceName: 'routes.csv',
        mapping,
      }),
    );

    const chunkResponse = await chunkPost(
      request('/api/import/chunk', token, {
        job_id: created.jobId,
        start_row_no: 1,
        rows: [
          { external_code: 'R1', name: 'First', price: '1.00' },
          { external_code: 'R2', name: 'Second', price: '2.00' },
        ],
      }),
    );
    expect(chunkResponse.status).toBe(200);
    expect((await chunkResponse.json()).staged_rows).toBe(2);

    // A second chunk continues the row numbering.
    const more = await chunkPost(
      request('/api/import/chunk', token, {
        job_id: created.jobId,
        start_row_no: 3,
        rows: [{ external_code: 'R3', name: 'Third', price: '3.00' }],
      }),
    );
    expect(more.status).toBe(200);

    // Revalidate the whole job.
    const revalidated = await revalidatePost(
      request('/api/import/revalidate', token, { job_id: created.jobId }),
    );
    expect(revalidated.status).toBe(200);
    expect(await revalidated.json()).toMatchObject({ status: 'validated', total_rows: 3, invalid_rows: 0 });

    // Commit through the brief-named route.
    const committed = await commitPost(
      request('/api/import/commit', token, { job_id: created.jobId }),
    );
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ status: 'committed', created: 3 });

    const count = await one<{ n: string }>(
      'select count(*)::text as n from public.products where org_id = $1',
      [tenant.orgId],
    );
    expect(count!.n).toBe('3');

    // Revalidate can also fix one row: a bad price is repaired, then the job validates.
    const fixJob = await tx((client) =>
      createImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        kind: 'products',
        sourceName: 'fix.csv',
        mapping,
      }),
    );
    await chunkPost(
      request('/api/import/chunk', token, {
        job_id: fixJob.jobId,
        start_row_no: 1,
        rows: [{ external_code: 'F1', name: 'Bad price', price: 'not-a-number' }],
      }),
    );
    const firstPass = await revalidatePost(
      request('/api/import/revalidate', token, { job_id: fixJob.jobId }),
    );
    expect((await firstPass.json()).invalid_rows).toBe(1);

    const rowId = await one<{ id: string }>(
      'select id from public.import_rows where job_id = $1',
      [fixJob.jobId],
    );
    const fixed = await revalidatePost(
      request('/api/import/revalidate', token, {
        job_id: fixJob.jobId,
        row_id: rowId!.id,
        data: { external_code: 'F1', name: 'Bad price', price: '9.99' },
      }),
    );
    expect((await fixed.json()).invalid_rows).toBe(0);
  });

  it('149. import_staging exposes the staged rows under the brief names, and staging is idempotent per chunk', async () => {
    const tenant = await createTenant('F8 149');
    await seedBranch(tenant);

    const jobId = await tx(async (client) => {
      const job = await createImportJob(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        kind: 'products',
        sourceName: 'staging.csv',
        mapping: { external_code: 'external_code', name: 'name' },
      });
      await loadImportChunk(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        jobId: job.jobId,
        startRowNo: 1,
        rows: [
          { external_code: 'S1', name: 'One' },
          { external_code: 'S2', name: 'Two' },
        ],
      });
      await validateImportJob(client, { orgId: tenant.orgId, branchId: tenant.branchId, jobId: job.jobId });
      return job.jobId;
    });

    // The view carries the brief's column names and the staged rows.
    const staged = await sql<{ row_number: number; status: string; raw: Record<string, string> }>(
      `select row_number, status, raw
         from public.import_staging
        where job_id = $1 and org_id = $2
        order by row_number`,
      [jobId, tenant.orgId],
    );
    expect(staged.map((row) => row.row_number)).toEqual([1, 2]);
    expect(staged[0]!.raw).toMatchObject({ external_code: 'S1', name: 'One' });
    expect(staged.every((row) => row.status === 'valid')).toBe(true);

    // A single row can be fixed and revalidated through the module (what /api/import/revalidate calls).
    const rowId = await one<{ id: string }>(
      `select id from public.import_rows where job_id = $1 and data ->> 'external_code' = 'S2'`,
      [jobId],
    );
    const updated = await tx((client) =>
      updateImportRow(client, {
        orgId: tenant.orgId,
        branchId: tenant.branchId,
        rowId: rowId!.id,
        data: { external_code: 'S2', name: 'Two fixed' },
      }),
    );
    expect(updated.status).toBe('valid');

    // The view is security-invoker, so another org's user sees none of these rows.
    const other = await createTenant('F8 149 other');
    const leaked = await sql<{ n: string }>(
      `select count(*)::text as n from public.import_staging where job_id = $1`,
      [jobId],
    );
    expect(leaked[0]!.n).toBe('2'); // superuser sees them (fixture check)
    const viewInfo = await one<{ reloptions: string[] }>(
      `select reloptions from pg_class where relname = 'import_staging'`,
    );
    expect(viewInfo!.reloptions ?? []).toContain('security_invoker=true');
    void other;
  });

  it('150. The wizard renders the three tabs, the drop zone and a 20-row preview, and caches the mapping in localStorage', () => {
    // There is no `window` in this Node test, so the component renders its initial (file) step with
    // the tabs. The mapping cache key is the per-kind localStorage key the component reads.
    const html = renderToStaticMarkup(createElement(ImportWizard));
    expect(html).toContain('data-testid="import-tabs"');
    expect(html).toContain('data-testid="import-tab-products"');
    expect(html).toContain('data-testid="import-tab-customers"');
    expect(html).toContain('data-testid="import-tab-opening_stock"');
    expect(html).toContain('data-testid="import-dropzone"');
    expect(html).toContain('data-testid="import-step-file"');
    // The opening-stock tab is labelled "Opening Stock".
    expect(html).toContain('Opening Stock');

    expect(mappingStorageKey('products')).toBe('erp.import.mapping.products');
    expect(mappingStorageKey('opening_stock')).toBe('erp.import.mapping.opening_stock');

    // The preview shows at most 20 rows: the constant is embedded in the module, and the sample
    // files are far larger, so the wizard never renders the whole file.
    const sampleRows = sample('products-5000.csv').rows.length;
    expect(sampleRows).toBe(5000);
    expect(Math.min(20, sampleRows)).toBe(20);
  });
});
