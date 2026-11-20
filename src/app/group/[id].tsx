import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AddMemberModal } from '@/components/AddMemberModal';
import { AvatarBadge } from '@/components/AvatarBadge';
import { MoneyText } from '@/components/MoneyText';
import { StatusPill } from '@/components/StatusPill';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { compareGroupMembers, groupService, type GroupMemberProfile } from '@/services/GroupService';
import { createIdempotencyKey, SettlementServiceError, settlementService } from '@/services/SettlementService';
import { theme } from '@/theme/theme';
import type { Receipt, ReceiptSplit, Settlement } from '@/types/database.types';
import { formatPence, toMinorUnits } from '@/utils/money';
import { maskPhoneNumber } from '@/utils/phone';
import { calculateNetBalances, simplifyDebts, type SimplifiedTransfer } from '@/utils/settlements';

type GroupReceipt = Receipt & {
  restaurant_name?: string | null;
};

const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

function receiptWhen(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function monogram(name: string) {
  const letter = name.trim().charAt(0).toUpperCase();
  return letter || '?';
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

function settlementWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function GroupLedgerScreen() {
  const router = useRouter();
  const { session } = useSupabaseSession();
  const { id: idParam } = useLocalSearchParams<{ id?: string | string[] }>();
  const groupId = firstParam(idParam);
  const isValidId = groupId !== null && GROUP_ID.test(groupId);
  const viewerId = session?.user.id ?? null;
  const scrollRef = useRef<ScrollViewInstance>(null);
  const balancesOffset = useRef(0);

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
  const totalSpendMinor = toMinorUnits(spent);
  const splitReceiptIds = useMemo(() => new Set(splits.map((split) => split.receipt_id)), [splits]);
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

  function toggleRoster() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRosterOpen((open) => !open);
  }

  function openAddMember() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAddOpen(true);
  }

  function scanBill() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/scanner');
  }

  function settleUp() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (transfers.length > 0) {
      scrollRef.current?.scrollTo({ y: Math.max(balancesOffset.current - 8, 0), animated: true });
      return;
    }
    setHistoryOpen(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollToEnd({ animated: true });
      });
    });
  }

  const positionLabel = viewerBalance > 0
    ? `You are owed ${formatPence(viewerBalance)}`
    : viewerBalance < 0
      ? `You owe ${formatPence(Math.abs(viewerBalance))}`
      : 'All settled up';

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.navSafe}>
        <View style={styles.navBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Groups"
            onPress={goBack}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={styles.backButton}
          >
            <Ionicons name="chevron-back" size={22} color={theme.colors.textPrimary} />
            <Text style={styles.backLabel}>Groups</Text>
          </Pressable>
          {missing ? <View style={styles.gearSpacer} /> : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Group settings"
              accessibilityState={{ expanded: rosterOpen }}
              onPress={toggleRoster}
              style={({ pressed }) => [styles.gear, pressed && styles.gearPressed]}
            >
              <Ionicons name="settings-outline" size={18} color={theme.colors.textSecondary} />
            </Pressable>
          )}
        </View>
      </SafeAreaView>

      {isLoading ? (
        <ActivityIndicator size="large" color={theme.colors.accent} style={styles.loader} />
      ) : missing ? (
        <View style={styles.missing}>
          <Text style={styles.missingTitle}>Group unavailable</Text>
          <Text style={styles.missingCopy}>This group could not be opened. Go back and choose a saved group.</Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => {
                void loadLedger('refresh');
              }}
              tintColor={theme.colors.accent}
            />
          }
        >
          <View style={styles.hero}>
            <Text accessibilityRole="header" style={styles.groupName} numberOfLines={2}>{groupName}</Text>
            <Text style={styles.heroLabel}>Total group spend</Text>
            <MoneyText amountMinor={totalSpendMinor} size="hero" splitDecimals />
            <View style={styles.heroPill}>
              <StatusPill variant={viewerBalance < 0 ? 'warning' : 'positive'} label={positionLabel} />
            </View>
          </View>

          <View style={styles.actions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Scan bill" onPress={scanBill} style={styles.action}>
              {({ pressed }) => (
                <>
                  <View style={[styles.actionCircle, pressed && styles.actionCirclePressed]}>
                    <Ionicons name="scan-outline" size={20} color={theme.colors.accent} />
                  </View>
                  <Text style={styles.actionLabel}>Scan Bill</Text>
                </>
              )}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Add member" onPress={openAddMember} style={styles.action}>
              {({ pressed }) => (
                <>
                  <View style={[styles.actionCircle, pressed && styles.actionCirclePressed]}>
                    <Ionicons name="person-add-outline" size={20} color={theme.colors.textPrimary} />
                  </View>
                  <Text style={styles.actionLabel}>Add Member</Text>
                </>
              )}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Settle up" onPress={settleUp} style={styles.action}>
              {({ pressed }) => (
                <>
                  <View style={[styles.actionCircle, pressed && styles.actionCirclePressed]}>
                    <Ionicons name="checkmark-circle-outline" size={20} color={theme.colors.textPrimary} />
                  </View>
                  <Text style={styles.actionLabel}>Settle Up</Text>
                </>
              )}
            </Pressable>
          </View>

          <View style={styles.memberCard}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Group members"
              accessibilityState={{ expanded: rosterOpen }}
              onPress={toggleRoster}
              style={styles.memberMain}
            >
              <View style={styles.avatarStack}>
                {visibleMembers.map((member, index) => (
                  <View key={member.userId} style={[styles.stackCutout, index > 0 && styles.stackOverlap]}>
                    <AvatarBadge name={member.fullName} userId={member.userId} size={28} />
                  </View>
                ))}
                {overflow > 0 ? (
                  <View style={[styles.overflowBadge, styles.stackOverlap]}>
                    <Text style={styles.overflowText}>+{overflow}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.memberCount}>{members.length} {members.length === 1 ? 'member' : 'members'}</Text>
              <Ionicons name={rosterOpen ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Invite member"
              onPress={openAddMember}
              style={({ pressed }) => [styles.invitePill, pressed && styles.invitePressed]}
            >
              <Text style={styles.inviteText}>+ Invite</Text>
            </Pressable>
          </View>

          {rosterOpen ? (
            <View style={styles.roster}>
              {members.length === 0 ? <Text style={styles.rosterEmpty}>No members yet.</Text> : null}
              {members.map((member, index) => (
                <View key={member.userId}>
                  {index > 0 ? <View style={styles.rosterDivider} /> : null}
                  <View style={styles.rosterRow}>
                    <AvatarBadge name={member.fullName} userId={member.userId} size={40} />
                    <View style={styles.rosterCopy}>
                      <View style={styles.rosterNameRow}>
                        <Text style={styles.rosterName} numberOfLines={1}>{member.fullName}</Text>
                        {member.role === 'owner' ? <Text style={styles.ownerBadge}>Owner</Text> : null}
                      </View>
                      <Text style={styles.rosterMeta} numberOfLines={1}>{member.phone ? maskPhoneNumber(member.phone) : member.email}</Text>
                    </View>
                    {viewerIsOwner && member.role !== 'owner' ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${member.fullName}`}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        onPress={() => confirmRemove(member)}
                      >
                        <Ionicons name="person-remove-outline" size={18} color={theme.colors.textMuted} />
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {transfers.length > 0 ? (
            <View
              style={styles.section}
              onLayout={(event) => {
                balancesOffset.current = event.nativeEvent.layout.y;
              }}
            >
              <Text style={styles.sectionHeading}>Balances</Text>
              <View style={styles.card}>
                {transfers.map((transfer, index) => {
                  const key = transferKey(transfer);
                  const link = paymentLinkFor(members, transfer.toUserId);
                  const saving = savingKey === key;
                  const fromName = displayName(members, transfer.fromUserId);
                  return (
                    <View key={key}>
                      {index > 0 ? <View style={styles.transferDivider} /> : null}
                      <View style={styles.transferRow}>
                        <AvatarBadge name={fromName} userId={transfer.fromUserId} size={36} />
                        <View style={styles.transferCopy}>
                          <Text style={styles.transferTitle} numberOfLines={2}>
                            {fromName} owes {displayName(members, transfer.toUserId)}
                          </Text>
                          <Text style={styles.transferAmount}>{formatPence(transfer.amountMinor)}</Text>
                        </View>
                        <View style={styles.transferActions}>
                          {link ? (
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Pay ${displayName(members, transfer.toUserId)}`}
                              onPress={() => {
                                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                openPayLink(link);
                              }}
                              style={({ pressed }) => [styles.payPill, pressed && styles.payPillPressed]}
                            >
                              <Text style={styles.payText}>Pay</Text>
                            </Pressable>
                          ) : null}
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Mark ${formatPence(transfer.amountMinor)} as paid`}
                            disabled={saving || savingKey !== null}
                            onPress={() => markPaid(transfer)}
                            style={({ pressed }) => [styles.markPaid, (saving || pressed) && styles.markPaidBusy]}
                          >
                            {saving ? (
                              <ActivityIndicator size="small" color={theme.colors.accent} />
                            ) : (
                              <Text style={styles.markPaidText}>Mark paid</Text>
                            )}
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}

          <View style={styles.section}>
            <Text style={styles.sectionHeading}>Receipts</Text>
            {receipts.length === 0 ? (
              <Text style={styles.emptyLine}>Scan a receipt into this group and it will show up here.</Text>
            ) : (
              <View style={styles.card}>
                {receipts.map((item, index) => {
                  const name = receiptName(item);
                  return (
                    <View key={item.id}>
                      {index > 0 ? <View style={styles.receiptDivider} /> : null}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={name}
                        onPress={() => {
                          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          router.push({ pathname: '/receipt/[id]', params: { id: item.id } });
                        }}
                        style={({ pressed }) => [styles.receiptRow, pressed && styles.receiptPressed]}
                      >
                        <View style={styles.monogram}>
                          <Text style={styles.monogramText}>{monogram(name)}</Text>
                        </View>
                        <View style={styles.receiptCopy}>
                          <Text style={styles.receiptName} numberOfLines={1}>{name}</Text>
                          <Text style={styles.receiptMeta} numberOfLines={1}>
                            {receiptWhen(item.created_at)} · {splitReceiptIds.has(item.id) ? 'Split' : 'Unsplit'}
                          </Text>
                        </View>
                        <MoneyText amountMinor={toMinorUnits(Number(item.total_amount || 0))} size="md" color={theme.colors.textPrimary} />
                        <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          <View style={styles.historySection}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Settlement history"
              accessibilityState={{ expanded: historyOpen }}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setHistoryOpen((open) => !open);
              }}
              style={styles.historyHeader}
            >
              <View style={styles.historyTitle}>
                <Text style={styles.sectionLabel}>Settlement history</Text>
                {settlements.length > 0 ? (
                  <View style={styles.countBadge}>
                    <Text style={styles.countText}>{settlements.length}</Text>
                  </View>
                ) : null}
              </View>
              <Ionicons name={historyOpen ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textMuted} />
            </Pressable>
            {historyOpen ? (
              settlements.length === 0 ? (
                <Text style={styles.emptyLine}>No payments recorded yet.</Text>
              ) : (
                <View style={styles.card}>
                  {settlements.map((settlement, index) => {
                    const voided = settlement.voided_at !== null;
                    const when = settlementWhen(settlement.created_at);
                    return (
                      <View key={settlement.id}>
                        {index > 0 ? <View style={styles.historyDivider} /> : null}
                        <View style={[styles.historyRow, voided && styles.historyVoided]}>
                          <Text style={[styles.historyCopy, voided && styles.historyStrike]} numberOfLines={2}>
                            {displayName(members, settlement.from_user_id)} paid {displayName(members, settlement.to_user_id)}{' '}
                            {formatPence(settlement.amount_minor)}
                            {when ? ` · ${when}` : ''}
                          </Text>
                          {voided ? <Text style={styles.voidedPill}>Voided</Text> : null}
                          {!voided && canVoid(settlement) ? (
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel="Undo settlement"
                              disabled={voidingId !== null}
                              onPress={() => askVoid(settlement)}
                              style={styles.undoButton}
                            >
                              {voidingId === settlement.id ? (
                                <ActivityIndicator size="small" color={theme.colors.textMuted} />
                              ) : (
                                <Text style={styles.undoText}>Undo</Text>
                              )}
                            </Pressable>
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                </View>
              )
            ) : null}
          </View>
        </ScrollView>
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
  container: { flex: 1, backgroundColor: theme.colors.canvas },
  navSafe: { backgroundColor: theme.colors.canvas },
  navBar: {
    height: 52,
    paddingHorizontal: theme.spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: -6 },
  backLabel: { ...theme.typography.body, color: theme.colors.textSecondary },
  gear: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  gearPressed: { backgroundColor: theme.colors.surfacePressed },
  gearSpacer: { width: 36, height: 36 },
  loader: { marginTop: 48 },
  missing: { flex: 1, justifyContent: 'center', paddingHorizontal: theme.spacing.xxl },
  missingTitle: { ...theme.typography.bodyStrong, color: theme.colors.textPrimary, fontSize: 20, lineHeight: 26 },
  missingCopy: { ...theme.typography.body, color: theme.colors.textSecondary, marginTop: theme.spacing.sm },
  scrollContent: { paddingBottom: 24 },
  hero: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 },
  groupName: { ...theme.typography.screenTitle, color: theme.colors.textPrimary, marginBottom: 16 },
  heroLabel: { ...theme.typography.sectionLabel, color: theme.colors.textMuted, marginBottom: 4 },
  heroPill: { marginTop: 10 },
  actions: {
    marginTop: 20,
    paddingHorizontal: 20,
    flexDirection: 'row',
    gap: 16,
  },
  action: { flex: 1, alignItems: 'center' },
  actionCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  actionCirclePressed: { backgroundColor: theme.colors.surfaceElevated },
  actionLabel: { marginTop: 6, fontSize: 12, lineHeight: 16, fontWeight: '500', color: theme.colors.textSecondary, textAlign: 'center' },
  memberCard: {
    marginHorizontal: 16,
    marginTop: 20,
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  memberMain: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 28 },
  avatarStack: { flexDirection: 'row', alignItems: 'center' },
  stackCutout: { borderWidth: 2, borderColor: theme.colors.surface, borderRadius: theme.radius.full },
  stackOverlap: { marginLeft: -8 },
  overflowBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: theme.colors.surface,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overflowText: { ...theme.typography.micro, color: theme.colors.textPrimary },
  memberCount: { marginLeft: 10, flex: 1, fontSize: 14, lineHeight: 18, fontWeight: '500', color: theme.colors.textPrimary },
  invitePill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.accentSubtle,
  },
  invitePressed: { opacity: 0.7 },
  inviteText: { color: theme.colors.accent, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  roster: {
    marginHorizontal: 16,
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  rosterEmpty: { ...theme.typography.caption, color: theme.colors.textMuted, padding: 14 },
  rosterDivider: { height: StyleSheet.hairlineWidth, marginLeft: 66, backgroundColor: theme.colors.border },
  rosterRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  rosterCopy: { flex: 1 },
  rosterNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rosterName: { flexShrink: 1, ...theme.typography.bodyStrong, color: theme.colors.textPrimary },
  ownerBadge: {
    ...theme.typography.micro,
    color: theme.colors.accent,
    backgroundColor: theme.colors.accentSubtle,
    borderRadius: theme.radius.full,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  rosterMeta: { ...theme.typography.caption, color: theme.colors.textSecondary, marginTop: 2 },
  section: { marginHorizontal: 16, marginTop: 24 },
  sectionHeading: { ...theme.typography.sectionLabel, color: theme.colors.textMuted, marginBottom: 8, marginLeft: 4 },
  sectionLabel: { ...theme.typography.sectionLabel, color: theme.colors.textMuted },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  transferDivider: { height: StyleSheet.hairlineWidth, marginLeft: 56, backgroundColor: theme.colors.border },
  transferRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14 },
  transferCopy: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 8 },
  transferTitle: { fontSize: 14, lineHeight: 19, fontWeight: '500', color: theme.colors.textPrimary },
  transferAmount: {
    marginTop: 2,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  transferActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  payPill: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.full,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  payPillPressed: { backgroundColor: theme.colors.surfacePressed },
  payText: { color: theme.colors.textPrimary, fontSize: 12, lineHeight: 16, fontWeight: '600' },
  markPaid: {
    backgroundColor: theme.colors.accentSubtle,
    borderRadius: theme.radius.full,
    paddingHorizontal: 12,
    paddingVertical: 7,
    minWidth: 84,
    minHeight: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markPaidBusy: { opacity: 0.7 },
  markPaidText: { color: theme.colors.accent, fontSize: 12, lineHeight: 16, fontWeight: '600' },
  emptyLine: { ...theme.typography.caption, color: theme.colors.textMuted, paddingLeft: 4 },
  receiptDivider: { height: StyleSheet.hairlineWidth, marginLeft: 66, backgroundColor: theme.colors.border },
  receiptRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 14 },
  receiptPressed: { backgroundColor: theme.colors.surfaceElevated },
  monogram: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramText: { color: theme.colors.accent, fontSize: 16, fontWeight: '700' },
  receiptCopy: { flex: 1, minWidth: 0, marginLeft: 6 },
  receiptName: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: theme.colors.textPrimary },
  receiptMeta: { ...theme.typography.caption, color: theme.colors.textSecondary, marginTop: 2 },
  historySection: { marginHorizontal: 16, marginTop: 24, marginBottom: 40 },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  historyTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  countBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { ...theme.typography.micro, color: theme.colors.textSecondary, fontVariant: ['tabular-nums'] },
  historyDivider: { height: StyleSheet.hairlineWidth, marginLeft: 14, backgroundColor: theme.colors.border },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 14 },
  historyVoided: { opacity: 0.55 },
  historyCopy: { flex: 1, fontSize: 14, lineHeight: 20, fontWeight: '500', color: theme.colors.textPrimary, fontVariant: ['tabular-nums'] },
  historyStrike: { textDecorationLine: 'line-through' },
  voidedPill: {
    ...theme.typography.micro,
    color: theme.colors.textMuted,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: theme.radius.full,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  undoButton: { minWidth: 44, minHeight: 32, alignItems: 'flex-end', justifyContent: 'center' },
  undoText: { color: theme.colors.danger, fontSize: 13, fontWeight: '600' },
});
