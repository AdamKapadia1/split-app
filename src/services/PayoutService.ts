import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import {
  normalizeAccountNumber,
  normalizeSortCode,
  sanitizePaymentHandle,
  type PaymentLinkProvider,
} from '@/utils/paymentLinks';

export type PayoutMethodKind = PaymentLinkProvider | 'bank';

export type PayoutMethod = {
  userId: string;
  preferredMethod: PayoutMethodKind | null;
  monzoHandle: string | null;
  revolutHandle: string | null;
  paypalHandle: string | null;
  bankAccountName: string | null;
  bankSortCode: string | null;
  bankAccountNumber: string | null;
  updatedAt: string;
};

export type PayoutMethodInput = {
  preferredMethod: PayoutMethodKind | null;
  monzoHandle?: string | null;
  revolutHandle?: string | null;
  paypalHandle?: string | null;
  bankAccountName?: string | null;
  bankSortCode?: string | null;
  bankAccountNumber?: string | null;
};

export type PayoutServiceCode = 'NOT_CONFIGURED' | 'FETCH_FAILED' | 'SAVE_FAILED' | 'VALIDATION_ERROR';

export class PayoutServiceError extends Error {
  readonly code: PayoutServiceCode;

  constructor(code: PayoutServiceCode, message: string) {
    super(message);
    this.name = 'PayoutServiceError';
    this.code = code;
  }
}

const COLUMNS = 'user_id, preferred_method, monzo_handle, revolut_handle, paypal_handle, bank_account_name, bank_sort_code, bank_account_number, updated_at';

class PayoutService {
  async getMyPayoutMethod(): Promise<PayoutMethod | null> {
    try {
      const client = requireClient();
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw sessionError;
      const userId = sessionData.session?.user.id;
      if (!userId) return null;

      const { data, error } = await client.from('user_payout_methods').select(COLUMNS).eq('user_id', userId).maybeSingle();
      if (error) throw error;
      return data ? parsePayoutMethod(data) : null;
    } catch (error) {
      throw asPayoutError(error, 'FETCH_FAILED', 'Could not load payout details.');
    }
  }

  async upsertMyPayoutMethod(input: PayoutMethodInput): Promise<PayoutMethod> {
    const payload = validatePayoutInput(input);
    try {
      const client = requireClient();
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw sessionError;
      const userId = sessionData.session?.user.id;
      if (!userId) throw new PayoutServiceError('SAVE_FAILED', 'Sign in before saving payout details.');

      const { data, error } = await client
        .from('user_payout_methods')
        .upsert({
          user_id: userId,
          preferred_method: payload.preferredMethod,
          monzo_handle: payload.monzoHandle,
          revolut_handle: payload.revolutHandle,
          paypal_handle: payload.paypalHandle,
          bank_account_name: payload.bankAccountName,
          bank_sort_code: payload.bankSortCode,
          bank_account_number: payload.bankAccountNumber,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })
        .select(COLUMNS)
        .single();
      if (error) throw error;
      return parsePayoutMethod(data);
    } catch (error) {
      throw asPayoutError(error, 'SAVE_FAILED', 'Could not save payout details.');
    }
  }

  async deleteMyPayoutMethod(): Promise<void> {
    try {
      const client = requireClient();
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw sessionError;
      const userId = sessionData.session?.user.id;
      if (!userId) throw new PayoutServiceError('SAVE_FAILED', 'Sign in before removing payout details.');

      const { error } = await client.from('user_payout_methods').delete().eq('user_id', userId);
      if (error) throw error;
    } catch (error) {
      throw asPayoutError(error, 'SAVE_FAILED', 'Could not remove payout details.');
    }
  }

  async getHostPayoutMethod(hostUserId: string): Promise<PayoutMethod | null> {
    const hostId = hostUserId.trim();
    if (!hostId) return null;
    try {
      const client = requireClient();
      const { data, error } = await client.from('user_payout_methods').select(COLUMNS).eq('user_id', hostId).maybeSingle();
      if (error) throw error;
      return data ? parsePayoutMethod(data) : null;
    } catch (error) {
      throw asPayoutError(error, 'FETCH_FAILED', 'Could not load payout details.');
    }
  }
}

