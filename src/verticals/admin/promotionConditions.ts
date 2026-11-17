import type { PromotionType } from './types';

/**
 * The promotion `conditions` jsonb, as the console edits it.
 *
 * `app.apply_promotions` recognises four keys, and only these four:
 *   value        numeric  percent: the percentage off; fixed: the amount off
 *   variant_ids  uuid[]   the promotion applies to these variants only
 *   min_qty      numeric  minimum line quantity
 *   min_subtotal numeric  minimum line subtotal
 *
 * The console keeps the raw text the operator typed and only converts on save, so an empty box
 * means "no condition" rather than 0. Building the object here (not in the page) keeps the wire
 * shape in one place, and a test can assert it without rendering the page.
 */
export interface PromotionConditionInput {
  /** The discount value: a percent for `percent`, an amount for `fixed`. Ignored by `bogo`. */
  value: string;
  /** Comma- or whitespace-separated variant ids. Empty means "every variant". */
  variantIds: string;
  minQty: string;
  minSubtotal: string;
}

export const EMPTY_PROMOTION_CONDITIONS: PromotionConditionInput = {
  value: '',
  variantIds: '',
  minQty: '',
  minSubtotal: '',
};

function trimmed(value: string): string | null {
  const text = value.trim();
  return text === '' ? null : text;
}

/** Split a free-text variant id list on commas and whitespace, dropping blanks and duplicates. */
export function parseVariantIds(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\s,]+/)) {
    const id = part.trim();
    if (id !== '') seen.add(id);
  }
  return [...seen];
}

/**
 * Build the conditions object the server stores. Only non-empty boxes are included, so an untouched
 * form sends `{}` (every variant, any quantity) rather than a set of zeroes.
 */
export function buildConditions(input: PromotionConditionInput): Record<string, unknown> {
  const conditions: Record<string, unknown> = {};
  const value = trimmed(input.value);
  if (value !== null) conditions['value'] = value;
  const variantIds = parseVariantIds(input.variantIds);
  if (variantIds.length > 0) conditions['variant_ids'] = variantIds;
  const minQty = trimmed(input.minQty);
  if (minQty !== null) conditions['min_qty'] = minQty;
  const minSubtotal = trimmed(input.minSubtotal);
  if (minSubtotal !== null) conditions['min_subtotal'] = minSubtotal;
  return conditions;
}

function asText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** Read a stored conditions object back into the form. */
export function parseConditions(conditions: Record<string, unknown> | null | undefined): PromotionConditionInput {
  const source = conditions ?? {};
  const rawVariantIds = source['variant_ids'];
  const variantIds = Array.isArray(rawVariantIds)
    ? rawVariantIds.map((value) => String(value)).join(', ')
    : asText(rawVariantIds);
  return {
    value: asText(source['value']),
    variantIds,
    minQty: asText(source['min_qty']),
    minSubtotal: asText(source['min_subtotal']),
  };
}

/** A one-line, human summary of a promotion's conditions for the list row. */
export function describeConditions(type: PromotionType, conditions: Record<string, unknown>): string {
  const parsed = parseConditions(conditions);
  const parts: string[] = [];
  if (parsed.value !== '') {
    parts.push(type === 'percent' ? `${parsed.value}% off` : `${parsed.value} off`);
  } else if (type === 'bogo') {
    parts.push('buy one get one');
  }
  if (parsed.variantIds !== '') {
    const count = parseVariantIds(parsed.variantIds).length;
    parts.push(`${count} variant${count === 1 ? '' : 's'}`);
  }
  if (parsed.minQty !== '') parts.push(`min qty ${parsed.minQty}`);
  if (parsed.minSubtotal !== '') parts.push(`min subtotal ${parsed.minSubtotal}`);
  return parts.length === 0 ? 'any item' : parts.join(', ');
}
