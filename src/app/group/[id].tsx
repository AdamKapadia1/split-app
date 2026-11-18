import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { AddMemberModal } from '@/components/AddMemberModal';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { compareGroupMembers, groupService, type GroupMemberProfile } from '@/services/GroupService';
import type { Receipt } from '@/types/database.types';
import { maskPhoneNumber } from '@/utils/phone';

type GroupReceipt = Receipt & {
  restaurant_name?: string | null;
};

const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AVATAR_COLORS = ['#38BDF8', '#C084FC', '#22D3EE', '#F472B6', '#A3E635', '#FBBF24', '#FB7185'];
const VISIBLE_AVATARS = 5;

function firstParam(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() ? raw.trim() : null;
}

function receiptName(receipt: GroupReceipt) {
  const merchant = receipt.merchant_name?.trim();
  if (merchant) return merchant;
  const restaurant = receipt.restaurant_name?.trim();
  if (restaurant) return restaurant;
  const date = new Date(receipt.created_at).toLocaleDateString('en-GB', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `Receipt from ${date}`;
}

function accentFor(userId: string) {
  let hash = 0;
  for (const char of userId) hash = (hash + char.charCodeAt(0)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash] ?? AVATAR_COLORS[0];
}

function initials(member: GroupMemberProfile) {
  const source = member.fullName.trim() || member.email;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function MemberAvatar({ member, size = 34 }: { member: GroupMemberProfile; size?: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: `${accentFor(member.userId)}22` }]}>
      <Text style={[styles.avatarText, { color: accentFor(member.userId), fontSize: size > 34 ? 14 : 12 }]}>{initials(member)}</Text>
    </View>
  );
}

