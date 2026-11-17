import { ApiError, withAuth } from '../../../_lib';
import { assertSameOrg, requireOrg, withWriteErrors } from '../../_shared';
import { importPriceListItems } from '@/verticals/admin';

/**
 * POST /api/admin/price-lists/import — import a list's items with COPY.
 *
 * This is the endpoint the brief names. It delegates to the same `importPriceListItems` COPY path
 * that the `action:'import'` branch of `POST /api/admin/price-lists` uses, so there is one
 * implementation of the import, not two. The browser sends the parsed (variant_id, price) lines;
 * the server streams them into a staging table and merges once with a single
 * INSERT ... ON CONFLICT, never one round trip per row.
 */

interface ImportBody {
  org_id?: string;
  price_list_id?: string;
  lines?: Array<{ variant_id: string; price: string }>;
}

export async function POST(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const orgId = requireOrg(claims);
    const body = (await request.json()) as ImportBody;
    assertSameOrg(claims, body.org_id);

    if (!body.price_list_id) throw new ApiError(422, 'price_list_id is required');
    const priceListId = body.price_list_id;
    const lines = (body.lines ?? []).map((line) => ({
      variantId: line.variant_id,
      price: line.price,
    }));

    const imported = await withWriteErrors(() =>
      importPriceListItems(client, { orgId, priceListId, lines }),
    );
    return { price_list_id: priceListId, imported };
  });
}
