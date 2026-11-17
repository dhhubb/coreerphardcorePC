import Decimal from 'decimal.js';
import { formatDate, formatMoney, formatRate } from './receiptData';
import type { ZReportData } from './zReportData';

/**
 * The on-screen 58mm Z-report slip (F3).
 *
 * Exactly 58mm wide, because the browser print path relies on `@page { width: 58mm }` and a slip
 * wider than the paper is clipped. It shows the shop header, the Z-report number, the till and the
 * shift window, the totals by tender method and by currency, the VAT breakdown by rate, the sale and
 * void counts, the opening float and the footer.
 *
 * It prints through `window.print` (the same browser path the receipt uses): the Z-report is built in
 * the browser from an already-fetched immutable row, so there is no server call at print time.
 */

export const Z_REPORT_WIDTH_MM = 58;

const slipStyle: React.CSSProperties = {
  width: `${Z_REPORT_WIDTH_MM}mm`,
  maxWidth: `${Z_REPORT_WIDTH_MM}mm`,
  boxSizing: 'border-box',
  padding: '2mm 1.5mm',
  background: '#fff',
  color: '#000',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '9px',
  lineHeight: 1.35,
};

const center: React.CSSProperties = { textAlign: 'center' };
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '2mm' };
const rule: React.CSSProperties = { borderTop: '1px dashed #000', margin: '1.5mm 0' };

function MoneyRows({
  title,
  testId,
  values,
}: {
  title: string;
  testId: string;
  values: Record<string, Decimal>;
}) {
  const entries = Object.entries(values);
  return (
    <div data-testid={testId}>
      <div>{title}</div>
      {entries.length === 0 ? (
        <div style={row}>
          <span>—</span>
          <span>0.00</span>
        </div>
      ) : (
        entries.map(([key, amount]) => (
          <div key={key} style={row}>
            <span>{key}</span>
            <span>{formatMoney(amount)}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function ZReport58mm({ data }: { data: ZReportData }) {
  return (
    <article className="z-report-58" data-testid="z-report-58" style={slipStyle}>
      <header style={center}>
        <div data-testid="z-shop" style={{ fontWeight: 700, fontSize: '11px' }}>
          {data.shopName}
        </div>
        {data.shopAddressLines.map((line) => (
          <div key={line} data-testid="z-address">
            {line}
          </div>
        ))}
        <div data-testid="z-vat-number">{data.shopVatNumber}</div>
        <div style={{ fontWeight: 700, marginTop: '1mm' }} data-testid="z-title">
          Z-REPORT
        </div>
      </header>

      <div style={rule} />

      <div style={row}>
        <span>Z no</span>
        <span data-testid="z-no">{data.zNo}</span>
      </div>
      <div style={row}>
        <span>Branch</span>
        <span data-testid="z-branch">{data.branchName}</span>
      </div>
      <div style={row}>
        <span>Till</span>
        <span data-testid="z-till">{data.tillId}</span>
      </div>
      <div style={row}>
        <span>Opened</span>
        <span data-testid="z-opened">{formatDate(new Date(data.openedAt))}</span>
      </div>
      <div style={row}>
        <span>Closed</span>
        <span data-testid="z-closed">{formatDate(new Date(data.closedAt))}</span>
      </div>

      <div style={rule} />

      <div style={row}>
        <span>Sales</span>
        <span data-testid="z-sale-count">{data.saleCount}</span>
      </div>
      <div style={row}>
        <span>Voids</span>
        <span data-testid="z-void-count">{data.voidCount}</span>
      </div>
      <div style={row}>
        <span>Opening float</span>
        <span data-testid="z-opening-float">{formatMoney(data.openingFloat)}</span>
      </div>
      <div style={{ ...row, fontWeight: 700 }}>
        <span>Gross sales</span>
        <span data-testid="z-gross">{formatMoney(data.grossSales)}</span>
      </div>

      <div style={rule} />

      <MoneyRows title="By method" testId="z-by-method" values={data.byMethod} />
      <div style={rule} />
      <MoneyRows title="By currency" testId="z-by-currency" values={data.byCurrency} />

      <div style={rule} />

      <div data-testid="z-vat">
        <div>VAT</div>
        {Object.entries(data.vatByRate).map(([rate, amount]) => (
          <div key={rate} style={row}>
            <span>{formatRate(new Decimal(rate))}</span>
            <span>{formatMoney(amount)}</span>
          </div>
        ))}
        <div style={{ ...row, fontWeight: 700 }}>
          <span>VAT total</span>
          <span data-testid="z-tax-total">{formatMoney(data.taxTotal)}</span>
        </div>
      </div>

      <div style={rule} />

      <div style={center}>
        <div data-testid="z-footer">{data.footer}</div>
      </div>
    </article>
  );
}

