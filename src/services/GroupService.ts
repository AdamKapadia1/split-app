import type { PostgrestError } from '@supabase/supabase-js';
import type { CountryCode } from 'libphonenumber-js';

import { supabase } from '@/lib/supabase';
import { toE164 } from '@/utils/phone';
import {
  deriveGroupLedgerStatus,
  type GroupLedgerReceiptInput,
  type GroupLedgerStatus,
  type SettlementSplitInput,
  type WatermarkSettlementInput,
} from '@/utils/settlements';

export type GroupMemberProfile = {
  userId: string;
  email: string;
  phone: string | null;
  fullName: string;
  avatarUrl: string | null;
  paymentLink: string | null;
  role: 'owner' | 'member';
  joinedAt: string;
};

export type GroupMemberPreview = {
  id: string;
  display_name: string;
};

export type GroupBalanceSummary = {
  id: string;
  memberPreviews: GroupMemberPreview[];
  memberCount: number;
  /** Receipts linked to this group. Mirrors `status.receiptCount`. */
  receiptCount: number;
  userNetBalanceMinor: number;
  /** Sole settled/empty/open classification for this group. */
  status: GroupLedgerStatus;
};

export type AccountProfile = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  paymentLink: string | null;
};

export type GroupServiceCode = 'INVALID_PHONE' | 'NOT_FOUND' | 'ALREADY_MEMBER' | 'PERMISSION_DENIED' | 'NETWORK_ERROR';

type ProfileRow = {
  id?: string;
  email?: string | null;
  phone?: string | null;
  full_name?: string | null;
  fullName?: string | null;
  avatar_url?: string | null;
  avatarUrl?: string | null;
  payment_link?: string | null;
  paymentLink?: string | null;
};

type MemberRow = ProfileRow & {
  user_id?: string;
  userId?: string;
  role?: string | null;
  joined_at?: string | null;
  joinedAt?: string | null;
  profiles?: ProfileRow | ProfileRow[] | null;
  member?: unknown;
  profile?: unknown;
};

export class GroupServiceError extends Error {
  readonly code: GroupServiceCode;

  constructor(code: GroupServiceCode, message: string) {
    super(message);
    this.name = 'GroupServiceError';
    this.code = code;
  }
}

export function compareGroupMembers(a: GroupMemberProfile, b: GroupMemberProfile) {
  if (a.role !== b.role) return a.role === 'owner' ? -1 : 1;
  return a.joinedAt.localeCompare(b.joinedAt);
}

class GroupService {
  async getGroupMembers(groupId: string): Promise<GroupMemberProfile[]> {
    try {
      const client = requireClient();
      const { data, error } = await client
        .from('group_members')
        .select('user_id, role, joined_at, profiles(id, email, phone, full_name, avatar_url, payment_link)')
        .eq('group_id', groupId)
        .order('joined_at', { ascending: true });

      if (error) throw error;

      return ((data ?? []) as MemberRow[])
        .flatMap((row) => {
          const profile = firstProfile(row.profiles);
          const userId = row.user_id || profile?.id;
          if (!userId) return [];
          return [toMember(profile, userId, row.role, row.joined_at)];
        })
        .sort(compareGroupMembers);
    } catch (error) {
      throw asGroupError(error);
    }
  }

  async addMemberByPhone(groupId: string, rawPhone: string, country: CountryCode = 'GB'): Promise<GroupMemberProfile> {
    const e164 = toE164(rawPhone, country);
    if (!e164) {
      throw new GroupServiceError('INVALID_PHONE', 'Enter a valid phone number.');
    }

    try {
      const client = requireClient();
      const added = await client.rpc('add_group_member_by_phone', {
        p_group_id: groupId,
        p_phone: e164,
      });
      if (added.error) throw added.error;
      return memberFromRpc(added.data, e164);
    } catch (error) {
      throw asGroupError(error);
    }
  }

  async createPendingInvite(groupId: string, e164Phone: string): Promise<void> {
    try {
      const client = requireClient();
      const invited = await client.rpc('create_group_invite', {
        p_group_id: groupId,
        p_phone: e164Phone,
      });
      if (invited.error) throw invited.error;
    } catch (error) {
      throw asGroupError(error);
    }
  }

  async deleteGroup(groupId: string): Promise<void> {
    try {
      const client = requireClient();
      const deleted = await client.rpc('delete_group', { p_group_id: groupId });
      if (deleted.error) throw deleted.error;
    } catch (error) {
      throw asGroupError(error);
    }
    notifyGroupList();
  }