export const payoutService = new PayoutService();

function validatePayoutInput(input: PayoutMethodInput): PayoutMethodInput {
  const monzoHandle = optionalHandle('monzo', input.monzoHandle);
  const revolutHandle = optionalHandle('revolut', input.revolutHandle);
  const paypalHandle = optionalHandle('paypal', input.paypalHandle);
  const bank = optionalBank(input.bankAccountName, input.bankSortCode, input.bankAccountNumber);
  const preferredMethod = input.preferredMethod;

  if (preferredMethod === 'monzo' && !monzoHandle) {
    throw new PayoutServiceError('VALIDATION_ERROR', 'Add a valid Monzo handle before choosing it.');
  }
  if (preferredMethod === 'revolut' && !revolutHandle) {
    throw new PayoutServiceError('VALIDATION_ERROR', 'Add a valid Revolut handle before choosing it.');
  }
  if (preferredMethod === 'paypal' && !paypalHandle) {
    throw new PayoutServiceError('VALIDATION_ERROR', 'Add a valid PayPal handle before choosing it.');
  }
  if (preferredMethod === 'bank' && !bank) {
    throw new PayoutServiceError('VALIDATION_ERROR', 'Add the account name, sort code, and account number together.');
  }

  return {
    preferredMethod,
    monzoHandle,
    revolutHandle,
    paypalHandle,
    bankAccountName: bank?.name ?? null,
    bankSortCode: bank?.sortCode ?? null,
    bankAccountNumber: bank?.accountNumber ?? null,
  };
}

function optionalHandle(provider: PaymentLinkProvider, raw: string | null | undefined): string | null {
  if (raw == null || raw.trim().length === 0) return null;
  const handle = sanitizePaymentHandle(provider, raw);
  if (!handle) {
    throw new PayoutServiceError('VALIDATION_ERROR', `The ${provider} handle is not valid.`);
  }
  return handle;
}

function optionalBank(nameRaw: string | null | undefined, sortRaw: string | null | undefined, accountRaw: string | null | undefined) {
  const name = nameRaw?.trim() ?? '';
  const sort = sortRaw?.trim() ?? '';
  const account = accountRaw?.trim() ?? '';
  if (name.length === 0 && sort.length === 0 && account.length === 0) return null;
  if (name.length < 2 || name.length > 70) {
    throw new PayoutServiceError('VALIDATION_ERROR', 'Account name must be 2 to 70 characters.');
  }
  const sortCode = normalizeSortCode(sort);
  const accountNumber = normalizeAccountNumber(account);
  if (!sortCode || !accountNumber) {
    throw new PayoutServiceError('VALIDATION_ERROR', 'Enter a 6-digit sort code and an 8-digit account number.');
  }
  return { name, sortCode, accountNumber };
}

function parsePayoutMethod(value: unknown): PayoutMethod {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!row || typeof row.user_id !== 'string') {
    throw new PayoutServiceError('FETCH_FAILED', 'Could not load payout details.');
  }
  return {
    userId: row.user_id,
    preferredMethod: readKind(row.preferred_method),
    monzoHandle: readText(row.monzo_handle),
    revolutHandle: readText(row.revolut_handle),
    paypalHandle: readText(row.paypal_handle),
    bankAccountName: readText(row.bank_account_name),
    bankSortCode: readText(row.bank_sort_code),
    bankAccountNumber: readText(row.bank_account_number),
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
  };
}

function readKind(value: unknown): PayoutMethodKind | null {
  if (value === 'monzo' || value === 'revolut' || value === 'paypal' || value === 'bank') return value;
  return null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireClient() {
  if (!supabase) {
    throw new PayoutServiceError('NOT_CONFIGURED', 'Supabase is not configured.');
  }
  return supabase;
}

function asPayoutError(error: unknown, code: PayoutServiceCode, fallback: string): PayoutServiceError {
  if (error instanceof PayoutServiceError) return error;
  const postgresCode = error && typeof error === 'object' && 'code' in error ? String((error as PostgrestError).code ?? '') : '';
  console.error(`[PayoutService] ${code}${postgresCode ? ` ${postgresCode}` : ''}`);
  return new PayoutServiceError(code, fallback);
}
