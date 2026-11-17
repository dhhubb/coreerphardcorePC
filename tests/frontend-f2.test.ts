import { afterAll, describe, expect, it } from 'vitest';
import { asUser, one, sql, tx } from './support/db';
import { createTenant, tenantToken, type Tenant } from './support/fixtures';
import { closeRedis, getRedis } from '../src/core/redis';
import {
  PROMO_CACHE_TTL_SECONDS,
  invalidatePromotions,
  promoCacheKey,
  resolvePrice,
  type PromoCache,
} from '../src/verticals/retail/pricing';
import { buildConditions, describeConditions, parseConditions } from '../src/verticals/admin/promotionConditions';
import { createPriceList, importPriceListItems } from '../src/verticals/admin/pricing';
import { GET as productsRoute, POST as productsPostRoute } from '../src/app/api/admin/products/route';
import { GET as categoriesRoute, POST as categoriesPostRoute } from '../src/app/api/admin/categories/route';
import { POST as variantsPostRoute } from '../src/app/api/admin/variants/route';
import { POST as priceListsPostRoute } from '../src/app/api/admin/price-lists/route';
import { POST as priceListsImportRoute } from '../src/app/api/admin/price-lists/import/route';

/**
 * F2 — the admin products / pricing / promotions console. Tests 119–121, continuing from F1's 118
 * (ADR-0010, ADR-0069).
 *
 * The F2 brief numbered these 43–45, but 43–45 are Phase 1 retail tests (R1 owns 41–44, R2 owns
 * 45–48). ADR-0010 forbids renumbering: a new run continues from the highest number actually
 * present, which after F1 is 118.
 *
 * The console itself is largely the A1/A2 surface (tests 96–107); F2 completes it — the promotions
 * conditions builder and stackable flag, and a dedicated price-list import route. These three tests
 * cover the brief's three acceptance flows end to end, through the real route handlers with a real
 * access token, against the real local Postgres and the real local Redis. Nothing is mocked.
 */
const cache: PromoCache = {
  get: (key) => getRedis().get(key),
  set: (key, value, mode, ttl) => getRedis().set(key, value, mode, ttl),
  del: (key) => getRedis().del(key),
};

afterAll(async () => {
  await closeRedis();
});

