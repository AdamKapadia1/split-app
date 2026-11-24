/**
 * UK receipt lines after a scan.
 * Product rows stay in printed order. Footer labels such as SubTotal Net,
 * Standard VAT, service, and the amount due are metadata, not extra items.
 */

export type ScannedLine = {
  name: string;
  price: number;
};

export type ScannedTotals = {
  items: ScannedLine[];
  subtotal: number;
  tax: number;
  service: number;
  total: number;
};

export type ReceiptDiscrepancy = {
  itemsMinor: number;
  receiptTotalMinor: number;
  /** Receipt total minus the itemised sum. Positive means the lines are short. */
  differenceMinor: number;
  matches: boolean;
};

const PENCE_TOLERANCE = 1;

type SummaryKind = 'net' | 'tax' | 'service' | 'tip' | 'total' | 'payment';

export function reconcileScannedReceipt(input: {
  items: readonly ScannedLine[];
  subtotal?: number;
  tax?: number;
  service?: number;
  total?: number;
}): ScannedTotals {
  const products: ScannedLine[] = [];
  let netMinor: number | null = null;
  let taxMinor = toPence(input.tax ?? 0);
  let serviceMinor = toPence(input.service ?? 0);
  let totalMinor = toPence(input.total ?? 0);

  for (const line of input.items) {
    const name = line.name.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const priceMinor = toPence(line.price);
    const kind = summaryKind(name);
    if (kind === 'net') {
      netMinor = priceMinor;
      continue;
    }
    if (kind === 'tax') {
      if (priceMinor > 0) taxMinor = priceMinor;
      continue;
    }
    if (kind === 'service') {
      if (priceMinor > 0) serviceMinor = priceMinor;
      continue;
    }
    if (kind === 'tip') continue;
    if (kind === 'total') {
      if (priceMinor > 0) totalMinor = priceMinor;
      continue;
    }
    if (kind === 'payment') continue;
    products.push({ name, price: fromPence(priceMinor) });
  }

  const itemsMinor = products.reduce((sum, line) => sum + toPence(line.price), 0);
  const statedSubtotal = toPence(input.subtotal ?? 0);
  if (netMinor == null && statedSubtotal > 0 && statedSubtotal !== itemsMinor && statedSubtotal !== totalMinor) {
    netMinor = statedSubtotal;
  }

  const grossMinor = pickGrossTotal({
    itemsMinor,
    netMinor,
    taxMinor,
    serviceMinor,
    statedTotalMinor: totalMinor,
  });

  return {
    items: products,
    subtotal: fromPence(itemsMinor),
    tax: fromPence(taxMinor),
    service: fromPence(serviceMinor),
    total: fromPence(grossMinor),
  };
}

export function receiptDiscrepancy(itemsMinor: number, receiptTotalMinor: number): ReceiptDiscrepancy {
  const differenceMinor = Math.round(receiptTotalMinor) - Math.round(itemsMinor);
  return {
    itemsMinor: Math.round(itemsMinor),
    receiptTotalMinor: Math.round(receiptTotalMinor),
    differenceMinor,
    matches: Math.abs(differenceMinor) <= PENCE_TOLERANCE,
  };
}

/** Extras to spread when the member chooses the printed total. Itemised splits pass 0. */
export function splitExtrasMinor(itemsMinor: number, receiptTotalMinor: number, basis: 'items' | 'receipt') {
  if (basis === 'items') return 0;
  return Math.round(receiptTotalMinor) - Math.round(itemsMinor);
}

function pickGrossTotal(input: {
  itemsMinor: number;
  netMinor: number | null;
  taxMinor: number;
  serviceMinor: number;
  statedTotalMinor: number;
}) {
  const { itemsMinor, netMinor, taxMinor, serviceMinor, statedTotalMinor } = input;
  const netPlusTax = (netMinor ?? 0) + taxMinor + serviceMinor;

  if (taxMinor > 0 && statedTotalMinor === taxMinor && itemsMinor > 0 && itemsMinor !== taxMinor) {
    if (netMinor != null && netPlusTax > taxMinor) return netPlusTax;
    return itemsMinor;
  }

  if (netMinor != null && statedTotalMinor === netMinor && taxMinor > 0) {
    if (itemsMinor === netPlusTax || itemsMinor === netMinor) {
      return itemsMinor === netMinor ? netPlusTax : itemsMinor;
    }
    return netPlusTax;
  }

  if (statedTotalMinor > 0) return statedTotalMinor;
  if (netMinor != null && netPlusTax > itemsMinor) return netPlusTax;
  return itemsMinor;
}

function summaryKind(name: string): SummaryKind | null {
  if (/^\d+\s+\S/.test(name)) return null;
  if (/^(sub\s*-?\s*total|subtotal)(\s+net)?$/i.test(name) || /^net\s+sub\s*-?\s*total$/i.test(name)) return 'net';
  if (/^(vat|tax)(\s+standard|\s+\d+(\.\d+)?%?)?$/i.test(name) || /^standard(\s+vat|\s+rate|\s+\d+(\.\d+)?%?)?$/i.test(name) || /^vat\s+standard$/i.test(name)) {
    return 'tax';
  }
  if (/^(service(\s+charge)?|optional\s+service)$/i.test(name)) return 'service';
  if (/^(tip|gratuity)$/i.test(name)) return 'tip';
  if (/^(total|grand\s+total|amount\s+due|to\s+pay|balance\s+due|amount\s+paid)$/i.test(name)) return 'total';
  if (/^(cash|card|change|visa|mastercard|amex|contactless)$/i.test(name)) return 'payment';
  return null;
}

function toPence(pounds: number) {
  if (!Number.isFinite(pounds)) return 0;
  return Math.round(pounds * 100);
}

function fromPence(pence: number) {
  return Math.round(pence) / 100;
}