  async leaveGroup(groupId: string): Promise<void> {
    try {
      const client = requireClient();
      const left = await client.rpc('leave_group', { p_group_id: groupId });
      if (left.error) throw left.error;
    } catch (error) {
      throw asGroupError(error);
    }
    notifyGroupList();
  }

  async getAccountProfile(userId: string): Promise<AccountProfile | null> {
    try {
      const client = requireClient();
      const { data, error } = await client
        .from('profiles')
        .select('id, email, phone, full_name, payment_link')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;

      const row = data as ProfileRow;
      const email = text(row.email) || null;
      const fullName = text(row.full_name, row.fullName) || (email ? email.split('@')[0] : '') || 'Account';
      return {
        id: userId,
        displayName: fullName,
        email,
        phone: text(row.phone) || null,
        paymentLink: text(row.payment_link, row.paymentLink) || null,
      };
    } catch (error) {
      throw asGroupError(error);
    }
  }

  async updatePaymentLink(userId: string, paymentLink: string | null): Promise<void> {
    try {
      const client = requireClient();
      const next = paymentLink?.trim() ? paymentLink.trim() : null;
      const { error } = await client.from('profiles').update({ payment_link: next }).eq('id', userId);
      if (error) throw error;
    } catch (error) {
      throw asGroupError(error);
    }
  }

  /**
   * Loads member previews and the signed-in user's integer-pence net
   * for every group in one parallel batch. Does not change settlement math.
   */
  async getGroupBalanceSummaries(groupIds: string[], userId: string): Promise<GroupBalanceSummary[]> {
    const ids = [...new Set(groupIds.filter((id) => id.trim().length > 0 && !id.startsWith('temp-')))];
    if (ids.length === 0 || !userId) return [];

    try {
      const client = requireClient();
      const [membersResult, receiptsResult, settlementsResult, splitsResult] = await Promise.all([
        client
          .from('group_members')
          .select('group_id, user_id, role, joined_at, profiles(id, email, full_name)')
          .in('group_id', ids),
        client.from('receipts').select('id, group_id, paid_by, created_at, settled_at').in('group_id', ids),
        client.from('settlements').select('group_id, from_user_id, to_user_id, amount_minor, voided_at, created_at').in('group_id', ids),
        client
          .from('receipt_splits')
          .select('receipt_id, user_id, amount_minor, receipts!inner(group_id)')
          .in('receipts.group_id', ids),
      ]);

      if (membersResult.error) throw membersResult.error;
      if (receiptsResult.error) throw receiptsResult.error;
      if (settlementsResult.error) throw settlementsResult.error;

      const receipts = (receiptsResult.data ?? []) as unknown[];
      let splitRows = splitsResult.error ? null : ((splitsResult.data ?? []) as unknown[]);
      if (!splitRows) {
        const receiptIds = receipts.flatMap((row) => {
          const id = row && typeof row === 'object' ? text((row as { id?: unknown }).id) : '';
          return id ? [id] : [];
        });
        if (receiptIds.length === 0) {
          splitRows = [];
        } else {
          const fallback = await client.from('receipt_splits').select('receipt_id, user_id, amount_minor').in('receipt_id', receiptIds);
          if (fallback.error) throw fallback.error;
          splitRows = (fallback.data ?? []) as unknown[];
        }
      }

      return buildBalanceSummaries(ids, userId, (membersResult.data ?? []) as unknown[], receipts, (settlementsResult.data ?? []) as unknown[], splitRows);
    } catch (error) {
      throw asGroupError(error);
    }
  }

  async removeMember(groupId: string, userId: string): Promise<void> {
    try {
      const client = requireClient();
      const removed = await client.from('group_members').delete().eq('group_id', groupId).eq('user_id', userId).select('user_id');
      if (removed.error) throw removed.error;
      if (!removed.data || removed.data.length === 0) {
        throw new GroupServiceError('PERMISSION_DENIED', 'You do not have permission to remove this member.');
      }
    } catch (error) {
      throw asGroupError(error);
    }
  }
}

export const groupService = new GroupService();

type GroupListListener = () => void;

const groupListListeners = new Set<GroupListListener>();

/** Groups tab subscribes so a delete or leave removes the row immediately. */
export function subscribeGroupList(listener: GroupListListener) {
  groupListListeners.add(listener);
  return () => {
    groupListListeners.delete(listener);
  };
}

function notifyGroupList() {
  groupListListeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('[GroupService] group list listener failed', error);
    }
  });
}

function requireClient() {
  if (!supabase) {
    throw new GroupServiceError('NETWORK_ERROR', 'Supabase is not configured.');
  }
  return supabase;
}