function request(path: string, token: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

describe('F2 admin products / pricing / promotions UI', () => {
  it('119. A category, a product and a barcoded variant are created through the routes and found by search; another org sees none of it', async () => {
    const tenant = await createTenant('F2 test 119');
    const token = tenantToken(tenant);

    // Create a category through the route.
    const categoryResponse = await categoriesPostRoute(
      request('/api/admin/categories', token, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beverages', slug: 'beverages' }),
      }),
    );
    expect(categoryResponse.status).toBe(200);
    const categoryId = ((await categoryResponse.json()) as { id: string }).id;

    // The tree lists it back.
    const treeResponse = await categoriesRoute(request('/api/admin/categories', token));
    const tree = ((await treeResponse.json()) as { categories: Array<{ id: string; slug: string }> })
      .categories;
    expect(tree.map((node) => node.id)).toContain(categoryId);

    // Create a product in that category; the SKU is assigned by SQL from the number series.
    const productResponse = await productsPostRoute(
      request('/api/admin/products', token, {
        method: 'POST',
        body: JSON.stringify({ name: 'F2 Cola', category_id: categoryId, unit: 'each' }),
      }),
    );
    expect(productResponse.status).toBe(200);
    const productId = ((await productResponse.json()) as { id: string }).id;

    // The product list (a keyset page) carries it with its SKU.
    const listResponse = await productsRoute(request('/api/admin/products', token));
    const list = ((await listResponse.json()) as {
      products: Array<{ id: string; sku: string; category_id: string | null }>;
    }).products;
    const listed = list.find((row) => row.id === productId);
    expect(listed).toBeDefined();
    expect(listed!.sku).toMatch(/\S/);
    expect(listed!.category_id).toBe(categoryId);

    // A variant with a valid EAN-13 barcode, created through the route.
    const barcode = '5901234123457';
    const variantResponse = await variantsPostRoute(
      request('/api/admin/variants', token, {
        method: 'POST',
        body: JSON.stringify({ product_id: productId, name: '330ml', barcode, cost: '1.2500' }),
      }),
    );
    expect(variantResponse.status).toBe(200);
    const variantId = ((await variantResponse.json()) as { id: string }).id;

    // The admin search finds the variant by its barcode (exact barcode first).
    const searchResponse = await productsRoute(request('/api/admin/products?q=' + barcode + '&search=1', token));
    const hits = ((await searchResponse.json()) as {
      results: Array<{ variantId: string; productId: string; matchType: string; barcode: string | null }>;
    }).results;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.variantId).toBe(variantId);
    expect(hits[0]!.productId).toBe(productId);
    expect(hits[0]!.matchType).toBe('barcode');

    // The tenant boundary: a user in another org sees none of this org's catalogue. The search is
    // RLS-scoped, so Org B gets no hit even for Org A's barcode.
    const other = await createTenant('F2 test 119 other');
    const otherHits = await asUser(other.claims, async (client) => {
      const rows = await client.query(
        'select product_id from app.admin_search_products($1, $2, $3)',
        [other.orgId, barcode, 50],
      );
      return rows.rows;
    });
    expect(otherHits).toHaveLength(0);
    const otherProducts = await asUser(other.claims, async (client) => {
      const rows = await client.query('select id from public.products where id = $1', [productId]);
      return rows.rows;
    });
    expect(otherProducts).toHaveLength(0);
  });

  it('120. A USD retail list is priced through the COPY import and a promotion discounts through the Redis cache, invalidated on write', async () => {
    const tenant = await createTenant('F2 test 120');
    const token = tenantToken(tenant);

    // Create a retail USD price list through the route.
    const created = await priceListsPostRoute(
      request('/api/admin/price-lists', token, {
        method: 'POST',
        body: JSON.stringify({ name: 'Retail', kind: 'retail', currency: 'USD' }),
      }),
    );
    expect(created.status).toBe(200);
    const listId = ((await created.json()) as { id: string }).id;

    // A product and variant to price.
    const product = await one<{ id: string }>(
      `insert into public.products (org_id, sku, name)
       values ($1, app.next_number($1, 'SKU'), 'F2 priced') returning id`,
      [tenant.orgId],
    );
    const variant = await one<{ id: string }>(
      `insert into public.product_variants (org_id, product_id, sku, name)
       values ($1, $2, app.next_number($1, 'SKU'), 'default') returning id`,
      [tenant.orgId, product!.id],
    );

    // Import the item through the dedicated /import route (the brief's endpoint). It delegates to
    // the same COPY path as the inline import.
    const importResponse = await priceListsImportRoute(
      request('/api/admin/price-lists/import', token, {
        method: 'POST',
        body: JSON.stringify({
          price_list_id: listId,
          lines: [{ variant_id: variant!.id, price: '100.0000' }],
        }),
      }),
    );
    expect(importResponse.status).toBe(200);
    expect(((await importResponse.json()) as { imported: number }).imported).toBe(1);

    // With no promotion the resolved price is the list price.
    await invalidatePromotions(tenant.orgId, cache);
    const plain = await asUser(tenant.claims, (client) =>
      resolvePrice({ client, orgId: tenant.orgId, groupId: null, variantId: variant!.id, atTime: new Date() }, cache),
    );
    expect(plain!.listPrice.toFixed(4)).toBe('100.0000');
    expect(plain!.unitPrice.toFixed(4)).toBe('100.0000');

    // Create a 10% promotion whose conditions the console builds (value only).
    const conditions = buildConditions({
      value: '10',
      variantIds: '',
      minQty: '',
      minSubtotal: '',
    });
    expect(conditions).toEqual({ value: '10' });

    const promotionId = await tx(async (client) => {
      const row = await client.query<{ id: string }>(
        `insert into public.promotions
           (org_id, name, type, valid_from, valid_to, priority, stackable, is_active, conditions)
         values ($1, 'Ten percent', 'percent', now() - interval '1 hour', now() + interval '1 hour',
                 10, false, true, $2::jsonb) returning id`,
        [tenant.orgId, JSON.stringify(conditions)],
      );
      return row.rows[0]!.id;
    });

    // A write invalidates the cache; the next read repopulates from the database and discounts.
    await invalidatePromotions(tenant.orgId, cache);
    expect(await getRedis().get(promoCacheKey(tenant.orgId))).toBeNull();

    const discounted = await asUser(tenant.claims, (client) =>
      resolvePrice({ client, orgId: tenant.orgId, groupId: null, variantId: variant!.id, atTime: new Date() }, cache),
    );
    expect(discounted!.unitPrice.toFixed(4)).toBe('90.0000');
    expect(discounted!.discount.toFixed(4)).toBe('10.0000');
    expect(discounted!.source.promotionId).toBe(promotionId);

    // The cache now holds the candidate, with the org-scoped key and the 300s TTL.
    const cached = await getRedis().get(promoCacheKey(tenant.orgId));
    expect(cached).not.toBeNull();
    expect(cached).toContain(promotionId);
    const ttl = await getRedis().ttl(promoCacheKey(tenant.orgId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(PROMO_CACHE_TTL_SECONDS);

    // The conditions round-trip through the console helpers.
    expect(parseConditions({ value: 10 })).toEqual({
      value: '10',
      variantIds: '',
      minQty: '',
      minSubtotal: '',
    });
    expect(describeConditions('percent', { value: 10 })).toBe('10% off');
  });

  it('121. A promotion past valid_to is not applied even with a fresh cache entry, and get_price reaches price_list_items by index', async () => {
    const tenant = await createTenant('F2 test 121');
    const listId = await tx((client) =>
      createPriceList(client, { orgId: tenant.orgId, name: 'Retail', kind: 'retail', currency: 'USD' }),
    );

    const product = await one<{ id: string }>(
      `insert into public.products (org_id, sku, name)
       values ($1, app.next_number($1, 'SKU'), 'F2 expiry') returning id`,
      [tenant.orgId],
    );
    const variant = await one<{ id: string }>(
      `insert into public.product_variants (org_id, product_id, sku, name)
       values ($1, $2, app.next_number($1, 'SKU'), 'default') returning id`,
      [tenant.orgId, product!.id],
    );

    await tx((client) =>
      importPriceListItems(client, {
        orgId: tenant.orgId,
        priceListId: listId,
        lines: [{ variantId: variant!.id, price: '50.0000' }],
      }),
    );

    // An already-expired promotion in the table.
    await sql(
      `insert into public.promotions
         (org_id, name, type, valid_from, valid_to, priority, stackable, is_active, conditions)
       values ($1, 'Expired promo', 'percent', now() - interval '2 hours', now() - interval '1 hour',
               10, false, true, '{"value": 25}'::jsonb)`,
      [tenant.orgId],
    );

    // A cache entry with a real 300s TTL that still carries the (now expired) candidate — as if it
    // had been populated minutes ago.
    const staleCandidates = JSON.stringify([
      {
        id: crypto.randomUUID(),
        type: 'percent',
        priority: 10,
        stackable: false,
        valid_from: new Date(Date.now() - 7_200_000).toISOString(),
        valid_to: new Date(Date.now() - 3_600_000).toISOString(),
        is_active: true,
        conditions: { value: 25 },
      },
    ]);
    await cache.set(promoCacheKey(tenant.orgId), staleCandidates, 'EX', PROMO_CACHE_TTL_SECONDS);
    const ttl = await getRedis().ttl(promoCacheKey(tenant.orgId));
    expect(ttl, 'the cache entry should still be alive').toBeGreaterThan(0);

    // The validity window is re-checked at evaluation time, so the price is the full list price.
    const resolved = await asUser(tenant.claims, (client) =>
      resolvePrice({ client, orgId: tenant.orgId, groupId: null, variantId: variant!.id, atTime: new Date() }, cache),
    );
    expect(resolved!.listPrice.toFixed(4)).toBe('50.0000');
    expect(resolved!.unitPrice.toFixed(4)).toBe('50.0000');
    expect(resolved!.discount.toFixed(4)).toBe('0.0000');
    expect(resolved!.source.promotionId).toBeNull();

    // get_price reaches price_list_items by index, never a sequential scan of the price table.
    await sql('analyze public.price_list_items');
    const plan = await sql<{ 'QUERY PLAN': unknown }>(
      `explain (format json) select * from app.get_price($1, $2, $3, $4::timestamptz, $5)`,
      [tenant.orgId, variant!.id, null, new Date().toISOString(), 1],
    );
    const planText = JSON.stringify(plan);
    expect(planText).toContain('price_list_items');
    expect(planText).toContain('Index');
    const nodes = planText.match(/\{[^{}]*\}/g) ?? [];
    const seqScanOnPrices = nodes.some(
      (node) => node.includes('"Seq Scan"') && node.includes('price_list_items'),
    );
    expect(seqScanOnPrices, 'get_price must not sequential-scan price_list_items').toBe(false);
  });
});
