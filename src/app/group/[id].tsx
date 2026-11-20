import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Linking, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { AddMemberModal } from '@/components/AddMemberModal';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { compareGroupMembers, groupService, type GroupMemberProfile } from '@/services/GroupService';
import { createIdempotencyKey, SettlementServiceError, settlementService } from '@/services/SettlementService';
import type { Receipt, ReceiptSplit, Settlement } from '@/types/database.types';
import { formatPence } from '@/utils/money';
import { maskPhoneNumber } from '@/utils/phone';
import { calculateNetBalances, simplifyDebts, type SimplifiedTransfer } from '@/utils/settlements';

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

function memberById(members: GroupMemberProfile[], userId: string) {
  return members.find((member) => member.userId === userId) ?? null;
}

function displayName(members: GroupMemberProfile[], userId: string) {
  return memberById(members, userId)?.fullName ?? 'Member';
}

function paymentLinkFor(members: GroupMemberProfile[], userId: string) {
  const link = memberById(members, userId)?.paymentLink?.trim();
  return link ? link : null;
}

function transferKey(transfer: SimplifiedTransfer) {
  return `${transfer.fromUserId}->${transfer.toUserId}:${transfer.amountMinor}`;
}

function positionCopy(balanceMinor: number) {
  if (balanceMinor > 0) return { text: `You are owed ${formatPence(balanceMinor)}`, color: '#4ade80' };
  if (balanceMinor < 0) return { text: `You owe ${formatPence(Math.abs(balanceMinor))}`, color: '#fbbf24' };
  return { text: 'All settled up', color: '#94a3b8' };
}

function settlementWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function PersonAvatar({ userId, members, size = 32 }: { userId: string; members: GroupMemberProfile[]; size?: number }) {
  const member = memberById(members, userId);
  if (member) return <MemberAvatar member={member} size={size} />;
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: '#1e293b' }]}>
      <Text style={[styles.avatarText, { color: '#94a3b8', fontSize: 12 }]}>?</Text>
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
  const [splits, setSplits] = useState<ReceiptSplit[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [members, setMembers] = useState<GroupMemberProfile[]>([]);
  const [isLoading, setIsLoading] = useState(isValidId);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [missing, setMissing] = useState(!isValidId);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());

  const goBack = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  const loadLedger = useCallback(async (mode: 'load' | 'refresh' = 'load') => {
    if (!groupId || !GROUP_ID.test(groupId)) {
      setMissing(true);
      setReceipts([]);
      setSplits([]);
      setSettlements([]);
      setMembers([]);
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }

    if (!supabase) {
      setMissing(true);
      setReceipts([]);
      setSplits([]);
      setSettlements([]);
      setMembers([]);
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
      const [groupResult, ledger, memberList] = await Promise.all([
        supabase.from('groups').select('name, created_by').eq('id', groupId).maybeSingle(),
        settlementService.getGroupLedgerData(groupId),
        groupService.getGroupMembers(groupId).catch((error: unknown) => {
          console.error('Failed to load group members:', error);
          return [] as GroupMemberProfile[];
        }),
      ]);

      if (groupResult.error) throw groupResult.error;
      if (!groupResult.data) {
        setMissing(true);
        setReceipts([]);
        setSplits([]);
        setSettlements([]);
        setMembers([]);
        return;
      }

      setMissing(false);
      setGroupName(typeof groupResult.data.name === 'string' && groupResult.data.name.trim() ? groupResult.data.name : 'Group');
      setCreatedBy(typeof groupResult.data.created_by === 'string' ? groupResult.data.created_by : null);
      setReceipts(ledger.receipts as GroupReceipt[]);
      setSplits(ledger.splits);
      setSettlements(ledger.settlements);
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
  const memberIds = useMemo(() => {
    const ids = members.map((member) => member.userId);
    if (viewerId && !ids.includes(viewerId)) ids.push(viewerId);
    return ids;
  }, [members, viewerId]);
  const balances = useMemo(() => {
    try {
      return calculateNetBalances(
        receipts.map((receipt) => ({ id: receipt.id, paid_by: receipt.paid_by ?? null })),
        splits.map((split) => ({
          receipt_id: split.receipt_id,
          user_id: split.user_id,
          amount_minor: split.amount_minor,
        })),
        settlements.map((settlement) => ({
          from_user_id: settlement.from_user_id,
          to_user_id: settlement.to_user_id,
          amount_minor: settlement.amount_minor,
          voided_at: settlement.voided_at,
        })),
        memberIds,
      );
    } catch (error) {
      console.error('Failed to calculate balances:', error);
      return Object.fromEntries(memberIds.map((id) => [id, 0]));
    }
  }, [receipts, splits, settlements, memberIds]);
  const transfers = useMemo(() => simplifyDebts(balances), [balances]);
  const viewerBalance = viewerId ? (balances[viewerId] ?? 0) : 0;
  const position = positionCopy(viewerBalance);
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

  function markPaid(transfer: SimplifiedTransfer) {
    if (!groupId || savingKey) return;
    const key = transferKey(transfer);
    const existingKey = idempotencyKeys.current.get(key);
    const idempotencyKey = existingKey ?? createIdempotencyKey();
    if (!existingKey) idempotencyKeys.current.set(key, idempotencyKey);

    Alert.alert('Mark as paid', `Mark ${formatPence(transfer.amountMinor)} as paid?`, [
      {
        text: 'Cancel',
        style: 'cancel',
        onPress: () => {
          if (savingKey !== key) idempotencyKeys.current.delete(key);
        },
      },
      {
        text: 'Mark as Paid',
        onPress: () => {
          void confirmPaid(transfer, idempotencyKey);
        },
      },
    ]);
  }

  async function confirmPaid(transfer: SimplifiedTransfer, idempotencyKey: string) {
    if (!groupId) return;
    const key = transferKey(transfer);
    setSavingKey(key);

    try {
      await settlementService.recordSettlement({
        groupId,
        fromUserId: transfer.fromUserId,
        toUserId: transfer.toUserId,
        amountMinor: transfer.amountMinor,
        paymentMethod: 'manual',
        idempotencyKey,
      });
      idempotencyKeys.current.delete(key);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadLedger('refresh');
    } catch (error) {
      console.error('Failed to record settlement:', error);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const message = error instanceof SettlementServiceError ? error.message : 'Try again in a moment.';
      Alert.alert('Could not mark as paid', message);
    } finally {
      setSavingKey(null);
    }
  }

  function openPayLink(link: string) {
    const target = /^[a-z][a-z0-9+.-]*:/i.test(link) ? link : `https://${link}`;
    void Linking.openURL(target).catch((error: unknown) => {
      console.error('Failed to open payment link:', error);
      Alert.alert('Could not open payment link', 'Check the link and try again.');
    });
  }

  function canVoid(settlement: Settlement) {
    if (!viewerId || settlement.voided_at) return false;
    return settlement.created_by === viewerId || settlement.from_user_id === viewerId || settlement.to_user_id === viewerId;
  }

  function askVoid(settlement: Settlement) {
    if (voidingId) return;
    Alert.alert('Void settlement', `Undo ${formatPence(settlement.amount_minor)}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Void',
        style: 'destructive',
        onPress: () => {
          void confirmVoid(settlement.id);
        },
      },
    ]);
  }

  async function confirmVoid(settlementId: string) {
    setVoidingId(settlementId);
    try {
      await settlementService.voidSettlement(settlementId);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadLedger('refresh');
    } catch (error) {
      console.error('Failed to void settlement:', error);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const message = error instanceof SettlementServiceError ? error.message : 'Try again in a moment.';
      Alert.alert('Could not void settlement', message);
    } finally {
      setVoidingId(null);
    }
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

                <View style={styles.balanceCard}>
                  <Text style={styles.sectionLabel}>BALANCES</Text>
                  <Text style={[styles.positionText, { color: position.color }]}>{position.text}</Text>
                  {transfers.map((transfer) => {
                    const key = transferKey(transfer);
                    const link = paymentLinkFor(members, transfer.toUserId);
                    const saving = savingKey === key;
                    return (
                      <View key={key} style={styles.transferBlock}>
                        <View style={styles.transferRow}>
                          <PersonAvatar userId={transfer.fromUserId} members={members} />
                          <Text style={styles.transferCopy} numberOfLines={2}>
                            {displayName(members, transfer.fromUserId)} owes {displayName(members, transfer.toUserId)}
                          </Text>
                          <PersonAvatar userId={transfer.toUserId} members={members} />
                          <Text style={styles.transferAmount}>{formatPence(transfer.amountMinor)}</Text>
                        </View>
                        <View style={styles.transferActions}>
                          {link ? (
                            <TouchableOpacity
                              accessibilityRole="button"
                              accessibilityLabel={`Pay ${displayName(members, transfer.toUserId)}`}
                              style={styles.payButton}
                              activeOpacity={0.8}
                              onPress={() => {
                                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                openPayLink(link);
                              }}
                            >
                              <Text style={styles.payButtonText}>Pay</Text>
                            </TouchableOpacity>
                          ) : null}
                          <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel={`Mark ${formatPence(transfer.amountMinor)} as paid`}
                            style={[styles.paidButton, saving && styles.buttonBusy]}
                            activeOpacity={0.8}
                            disabled={saving || savingKey !== null}
                            onPress={() => markPaid(transfer)}
                          >
                            {saving ? (
                              <ActivityIndicator size="small" color="#0f172a" />
                            ) : (
                              <Text style={styles.paidButtonText}>Mark as Paid</Text>
                            )}
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })}
                </View>
              </View>
            )
          }
          ListFooterComponent={
            missing ? undefined : (
              <View style={styles.historyCard}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Settlement history"
                  style={styles.historyHeader}
                  activeOpacity={0.8}
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setHistoryOpen((open) => !open);
                  }}
                >
                  <Text style={styles.sectionLabel}>SETTLEMENT HISTORY</Text>
                  <Ionicons name={historyOpen ? 'chevron-up' : 'chevron-down'} size={16} color="#94A3B8" />
                </TouchableOpacity>
                {historyOpen ? (
                  settlements.length === 0 ? (
                    <Text style={styles.historyEmpty}>No payments recorded yet.</Text>
                  ) : (
                    settlements.map((settlement) => {
                      const voided = settlement.voided_at !== null;
                      const when = settlementWhen(settlement.created_at);
                      return (
                        <View key={settlement.id} style={styles.historyRow}>
                          <Text style={[styles.historyCopy, voided && styles.historyVoided]} numberOfLines={2}>
                            {displayName(members, settlement.from_user_id)} paid {displayName(members, settlement.to_user_id)}{' '}
                            {formatPence(settlement.amount_minor)}
                            {when ? ` · ${when}` : ''}
                          </Text>
                          {voided ? <Text style={styles.voidedBadge}>Voided</Text> : null}
                          {!voided && canVoid(settlement) ? (
                            <TouchableOpacity
                              accessibilityRole="button"
                              accessibilityLabel="Undo settlement"
                              style={styles.undoButton}
                              disabled={voidingId !== null}
                              onPress={() => askVoid(settlement)}
                            >
                              {voidingId === settlement.id ? (
                                <ActivityIndicator size="small" color="#94a3b8" />
                              ) : (
                                <Text style={styles.undoText}>Undo</Text>
                              )}
                            </TouchableOpacity>
                          ) : null}
                        </View>
                      );
                    })
                  )
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
  sectionLabel: { color: '#94A3B8', fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  balanceCard: {
    backgroundColor: '#1e293b',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.14)',
    padding: 16,
    marginBottom: 16,
  },
  positionText: { marginTop: 10, fontSize: 22, fontWeight: '800', letterSpacing: -0.4, fontVariant: ['tabular-nums'] },
  transferBlock: { marginTop: 16, gap: 10 },
  transferRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  transferCopy: { flex: 1, color: '#F8FAFC', fontSize: 15, fontWeight: '600', lineHeight: 20 },
  transferAmount: { color: '#F8FAFC', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  transferActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  payButton: {
    borderWidth: 1,
    borderColor: '#4ade80',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 64,
    alignItems: 'center',
  },
  payButtonText: { color: '#4ade80', fontSize: 14, fontWeight: '800' },
  paidButton: {
    backgroundColor: '#4ade80',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 118,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paidButtonText: { color: '#0f172a', fontSize: 14, fontWeight: '800' },
  buttonBusy: { opacity: 0.8 },
  historyCard: {
    backgroundColor: '#1e293b',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.14)',
    padding: 16,
    marginTop: 4,
  },
  historyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  historyEmpty: { marginTop: 12, color: '#94A3B8', fontSize: 14 },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  historyCopy: { flex: 1, color: '#F8FAFC', fontSize: 14, fontWeight: '600', lineHeight: 20, fontVariant: ['tabular-nums'] },
  historyVoided: { color: '#64748b', textDecorationLine: 'line-through' },
  voidedBadge: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '800',
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  undoButton: { minWidth: 48, alignItems: 'flex-end', justifyContent: 'center' },
  undoText: { color: '#94a3b8', fontSize: 13, fontWeight: '700' },
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
