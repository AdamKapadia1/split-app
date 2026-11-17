/**
 * Lifecycle of a receipt from capture through settlement.
 * Stored as a Postgres enum and mirrored here as a closed string union.
 */
export type ReceiptStatus = 'scanning' | 'open' | 'locked' | 'settled';

/**
 * Lifecycle of a payment collected against a split.
 * Stored as a Postgres enum and mirrored here as a closed string union.
 */
export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * How a line or a receipt is divided between people.
 * Stored as a Postgres enum and mirrored here as a closed string union.
 */
export type SplitType = 'equal' | 'exact' | 'percentage';

/**
 * A receipt owned by a host.
 *
 * Every financial field on this row is an exact 2-decimal money amount mapped to
 * Postgres `numeric(10,2)`: at most 8 digits before the decimal point and 2 digits
 * after it (maximum absolute value `99999999.99`). The database stores these as
 * decimal values, not IEEE-754 floats. Callers must round to cents before writing
 * so binary floating-point error never reaches the ledger.
 */
export interface Receipt {
  /** Immutable primary key assigned by Postgres. */
  readonly id: string;
  /** Profile id of the person who owns this receipt. */
  host_id: string;
  /** Optional group this receipt belongs to. Null while it is still unassigned. */
  group_id: string | null;
  /** Merchant printed on the receipt. Null until parsing fills it in. */
  merchant_name: string | null;
  /** ISO 4217 currency code, for example `GBP`. */
  currency_code: string;
  /**
   * Sum of line items before tax, service, and tip.
   * Exact 2-decimal amount mapped to Postgres `numeric(10,2)`.
   */
  subtotal: number;
  /**
   * Tax charged on the receipt.
   * Exact 2-decimal amount mapped to Postgres `numeric(10,2)`.
   */
  tax_amount: number;
  /**
   * Service charge, stored separately from tax.
   * Exact 2-decimal amount mapped to Postgres `numeric(10,2)`.
   */
  service_charge: number;
  /**
   * Tip added on top of the bill.
   * Exact 2-decimal amount mapped to Postgres `numeric(10,2)`.
   */
  tip_amount: number;
  /**
   * Amount due, equal to subtotal + tax + service charge + tip unless a line is tax exempt.
   * Exact 2-decimal amount mapped to Postgres `numeric(10,2)`.
   */
  total_amount: number;
  /** Storage path or public URL of the captured receipt image. */
  image_url: string | null;
  /** Where this receipt is in the scanning-to-settlement lifecycle. */
  status: ReceiptStatus;
  /** Immutable timestamp recorded when the row was inserted. */
  readonly created_at: string;
}

/**
 * One priced line on a receipt.
 *
 * `price` is an exact 2-decimal money amount mapped to Postgres `numeric(10,2)`:
 * at most 8 digits before the decimal point and 2 digits after it. It is stored
 * as a decimal in Postgres, not as a binary float. Round to cents before insert.
 */
export interface Item {
  /** Immutable primary key assigned by Postgres. */
  readonly id: string;
  /** Receipt this line belongs to. */
  receipt_id: string;
  /** Name as read from the receipt, before any display cleanup. */
  original_name: string;
  /** Optional name shown in the ledger. Null keeps `original_name`. */
  display_name: string | null;
  /**
   * Unit price of the line.
   * Exact 2-decimal amount mapped to Postgres `numeric(10,2)`.
   */
  price: number;
  /** How many of this line were purchased. */
  quantity: number;
  /** When true, this line is excluded from tax allocation. */
  is_tax_exempt: boolean;
}