export default function GroupLedgerScreen() {
  const router = useRouter();
  const { session } = useSupabaseSession();
  const { id: idParam } = useLocalSearchParams<{ id?: string | string[] }>();
  const groupId = firstParam(idParam);
  const isValidId = groupId !== null && GROUP_ID.test(groupId);
  const viewerId = session?.user.id ?? null;

  const [groupName, setGroupName] = useState('Group');
  const [createdBy, setCreatedBy] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<GroupReceipt[]>([]);
  const [members, setMembers] = useState<GroupMemberProfile[]>([]);
  const [isLoading, setIsLoading] = useState(isValidId);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [missing, setMissing] = useState(!isValidId);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const goBack = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  const loadLedger = useCallback(async (mode: 'load' | 'refresh' = 'load') => {
    if (!groupId || !GROUP_ID.test(groupId)) {
      setMissing(true);
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }

    if (!supabase) {
      setMissing(true);
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }

    if (mode === 'refresh') {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const [groupResult, receiptResult, memberList] = await Promise.all([
        supabase.from('groups').select('name, created_by').eq('id', groupId).maybeSingle(),
        supabase.from('receipts').select('*').eq('group_id', groupId).order('created_at', { ascending: false }),
        groupService.getGroupMembers(groupId).catch((error: unknown) => {
          console.error('Failed to load group members:', error);
          return [] as GroupMemberProfile[];
        }),
      ]);

      if (groupResult.error) throw groupResult.error;
      if (receiptResult.error) throw receiptResult.error;
      if (!groupResult.data) {
        setMissing(true);
        setReceipts([]);
        setMembers([]);
        return;
      }

      setMissing(false);
      setGroupName(typeof groupResult.data.name === 'string' && groupResult.data.name.trim() ? groupResult.data.name : 'Group');
      setCreatedBy(typeof groupResult.data.created_by === 'string' ? groupResult.data.created_by : null);
      setReceipts((receiptResult.data ?? []) as GroupReceipt[]);
      setMembers(memberList);
    } catch (error) {
      console.error('Failed to load group ledger:', error);
      setMissing(true);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [groupId]);

  useFocusEffect(
    useCallback(() => {
      void loadLedger();
    }, [loadLedger]),
  );

  const spent = receipts.reduce((sum, receipt) => sum + Number(receipt.total_amount || 0), 0);
  const viewerIsOwner = members.some((member) => member.userId === viewerId && member.role === 'owner') || (viewerId !== null && viewerId === createdBy);
  const visibleMembers = members.slice(0, VISIBLE_AVATARS);
  const overflow = Math.max(members.length - VISIBLE_AVATARS, 0);

  function addMember(member: GroupMemberProfile) {
    setMembers((current) => {
      if (current.some((existing) => existing.userId === member.userId)) return current;
      return [...current, member].sort(compareGroupMembers);
    });
  }

  function confirmRemove(member: GroupMemberProfile) {
    Alert.alert('Remove member', `Remove ${member.fullName} from this group?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void removeMember(member);
        },
      },
    ]);
  }

  async function removeMember(member: GroupMemberProfile) {
    if (!groupId) return;
    const previous = members;
    setMembers((current) => current.filter((existing) => existing.userId !== member.userId));

    try {
      await groupService.removeMember(groupId, member.userId);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error('Failed to remove member:', error);
      setMembers(previous);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not remove member', 'This member is still in the group.');
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={goBack}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={22} color="#38BDF8" />
          <Text style={styles.backLabel}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {missing ? 'Group' : groupName}
        </Text>
        {missing ? <Text style={styles.subtitle}>This group is not available.</Text> : null}
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#38BDF8" style={styles.loader} />
      ) : (
        <FlatList
          data={missing ? [] : receipts}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => {
                void loadLedger('refresh');
              }}
              tintColor="#38BDF8"
            />
          }
          ListHeaderComponent={
            missing ? undefined : (
              <View>
                <LinearGradient colors={['#1E293B', '#0F172A']} style={styles.hero}>
                  <Text style={styles.heroLabel}>TOTAL GROUP SPEND</Text>
                  <Text style={styles.heroAmount}>£{spent.toFixed(2)}</Text>
                </LinearGradient>

                <View style={styles.membersBar}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Group members"
                    style={styles.memberStackButton}
                    activeOpacity={0.8}
                    onPress={() => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setRosterOpen((open) => !open);
                    }}
                  >
                    <View style={styles.avatarStack}>
                      {visibleMembers.map((member, index) => (
                        <View key={member.userId} style={[styles.stackedAvatar, index > 0 && styles.stackedAvatarOverlap]}>
                          <MemberAvatar member={member} />
                        </View>
                      ))}
                      {overflow > 0 ? (
                        <View style={[styles.overflowBadge, styles.stackedAvatarOverlap]}>
                          <Text style={styles.overflowText}>+{overflow}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.memberCount}>{members.length} {members.length === 1 ? 'member' : 'members'}</Text>
                    <Ionicons name={rosterOpen ? 'chevron-up' : 'chevron-down'} size={16} color="#94A3B8" />
                  </TouchableOpacity>

                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Add member"
                    style={styles.addPill}
                    activeOpacity={0.8}
                    onPress={() => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setAddOpen(true);
                    }}
                  >
                    <Ionicons name="add" size={16} color="#38BDF8" />
                    <Text style={styles.addPillText}>Add</Text>
                  </TouchableOpacity>
                </View>

                {rosterOpen ? (
                  <View style={styles.roster}>
                    {members.length === 0 ? <Text style={styles.rosterEmpty}>No members yet.</Text> : null}
                    {members.map((member) => (
                      <View key={member.userId} style={styles.rosterRow}>
                        <MemberAvatar member={member} size={40} />
                        <View style={styles.rosterCopy}>
                          <View style={styles.rosterNameRow}>
                            <Text style={styles.rosterName} numberOfLines={1}>{member.fullName}</Text>
                            {member.role === 'owner' ? <Text style={styles.ownerBadge}>Owner</Text> : null}
                          </View>
                          <Text style={styles.rosterEmail} numberOfLines={1}>{member.phone ? maskPhoneNumber(member.phone) : member.email}</Text>
                        </View>
                        {viewerIsOwner && member.role !== 'owner' ? (
                          <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${member.fullName}`}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            onPress={() => confirmRemove(member)}
                          >
                            <Ionicons name="person-remove-outline" size={18} color="#94A3B8" />
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            )
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name={missing ? 'alert-circle-outline' : 'receipt-outline'} size={64} color="#334155" />
              <Text style={styles.emptyTitle}>{missing ? 'Group unavailable' : 'No receipts yet'}</Text>
              <Text style={styles.emptySubtitle}>
                {missing
                  ? 'This group could not be opened. Go back and choose a saved group.'
                  : 'Scan a receipt into this group and it will show up here.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.receiptCard}
              activeOpacity={0.7}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push({ pathname: '/receipt/[id]', params: { id: item.id } });
              }}
            >
              <View style={styles.receiptInfo}>
                <Text style={styles.receiptName} numberOfLines={1}>{receiptName(item)}</Text>
                <Text style={styles.dateText}>
                  {new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </Text>
              </View>
              <Text style={styles.totalText}>£{Number(item.total_amount || 0).toFixed(2)}</Text>
            </TouchableOpacity>
          )}
        />
      )}

      {groupId ? (
        <AddMemberModal
          visible={addOpen}
          groupId={groupId}
          groupName={groupName}
          onMemberAdded={addMember}
          onClose={() => setAddOpen(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B1120' },
  header: { paddingHorizontal: 24, paddingTop: 64, paddingBottom: 16 },
  backButton: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginLeft: -6, marginBottom: 12 },
  backLabel: { color: '#38BDF8', fontSize: 16, fontWeight: '600' },
  title: { fontSize: 32, fontWeight: '800', color: '#F8FAFC', letterSpacing: -0.5 },
  subtitle: { marginTop: 8, color: '#94A3B8', fontSize: 15, fontWeight: '500' },
  loader: { marginTop: 60 },
  listContent: { paddingHorizontal: 16, paddingBottom: 40, flexGrow: 1 },
  hero: {
    borderRadius: 24,
    padding: 20,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.2)',
  },
  heroLabel: { color: '#94A3B8', fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  heroAmount: { marginTop: 14, color: '#FFFFFF', fontSize: 36, fontWeight: '800', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  membersBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#151F32',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.14)',
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 12,
    gap: 12,
  },
  memberStackButton: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatarStack: { flexDirection: 'row', alignItems: 'center' },
  stackedAvatar: { borderWidth: 2, borderColor: '#0B1120', borderRadius: 999 },
  stackedAvatarOverlap: { marginLeft: -10 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: '800' },
  overflowBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: '#0B1120',
    backgroundColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  overflowText: { color: '#F8FAFC', fontSize: 12, fontWeight: '800' },
  memberCount: { color: '#F8FAFC', fontSize: 14, fontWeight: '700' },
  addPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderColor: 'rgba(56, 189, 248, 0.3)',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addPillText: { color: '#38BDF8', fontSize: 14, fontWeight: '800' },
  roster: {
    backgroundColor: '#151F32',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.14)',
    padding: 8,
    marginBottom: 16,
  },
  rosterEmpty: { color: '#94A3B8', fontSize: 14, padding: 12 },
  rosterRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 10 },
  rosterCopy: { flex: 1 },
  rosterNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rosterName: { flexShrink: 1, color: '#F8FAFC', fontSize: 15, fontWeight: '700' },
  ownerBadge: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '800',
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  rosterEmail: { marginTop: 2, color: '#94A3B8', fontSize: 13 },
  receiptCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#151F32',
    padding: 20,
    borderRadius: 20,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.14)',
  },
  receiptInfo: { flex: 1, paddingRight: 12 },
  receiptName: { fontSize: 18, fontWeight: '700', color: '#F8FAFC', marginBottom: 6, letterSpacing: -0.3 },
  dateText: { fontSize: 14, color: '#94A3B8', fontWeight: '500' },
  totalText: { fontSize: 20, fontWeight: '800', color: '#38BDF8', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  emptyState: { alignItems: 'center', padding: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: '#F8FAFC', marginTop: 20, marginBottom: 8, letterSpacing: -0.5 },
  emptySubtitle: { fontSize: 16, color: '#94A3B8', textAlign: 'center', lineHeight: 24 },
});