function asGroupError(error: unknown): GroupServiceError {
  if (error instanceof GroupServiceError) return error;

  console.error('[GroupService]', error);

  const code = postgresCode(error);
  const message = postgresMessage(error);
  if (code === 'P0002') return new GroupServiceError('NOT_FOUND', 'No account found for that phone number.');
  if (code === '23505') return new GroupServiceError('ALREADY_MEMBER', 'Already in this group.');
  if (code === '22023') return new GroupServiceError('INVALID_PHONE', 'Enter a valid phone number.');
  if (code === '42501' || /forbidden|not authenticated/i.test(message)) {
    return new GroupServiceError('PERMISSION_DENIED', message || 'You do not have permission to change this group.');
  }
  if (/group not found|not a member/i.test(message)) {
    return new GroupServiceError('NOT_FOUND', message);
  }

  const detail = [message, code].filter((part) => part.length > 0).join(' ');
  return new GroupServiceError('NETWORK_ERROR', detail || 'Could not update group members.');
}

function postgresCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String((error as PostgrestError).code ?? '');
}

function postgresMessage(error: unknown) {
  if (!error || typeof error !== 'object' || !('message' in error)) return '';
  const message = (error as PostgrestError).message;
  return typeof message === 'string' ? message : '';
}

function firstProfile(value: unknown): ProfileRow | null {
  if (Array.isArray(value)) return firstProfile(value[0]);
  if (!value || typeof value !== 'object') return null;
  return value as ProfileRow;
}

function firstRecord(value: unknown): MemberRow | null {
  if (Array.isArray(value)) return firstRecord(value[0]);
  if (!value || typeof value !== 'object') return null;

  const record = value as MemberRow;
  if (text(record.userId, record.user_id, record.id)) return record;
  if (record.member && record.member !== record) {
    const member = firstRecord(record.member);
    if (member) return member;
  }
  if (record.profile && record.profile !== record) {
    const profile = firstRecord(record.profile);
    if (profile) return profile;
  }
  return record;
}

function memberFromRpc(data: unknown, phone: string): GroupMemberProfile {
  const row = firstRecord(data);
  if (!row) {
    throw new GroupServiceError('NETWORK_ERROR', 'Could not add this member.');
  }

  const profile = firstProfile(row.profiles) ?? row;
  const userId = text(row.userId, row.user_id, profile.id);
  if (!userId) {
    throw new GroupServiceError('NETWORK_ERROR', 'Could not add this member.');
  }

  return toMember(
    {
      email: profile.email,
      phone: text(profile.phone) || phone,
      full_name: profile.full_name,
      fullName: profile.fullName,
      avatar_url: profile.avatar_url,
      avatarUrl: profile.avatarUrl,
      payment_link: profile.payment_link,
      paymentLink: profile.paymentLink,
    },
    userId,
    text(row.role) || null,
    text(row.joinedAt, row.joined_at) || null,
  );
}

function toMember(
  profile: ProfileRow | null,
  userId: string,
  role: string | null | undefined,
  joinedAt: string | null | undefined,
): GroupMemberProfile {
  const email = text(profile?.email);
  const fullName = text(profile?.full_name, profile?.fullName) || email.split('@')[0] || 'Member';
  const avatarUrl = text(profile?.avatar_url, profile?.avatarUrl) || null;
  const paymentLink = text(profile?.payment_link, profile?.paymentLink) || null;

  return {
    userId,
    email,
    phone: text(profile?.phone) || null,
    fullName,
    avatarUrl,
    paymentLink,
    role: role === 'owner' ? 'owner' : 'member',
    joinedAt: joinedAt || new Date().toISOString(),
  };
}

type RankedSummaryMember = {
  userId: string;
  displayName: string;
  role: 'owner' | 'member';
  joinedAt: string;
};

