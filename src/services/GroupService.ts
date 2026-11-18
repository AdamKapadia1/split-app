import type { PostgrestError } from '@supabase/supabase-js';
import type { CountryCode } from 'libphonenumber-js';

import { supabase } from '@/lib/supabase';
import { toE164 } from '@/utils/phone';

export type GroupMemberProfile = {
  userId: string;
  email: string;
  phone: string | null;
  fullName: string;
  avatarUrl: string | null;
  role: 'owner' | 'member';
  joinedAt: string;
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
        .select('user_id, role, joined_at, profiles(id, email, phone, full_name, avatar_url)')
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

function requireClient() {
  if (!supabase) {
    throw new GroupServiceError('NETWORK_ERROR', 'Supabase is not configured.');
  }
  return supabase;
}

function asGroupError(error: unknown): GroupServiceError {
  if (error instanceof GroupServiceError) return error;

  const code = postgresCode(error);
  if (code === 'P0002') return new GroupServiceError('NOT_FOUND', 'No account found for that phone number.');
  if (code === '23505') return new GroupServiceError('ALREADY_MEMBER', 'Already in this group.');
  if (code === '22023') return new GroupServiceError('INVALID_PHONE', 'Enter a valid phone number.');
  if (code === '42501') return new GroupServiceError('PERMISSION_DENIED', 'You do not have permission to change this group.');
  return new GroupServiceError('NETWORK_ERROR', 'Could not update group members.');
}

function postgresCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String((error as PostgrestError).code ?? '');
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

  return {
    userId,
    email,
    phone: text(profile?.phone) || null,
    fullName,
    avatarUrl,
    role: role === 'owner' ? 'owner' : 'member',
    joinedAt: joinedAt || new Date().toISOString(),
  };
}

function text(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
