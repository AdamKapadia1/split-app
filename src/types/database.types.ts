/**
 * Lifecycle of a receipt from capture through settlement.
 * Stored as a Postgres enum and mirrored here as a closed string union.
 */
export type ReceiptStatus = 'scanning' | 'open' | 'locked' | 'unsplit' | 'split' | 'settled';

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
 * One person's claim on a single receipt line.
 * `id` is assigned by Postgres and is the key used to remove the claim.
 */
export interface Split {
  /** Immutable primary key assigned by Postgres. */
  readonly id: string;
  /** Receipt this claim belongs to. */
  receipt_id: string;
  /** Line item being claimed. */
  item_id: string;
  /** Profile id of the person who claimed the line. */
  user_id: string;
}

/**
 * One person's saved share of a receipt, stored in integer pence.
 * Replaced as a set by `save_receipt_splits`.
 */
export interface ReceiptSplit {
  /** Immutable primary key assigned by Postgres. */
  readonly id: string;
  /** Receipt this share belongs to. */
  receipt_id: string;
  /** Profile id of the person who owes this share. */
  user_id: string;
  /** Amount owed, in integer minor units (pence). */
  amount_minor: number;
  /** Line items included in this person's share. */
  item_ids: string[];
  /** Timestamp of the last time this share was saved. */
  updated_at: string;
}

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
  /** Profile id of the person who paid the bill. Null until someone is chosen. */
  paid_by?: string | null;
  /** Optional group this receipt belongs to. Null while it is still unassigned. */
  group_id: string | null;
  /** Cleaned business name from the logo, header, or footer. Null when none is visible. */
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
  /** Legacy capture reference. New photos use `image_path` in private storage. */
  image_url: string | null;
  /**
   * Private storage object key, `<user uuid>/<receipt uuid>.jpg`.
   * Null when the photo could not be uploaded. Never a signed URL.
   */
  image_path?: string | null;
  /** Where this receipt is in the scanning-to-settlement lifecycle. */
  status: ReceiptStatus;
  /**
   * When a member archived this receipt into Settlement History.
   * Null while it is active. This is a visual flag and does not change cash balances.
   */
  settled_at: string | null;
  /** Profile id of the member who archived this receipt. Null while it is active. */
  settled_by: string | null;
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

/**
 * How a settlement was recorded.
 * Stored as text with a check constraint and mirrored here as a closed string union.
 */
export type SettlementPaymentMethod = 'manual' | 'payment_link' | 'open_banking';

/**
 * One recorded payment between two members of a group, stored in integer pence.
 * Rows are append-only. A reversal sets `voided_at` and never deletes the ledger entry.
 */
export interface Settlement {
  /** Immutable primary key assigned by Postgres. */
  readonly id: string;
  /** Group whose balances this payment changes. */
  group_id: string;
  /** Profile id of the person who paid. */
  from_user_id: string;
  /** Profile id of the person who received the payment. */
  to_user_id: string;
  /** Amount paid, in integer minor units (pence). Always greater than zero. */
  amount_minor: number;
  /** ISO 4217 currency code. Settlements are recorded in GBP. */
  currency: string;
  /** Client key that makes a repeated submit return the original row. */
  idempotency_key: string;
  /** How the payment was made. */
  payment_method: SettlementPaymentMethod;
  /** Optional note shown with the ledger entry. */
  note: string | null;
  /** When the payment was reversed. Null while it still counts toward balances. */
  voided_at: string | null;
  /** Profile id of the person who reversed the payment. */
  voided_by: string | null;
  /** Profile id of the signed-in member who recorded the payment. */
  created_by: string;
  /** Immutable timestamp recorded when the row was inserted. */
  readonly created_at: string;
}

/** Arguments for the `record_settlement` RPC. Amounts are integer pence. */
export interface RecordSettlementArgs {
  p_group_id: string;
  p_from_user_id: string;
  p_to_user_id: string;
  p_amount_minor: number;
  p_idempotency_key: string;
  p_payment_method?: SettlementPaymentMethod;
  p_note?: string | null;
}

/** Arguments for the `void_settlement` RPC. */
export interface VoidSettlementArgs {
  p_settlement_id: string;
}

/** Arguments for the `set_receipt_settled` RPC. Archives or reopens a receipt without touching balances. */
export interface SetReceiptSettledArgs {
  p_receipt_id: string;
  p_settled: boolean;
}