function buildBalanceSummaries(
  groupIds: string[],
  viewerId: string,
  memberRows: unknown[],
  receiptRows: unknown[],
  settlementRows: unknown[],
  splitRows: unknown[],
): GroupBalanceSummary[] {
  const membersByGroup = new Map<string, RankedSummaryMember[]>();
  for (const raw of memberRows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as MemberRow & { group_id?: unknown };
    const groupId = text(row.group_id);
    const profile = firstProfile(row.profiles);
    const userId = text(row.user_id, profile?.id);
    if (!groupId || !userId) continue;
    const email = text(profile?.email);
    const bucket = membersByGroup.get(groupId) ?? [];
    bucket.push({
      userId,
      displayName: text(profile?.full_name, profile?.fullName) || email.split('@')[0] || 'Member',
      role: row.role === 'owner' ? 'owner' : 'member',
      joinedAt: text(row.joined_at, row.joinedAt) || '',
    });
    membersByGroup.set(groupId, bucket);
  }

  const receiptGroup = new Map<string, string>();
  const receiptsByGroup = new Map<string, GroupLedgerReceiptInput[]>();
  for (const raw of receiptRows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { id?: unknown; group_id?: unknown; paid_by?: unknown; created_at?: unknown; settled_at?: unknown };
    const id = text(row.id);
    const groupId = text(row.group_id);
    if (!id || !groupId) continue;
    receiptGroup.set(id, groupId);
    const bucket = receiptsByGroup.get(groupId) ?? [];
    bucket.push({
      id,
      paid_by: text(row.paid_by) || null,
      created_at: text(row.created_at),
      settled_at: text(row.settled_at) || null,
    });
    receiptsByGroup.set(groupId, bucket);
  }

  const settlementsByGroup = new Map<string, WatermarkSettlementInput[]>();
  for (const raw of settlementRows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { group_id?: unknown; from_user_id?: unknown; to_user_id?: unknown; amount_minor?: unknown; voided_at?: unknown; created_at?: unknown };
    const groupId = text(row.group_id);
    const fromUserId = text(row.from_user_id);
    const toUserId = text(row.to_user_id);
    const amountMinor = integerMinor(row.amount_minor);
    if (!groupId || !fromUserId || !toUserId || amountMinor === null) continue;
    const bucket = settlementsByGroup.get(groupId) ?? [];
    bucket.push({
      from_user_id: fromUserId,
      to_user_id: toUserId,
      amount_minor: amountMinor,
      voided_at: text(row.voided_at) || null,
      created_at: text(row.created_at),
    });
    settlementsByGroup.set(groupId, bucket);
  }

  const splitsByGroup = new Map<string, SettlementSplitInput[]>();
  for (const raw of splitRows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { receipt_id?: unknown; user_id?: unknown; amount_minor?: unknown };
    const receiptId = text(row.receipt_id);
    const splitUserId = text(row.user_id);
    const amountMinor = integerMinor(row.amount_minor);
    const groupId = receiptGroup.get(receiptId);
    if (!receiptId || !splitUserId || amountMinor === null || !groupId) continue;
    const bucket = splitsByGroup.get(groupId) ?? [];
    bucket.push({ receipt_id: receiptId, user_id: splitUserId, amount_minor: amountMinor });
    splitsByGroup.set(groupId, bucket);
  }

  return groupIds.map((groupId) => {
    const members = (membersByGroup.get(groupId) ?? []).sort(compareSummaryMembers);
    const groupReceipts = receiptsByGroup.get(groupId) ?? [];
    const status = ledgerStatusForGroup(
      groupId,
      groupReceipts,
      splitsByGroup.get(groupId) ?? [],
      settlementsByGroup.get(groupId) ?? [],
      members.map((member) => member.userId),
      viewerId,
    );

    return {
      id: groupId,
      memberPreviews: members.slice(0, 3).map((member) => ({ id: member.userId, display_name: member.displayName })),
      memberCount: members.length,
      receiptCount: status.receiptCount,
      userNetBalanceMinor: status.userNetBalanceMinor,
      status,
    };
  });
}

function ledgerStatusForGroup(
  groupId: string,
  receipts: GroupLedgerReceiptInput[],
  splits: SettlementSplitInput[],
  settlements: WatermarkSettlementInput[],
  memberIds: string[],
  viewerId: string,
): GroupLedgerStatus {
  try {
    return deriveGroupLedgerStatus({
      receipts,
      splits,
      settlements,
      memberIds,
      currentUserId: viewerId,
    });
  } catch (error) {
    console.error('[GroupService] group balance', groupId, error);
    const receiptCount = receipts.length;
    return {
      kind: receiptCount === 0 ? 'empty' : 'needs_split',
      receiptCount,
      activeReceiptCount: receiptCount,
      settledReceiptCount: 0,
      unsplitActiveCount: receiptCount,
      transferCount: 0,
      userNetBalanceMinor: 0,
    };
  }
}

function compareSummaryMembers(a: RankedSummaryMember, b: RankedSummaryMember) {
  if (a.role !== b.role) return a.role === 'owner' ? -1 : 1;
  return a.joinedAt.localeCompare(b.joinedAt);
}

function integerMinor(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function text(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
