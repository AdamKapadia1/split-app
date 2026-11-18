import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type GroupMemberProfile = {
  userId: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  role: 'owner' | 'member';
  joinedAt: string;
};

export type GroupServiceCode = 'NOT_FOUND' | 'ALREADY_MEMBER' | 'PERMISSION_DENIED' | 'INVALID_EMAIL' | 'NETWORK_ERROR';

type ProfileRow = {
  id?: string;
  email?: string | null;
  full_name?: string | null;
  avatar_url?: string | null;
};

type MemberRow = {
  user_id?: string;
  role?: string | null;
  joined_at?: string | null;
  profiles?: ProfileRow | ProfileRow[] | null;
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
        .select('user_id, role, joined_at, profiles(id, email, full_name, avatar_url)')
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

  async addMemberByEmail(groupId: string, email: string): Promise<GroupMemberProfile> {
    const lookup = email.trim().toLowerCase();
    if (!EMAIL.test(lookup)) {
      throw new GroupServiceError('INVALID_EMAIL', 'Enter a valid email address.');
    }

    try {
      const client = requireClient();
      const found = await client.rpc('find_profile_by_email', { lookup_email: lookup });
      if (found.error) throw found.error;

      const profile = firstProfile(found.data);
      if (!profile?.id) {
        throw new GroupServiceError('NOT_FOUND', 'No account found for that email.');
      }

      const inserted = await client
        .from('group_members')
        .insert({ group_id: groupId, user_id: profile.id, role: 'member' })
        .select('joined_at')
        .maybeSingle();

      if (inserted.error) throw inserted.error;

      const joinedAt =
        inserted.data && typeof inserted.data.joined_at === 'string' ? inserted.data.joined_at : new Date().toISOString();
      return toMember(profile, profile.id, 'member', joinedAt);
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
  if (code === '23505') return new GroupServiceError('ALREADY_MEMBER', 'Already in this group.');
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

function toMember(profile: ProfileRow | null, userId: string, role: string | null | undefined, joinedAt: string | null | undefined): GroupMemberProfile {
  const email = typeof profile?.email === 'string' ? profile.email.trim() : '';
  const fullName = typeof profile?.full_name === 'string' && profile.full_name.trim() ? profile.full_name.trim() : email.split('@')[0] || 'Member';
  const avatarUrl = typeof profile?.avatar_url === 'string' && profile.avatar_url.trim() ? profile.avatar_url : null;

  return {
    userId,
    email,
    fullName,
    avatarUrl,
    role: role === 'owner' ? 'owner' : 'member',
    joinedAt: joinedAt || new Date().toISOString(),
  };
}
