/**
 * Billing estimate (internal): calculated fee per payer for a tax year from the
 * admin fee schedule (Settings → Billing). Viewable by all staff.
 */
import { Router } from 'express';
import { z } from 'zod';
import { formatCents, zTaxYear } from '@vibe1099/shared';
import { getDb } from '@vibe1099/db';
import { h } from '../middleware/error.js';
import { requireStaff } from '../middleware/auth.js';
import { zPreparerFilter } from '../services/preparers.js';
import { buildBillingReport } from '../services/billing.js';

export const billingRouter = Router();
billingRouter.use(requireStaff());

const zQuery = z.object({ preparerId: zPreparerFilter });

billingRouter.get(
  '/:taxYear',
  h(async (req, res) => {
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const { preparerId } = zQuery.parse(req.query);
    res.json(await buildBillingReport(getDb(), req.staff!.firmId, taxYear, preparerId));
  }),
);

// CSV-quote, and neutralize spreadsheet formula injection (same rule as the audit export)
const csvCell = (v: unknown): string => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

/**
 * One line per payer per form type, plus a mailing line and a payer total line.
 * `amount` is gross (includes the percentage fee); the TOTAL line also carries
 * `net_before_pct_fee` — the figure to key into the billing system.
 */
billingRouter.get(
  '/:taxYear/export.csv',
  h(async (req, res) => {
    const taxYear = zTaxYear.parse(Number(req.params['taxYear']));
    const { preparerId } = zQuery.parse(req.query);
    const report = await buildBillingReport(getDb(), req.staff!.firmId, taxYear, preparerId);
    const header = [
      'payer', 'client_id', 'tax_year', 'line', 'forms', 'base_fee', 'per_form_rate', 'forms_fee',
      'corrections', 'correction_rate', 'corrections_fee', 'amount', 'pct_fee_rate', 'pct_fee', 'net_before_pct_fee',
    ].join(',');
    const pct = (bp: number) => `${(bp / 100).toFixed(2)}%`;
    const $ = (c: number) => formatCents(c);
    const lines: string[] = [];
    for (const r of report.rows) {
      const lead = [r.payerName, r.clientId ?? '', taxYear];
      for (const l of r.lines) {
        lines.push([...lead, l.formType, l.forms, $(l.baseFee), $(l.perFormRate), $(l.formsFee), l.corrections, $(l.correctionRate), $(l.correctionsFee), $(l.subtotal), '', '', ''].map(csvCell).join(','));
      }
      if (r.mailings > 0) {
        lines.push([...lead, 'Mailing', r.mailings, '', $(r.mailingRate), $(r.mailingFee), '', '', '', $(r.mailingFee), '', '', ''].map(csvCell).join(','));
      }
      lines.push([...lead, 'TOTAL', '', '', '', '', '', '', '', $(r.total), pct(r.feePercentBp), $(r.percentFee), $(r.net)].map(csvCell).join(','));
    }
    lines.push([ 'ALL PAYERS', '', taxYear, 'GRAND TOTAL', '', '', '', '', '', '', '', $(report.grandTotal), pct(report.schedule.feePercentBp ?? 0), $(report.grandTotal - report.grandNet), $(report.grandNet)].map(csvCell).join(','));
    res.setHeader('content-disposition', `attachment; filename="billing-${taxYear}.csv"`);
    res.type('text/csv').send([header, ...lines].join('\n'));
  }),
);
