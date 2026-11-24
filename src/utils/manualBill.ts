/** Largest manual bill Velor will save: £50,000.00. */
export const MANUAL_BILL_MAX_PENCE = 5_000_000;

const MERCHANT_MAX = 80;
const ITEM_NAME_MAX = 80;

export type ManualLineInput = {
  name: string;
  amountInput: string;
};

export type ManualBillInput = {
  merchantName: string;
  totalInput: string;
  items?: readonly ManualLineInput[];
};

export type ManualItemError = {
  name?: string;
  amount?: string;
};

export type ManualBillErrors = {
  merchantName?: string;
  total?: string;
  items?: ManualItemError[];
  itemsTotal?: string;
};

export type ManualLine = {
  name: string;
  amountPence: number;
};

export type ValidatedManualBill = {
  merchantName: string;
  totalPence: number;
  items: ManualLine[];
};

/**
 * Parses a GBP amount into integer pence.
 * Accepts a leading £, thousands commas, and whitespace. One or two decimal
 * places only. Zero, negatives, and amounts above £50,000 are rejected.
 */
export function parseGBPToPence(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/[£,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(stripped)) return null;

  const dot = stripped.indexOf('.');
  const whole = dot === -1 ? stripped : stripped.slice(0, dot);
  const fraction = dot === -1 ? '' : stripped.slice(dot + 1);
  if (whole.length > 7) return null;

  const pounds = Number(whole);
  const cents = Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(pounds) || !Number.isSafeInteger(cents)) return null;

  const pence = pounds * 100 + cents;
  if (!Number.isSafeInteger(pence) || pence <= 0 || pence > MANUAL_BILL_MAX_PENCE) return null;
  return pence;
}

export function validateManualBill(input: ManualBillInput): {
  ok: boolean;
  errors: ManualBillErrors;
  bill: ValidatedManualBill | null;
} {
  const errors: ManualBillErrors = {};
  const merchantName = typeof input.merchantName === 'string' ? input.merchantName.trim() : '';
  if (!merchantName) {
    errors.merchantName = 'Enter a merchant or description.';
  } else if (merchantName.length > MERCHANT_MAX) {
    errors.merchantName = 'Keep this under 80 characters.';
  }

  const totalPence = typeof input.totalInput === 'string' ? parseGBPToPence(input.totalInput) : null;
  if (totalPence === null) {
    errors.total = 'Enter an amount from £0.01 to £50,000.';
  }

  const source = Array.isArray(input.items) ? input.items : [];
  const itemErrors: ManualItemError[] = [];
  const items: ManualLine[] = [];
  let itemsInvalid = false;

  for (const row of source) {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    const amountInput = typeof row?.amountInput === 'string' ? row.amountInput : '';
    if (!name && amountInput.trim().length === 0) {
      itemErrors.push({});
      continue;
    }

    const rowError: ManualItemError = {};
    if (!name) rowError.name = 'Name this item.';
    else if (name.length > ITEM_NAME_MAX) rowError.name = 'Keep this under 80 characters.';

    const amountPence = parseGBPToPence(amountInput);
    if (amountPence === null) rowError.amount = 'Enter a valid amount.';

    itemErrors.push(rowError);
    if (rowError.name || rowError.amount || amountPence === null) {
      itemsInvalid = true;
      continue;
    }
    items.push({ name, amountPence });
  }

  if (itemsInvalid) errors.items = itemErrors;

  if (!itemsInvalid && totalPence !== null && items.length > 0) {
    const sum = items.reduce((total, item) => total + item.amountPence, 0);
    if (sum > totalPence) errors.itemsTotal = 'Items add up to more than the total.';
  }

  if (errors.merchantName || errors.total || errors.items || errors.itemsTotal || totalPence === null) {
    return { ok: false, errors, bill: null };
  }

  return {
    ok: true,
    errors,
    bill: { merchantName, totalPence, items },
  };
}

/** Line items for the split screen. A lump sum becomes one line for the whole bill. */
export function manualBillLineItems(bill: ValidatedManualBill): ManualLine[] {
  if (bill.items.length > 0) return bill.items;
  return [{ name: bill.merchantName, amountPence: bill.totalPence }];
}

/** Integer subtotal, tax, and total. Tax is whatever the lines do not already cover. */
export function manualBillTotals(bill: ValidatedManualBill): {
  subtotalPence: number;
  taxPence: number;
  totalPence: number;
} {
  const subtotalPence = manualBillLineItems(bill).reduce((sum, line) => sum + line.amountPence, 0);
  return {
    subtotalPence,
    taxPence: Math.max(0, bill.totalPence - subtotalPence),
    totalPence: bill.totalPence,
  };
}

/**
 * Decimal pounds for a numeric(10,2) column, built from integer pence
 * so the value round-trips through `Math.round(pounds * 100)`.
 */
export function penceToPounds(pence: number): number {
  if (!Number.isSafeInteger(pence)) {
    throw new Error('Enter a valid amount.');
  }
  const negative = pence < 0;
  const abs = Math.abs(pence);
  const major = Number(`${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`);
  return negative ? -major : major;
}
