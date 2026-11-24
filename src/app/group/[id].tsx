import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, LayoutAnimation, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AddMemberModal } from '@/components/AddMemberModal';
import { AvatarBadge } from '@/components/AvatarBadge';
import { MoneyText } from '@/components/MoneyText';
import { PaymentSheetModal, type MarkPaidResult } from '@/components/PaymentSheetModal';
import { StatusPill } from '@/components/StatusPill';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { compareGroupMembers, GroupServiceError, groupService, type GroupMemberProfile } from '@/services/GroupService';
import { createIdempotencyKey, SettlementServiceError, settlementService, type GroupLedgerData } from '@/services/SettlementService';
import { theme } from '@/theme/theme';
import type { Receipt, ReceiptSplit, Settlement } from '@/types/database.types';
import { formatSmartDate } from '@/utils/formatSmartDate';
import { computeGroupNetBalance, type GroupNetBalance } from '@/utils/homeBalances';
import { mapErrorToUserMessage } from '@/utils/errorMapper';
import { logger } from '@/utils/logger';
import { formatPence, toMinorUnits } from '@/utils/money';
import { maskPhoneNumber } from '@/utils/phone';
import { calculateNetBalances, deriveGroupLedgerStatus, latestZeroBalanceAt, partitionGroupReceipts, simplifyDebts, type GroupLedgerStatus, type SimplifiedTransfer } from '@/utils/settlements';

type GroupReceipt = Receipt & {
  restaurant_name?: string | null;
};

const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VISIBLE_AVATARS = 5;
const SETTLED_RECEIPTS_PREVIEW_LIMIT = 5;

function animateHistoryLayout() {
  if (Platform.OS !== 'ios') return;
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
}

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

function transferKey(transfer: SimplifiedTransfer) {
  return `${transfer.fromUserId}->${transfer.toUserId}:${transfer.amountMinor}`;
}

function transferStillOpen(data: GroupLedgerData, memberIds: readonly string[], transfer: SimplifiedTransfer) {
  const balances = calculateNetBalances(
    data.receipts.map((receipt) => ({ id: receipt.id, paid_by: receipt.paid_by ?? null })),
    data.splits.map((split) => ({
      receipt_id: split.receipt_id,
      user_id: split.user_id,
      amount_minor: split.amount_minor,
    })),
    data.settlements.map((settlement) => ({
      from_user_id: settlement.from_user_id,
      to_user_id: settlement.to_user_id,
      amount_minor: settlement.amount_minor,
      voided_at: settlement.voided_at,
    })),
    memberIds,
  );
  return simplifyDebts(balances).some((row) => (
    row.fromUserId === transfer.fromUserId
    && row.toUserId === transfer.toUserId
    && row.amountMinor === transfer.amountMinor
  ));
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
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [showAllSettledReceipts, setShowAllSettledReceipts] = useState(false);
  const [historyGroupId, setHistoryGroupId] = useState(groupId);
  const [wasHistoryExpanded, setWasHistoryExpanded] = useState(historyExpanded);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [groupAction, setGroupAction] = useState<'delete' | 'leave' | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [payTarget, setPayTarget] = useState<SimplifiedTransfer | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());
  const loadedFor = useRef<string | null>(null);

  if (groupId !== historyGroupId) {
    setHistoryGroupId(groupId);
    setShowAllSettledReceipts(false);
  }
  if (historyExpanded !== wasHistoryExpanded) {
    setWasHistoryExpanded(historyExpanded);
    if (!historyExpanded) setShowAllSettledReceipts(false);
  }

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
          logger.error('group', { code: 'MEMBERS_FAILED' });
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
      logger.error('group', { code: 'LEDGER_FAILED' });
      setMissing(true);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [groupId]);

  useFocusEffect(
    useCallback(() => {
      const returning = loadedFor.current === groupId && groupId !== null;
      if (groupId) loadedFor.current = groupId;
      void loadLedger(returning ? 'refresh' : 'load');
    }, [groupId, loadLedger]),
  );

  const spent = receipts.reduce((sum, receipt) => sum + Number(receipt.total_amount || 0), 0);
  const totalSpendMinor = toMinorUnits(spent);
  const splitReceiptIds = useMemo(() => new Set(splits.map((split) => split.receipt_id)), [splits]);
  const lastSettledAt = useMemo(
    () => latestZeroBalanceAt(
      receipts.map((receipt) => ({
        id: receipt.id,
        paid_by: receipt.paid_by ?? null,
        created_at: receipt.created_at,
      })),
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
        created_at: settlement.created_at,
      })),
    ),
    [receipts, splits, settlements],
  );
  const { activeReceipts, settledReceipts } = useMemo(
    () => partitionGroupReceipts(receipts, splitReceiptIds, lastSettledAt),
    [lastSettledAt, receipts, splitReceiptIds],
  );
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
      logger.error('group', { code: 'BALANCE_FAILED' });
      return Object.fromEntries(memberIds.map((id) => [id, 0]));
    }
  }, [receipts, splits, settlements, memberIds]);
  const transfers = useMemo(() => simplifyDebts(balances), [balances]);
  const groupStatus = useMemo(() => {
    try {
      return deriveGroupLedgerStatus({
        receipts: receipts.map((receipt) => ({
          id: receipt.id,
          created_at: receipt.created_at,
          paid_by: receipt.paid_by ?? null,
          settled_at: receipt.settled_at,
        })),
        splits: splits.map((split) => ({
          receipt_id: split.receipt_id,
          user_id: split.user_id,
          amount_minor: split.amount_minor,
        })),
        settlements: settlements.map((settlement) => ({
          from_user_id: settlement.from_user_id,
          to_user_id: settlement.to_user_id,
          amount_minor: settlement.amount_minor,
          voided_at: settlement.voided_at,
          created_at: settlement.created_at,
        })),
        memberIds,
        currentUserId: viewerId,
      });
    } catch (error) {
      logger.error('group', { code: 'STATUS_FAILED' });
      const receiptCount = receipts.length;
      return {
        kind: receiptCount === 0 ? 'empty' : 'needs_split',
        receiptCount,
        activeReceiptCount: receiptCount,
        settledReceiptCount: 0,
        unsplitActiveCount: receiptCount,
        transferCount: 0,
        userNetBalanceMinor: 0,
      } satisfies GroupLedgerStatus;
    }
  }, [memberIds, receipts, settlements, splits, viewerId]);
  const personalStanding = useMemo(() => {
    const settledIds = new Set(settledReceipts.map((receipt) => receipt.id));
    const names = new Map(members.map((member) => [member.userId, member.fullName]));
    return computeGroupNetBalance(receipts.map((receipt) => {
      const creditorId = receipt.paid_by?.trim() || receipt.host_id;
      return {
        id: receipt.id,
        hostId: receipt.host_id,
        paidBy: receipt.paid_by ?? null,
        creditorName: names.get(creditorId) ?? 'Someone',
        merchantName: receipt.merchant_name,
        createdAt: receipt.created_at,
        settled: settledIds.has(receipt.id) || receipt.settled_at != null || receipt.status === 'settled',
        shares: splits
          .filter((split) => split.receipt_id === receipt.id)
          .map((split) => ({
            userId: split.user_id,
            displayName: names.get(split.user_id) ?? 'Someone',
            amountPence: split.amount_minor,
          })),
      };
    }), viewerId);
  }, [members, receipts, settledReceipts, splits, viewerId]);
  const totalHistoryCount = useMemo(
    () => settlements.length + settledReceipts.length,
    [settledReceipts.length, settlements.length],
  );
  const sortedSettledReceipts = useMemo(
    () => [...settledReceipts].sort((left, right) => {
      const leftAt = Date.parse(left.settled_at ?? left.created_at);
      const rightAt = Date.parse(right.settled_at ?? right.created_at);
      const leftTime = Number.isNaN(leftAt) ? 0 : leftAt;
      const rightTime = Number.isNaN(rightAt) ? 0 : rightAt;
      return rightTime - leftTime;
    }),
    [settledReceipts],
  );
  const visibleSettledReceipts = useMemo(
    () => (showAllSettledReceipts
      ? sortedSettledReceipts
      : sortedSettledReceipts.slice(0, SETTLED_RECEIPTS_PREVIEW_LIMIT)),
    [showAllSettledReceipts, sortedSettledReceipts],
  );
  const hiddenSettledCount = useMemo(
    () => Math.max(0, sortedSettledReceipts.length - SETTLED_RECEIPTS_PREVIEW_LIMIT),
    [sortedSettledReceipts],
  );
  const viewerIsOwner = members.some((member) => member.userId === viewerId && member.role === 'owner') || (viewerId !== null && viewerId === createdBy);
  const isCreator = viewerId !== null && (createdBy ? viewerId === createdBy : members.some((member) => member.userId === viewerId && member.role === 'owner'));
  const isMember = viewerId !== null && members.some((member) => member.userId === viewerId);
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

  function openPayment(transfer: SimplifiedTransfer) {
    if (!groupId || savingKey) return;
    const key = transferKey(transfer);
    if (!idempotencyKeys.current.has(key)) idempotencyKeys.current.set(key, createIdempotencyKey());
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPayTarget(transfer);
  }

  async function confirmSheetPaid(): Promise<MarkPaidResult> {
    if (!groupId || !payTarget) return 'unavailable';
    const transfer = payTarget;
    const key = transferKey(transfer);
    const idempotencyKey = idempotencyKeys.current.get(key) ?? createIdempotencyKey();
    setSavingKey(key);

    try {
      const fresh = await settlementService.getGroupLedgerData(groupId);
      if (!transferStillOpen(fresh, memberIds, transfer)) {
        idempotencyKeys.current.delete(key);
        await loadLedger('refresh');
        return 'already_settled';
      }

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
      return 'paid';
    } catch (error) {
      logger.error('group', { code: error instanceof SettlementServiceError ? error.code : 'SAVE_FAILED' });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      throw error;
    } finally {
      setSavingKey(null);
    }
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
      logger.error('group', { code: error instanceof SettlementServiceError ? error.code : 'VOID_FAILED' });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not void settlement', mapErrorToUserMessage(error, 'Try again in a moment.'));
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
      logger.error('group', { code: 'REMOVE_FAILED' });
      setMembers(previous);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not remove member', 'This member is still in the group.');
    }
  }

  function openSettings() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSettingsOpen(true);
  }

  function closeSettings() {
    if (groupAction) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSettingsOpen(false);
  }

  function confirmDeleteGroup() {
    if (!groupId || groupAction) return;
    const message = groupStatus.kind === 'balances_owed'
      ? 'This group still has unsettled balances. Deleting it will permanently remove its ledger and settlement history.'
      : `This will permanently delete ${groupName} and its settlement history. This cannot be undone.`;
    Alert.alert('Delete group', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete Group',
        style: 'destructive',
        onPress: () => {
          void runDeleteGroup();
        },
      },
    ]);
  }

  function confirmLeaveGroup() {
    if (!groupId || groupAction) return;
    const message = groupStatus.kind === 'balances_owed'
      ? 'This group still has unsettled balances. Leaving removes you from the group and its ledger.'
      : `Leave ${groupName}? You will lose access to this group. This cannot be undone.`;
    Alert.alert('Leave group', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave Group',
        style: 'destructive',
        onPress: () => {
          void runLeaveGroup();
        },
      },
    ]);
  }

  async function finishGroupAction() {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSettingsOpen(false);
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/groups');
    }
  }

  async function runDeleteGroup() {
    if (!groupId || groupAction) return;
    setGroupAction('delete');
    try {
      await groupService.deleteGroup(groupId);
      await finishGroupAction();
    } catch (error) {
      logger.error('group', { code: error instanceof GroupServiceError ? error.code : 'DELETE_FAILED' });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not delete group', mapErrorToUserMessage(error, 'Try again in a moment.'));
      setGroupAction(null);
    }
  }

  async function runLeaveGroup() {
    if (!groupId || groupAction) return;
    setGroupAction('leave');
    try {
      await groupService.leaveGroup(groupId);
      await finishGroupAction();
    } catch (error) {
      logger.error('group', { code: error instanceof GroupServiceError ? error.code : 'LEAVE_FAILED' });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not leave group', mapErrorToUserMessage(error, 'Try again in a moment.'));
      setGroupAction(null);
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
    scrollRef.current?.scrollTo({ y: Math.max(balancesOffset.current - 8, 0), animated: true });
  }

  function toggleHistory() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    animateHistoryLayout();
    setHistoryExpanded((expanded) => !expanded);
  }

  function toggleSettledReceipts() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    animateHistoryLayout();
    setShowAllSettledReceipts((showAll) => !showAll);
  }

  function renderReceiptRow(item: GroupReceipt, index: number) {
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
            <View style={styles.nameRow}>
              <Text style={styles.receiptName} numberOfLines={1} ellipsizeMode="tail">{name}</Text>
            </View>
            <Text style={styles.receiptMeta} numberOfLines={1}>
              {receiptWhen(item.created_at)} · {splitReceiptIds.has(item.id) ? 'Split' : 'Unsplit'}
            </Text>
          </View>
          <MoneyText amountMinor={toMinorUnits(Number(item.total_amount || 0))} size="md" color={theme.colors.textPrimary} />
          <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
        </Pressable>
      </View>
    );
  }

  const settleOpen = groupStatus.kind === 'balances_owed';
  const settleDone = groupStatus.kind === 'settled';

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
              onPress={openSettings}
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
            <PersonalStanding balance={personalStanding} />
            <View style={styles.heroPill}>
              <GroupHeroPill status={groupStatus} />
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={settleOpen ? 'Settle up' : settleDone ? 'All balances settled' : 'Settle up'}
              accessibilityState={{ disabled: !settleOpen }}
              disabled={!settleOpen}
              onPress={settleUp}
              style={styles.action}
            >
              {({ pressed }) => (
                <>
                  <View style={[
                    styles.actionCircle,
                    !settleOpen && !settleDone && styles.actionCircleEmpty,
                    settleDone && styles.actionCircleSettled,
                    settleOpen && pressed && styles.actionCirclePressed,
                  ]}>
                    <Ionicons
                      name={settleDone ? 'checkmark' : 'checkmark-circle-outline'}
                      size={20}
                      color={settleDone ? theme.colors.positive : settleOpen ? theme.colors.accent : theme.colors.textMuted}
                    />
                  </View>
                  <Text style={[styles.actionLabel, settleOpen ? styles.actionLabelActive : styles.actionLabelSettled]}>
                    {settleDone ? 'Settled' : 'Settle Up'}
                  </Text>
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
                  const saving = savingKey === key;
                  const fromName = displayName(members, transfer.fromUserId);
                  const amountLabel = formatPence(transfer.amountMinor);
                  return (
                    <View key={key}>
                      {index > 0 ? <View style={styles.transferDivider} /> : null}
                      <View style={styles.transferRow}>
                        <AvatarBadge name={fromName} userId={transfer.fromUserId} size={36} />
                        <View style={styles.transferCopy}>
                          <Text style={styles.transferTitle} numberOfLines={2}>
                            {fromName} owes {displayName(members, transfer.toUserId)}
                          </Text>
                          <Text style={styles.transferAmount}>{amountLabel}</Text>
                        </View>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Pay ${amountLabel} to ${displayName(members, transfer.toUserId)}`}
                          accessibilityState={{ disabled: savingKey !== null, busy: saving }}
                          disabled={savingKey !== null}
                          onPress={() => openPayment(transfer)}
                          style={({ pressed }) => [styles.payPill, pressed && styles.payPillPressed, saving && styles.markPaidBusy]}
                        >
                          {saving ? (
                            <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                          ) : (
                            <Text style={styles.payText}>Pay {amountLabel}</Text>
                          )}
                        </Pressable>
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}

          <View style={styles.section}>
            <Text style={styles.sectionHeading}>Receipts</Text>
            {activeReceipts.length === 0 && settledReceipts.length > 0 ? (
              <View style={styles.allSettledCard}>
                <View style={styles.allSettledBadge}>
                  <Ionicons name="checkmark" size={16} color={theme.colors.positive} />
                </View>
                <View style={styles.allSettledCopy}>
                  <Text style={styles.allSettledTitle}>All receipts settled</Text>
                  <Text style={styles.allSettledSubtitle}>
                    {`${settledReceipts.length} archived in Settlement History`}
                  </Text>
                </View>
              </View>
            ) : activeReceipts.length === 0 ? (
              <View style={styles.emptyReceiptCard}>
                <View style={styles.emptyReceiptIcon}>
                  <Ionicons name="receipt-outline" size={22} color={theme.colors.textSecondary} />
                </View>
                <Text style={styles.emptyReceiptTitle}>No receipts yet</Text>
                <Text style={styles.emptyReceiptBody}>Scan a receipt into this group and it will show up here.</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Scan first bill"
                  onPress={scanBill}
                  style={styles.emptyReceiptButton}
                >
                  <Text style={styles.emptyReceiptButtonText}>Scan first bill</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.card}>
                {activeReceipts.map((item, index) => renderReceiptRow(item, index))}
              </View>
            )}
          </View>

          <View style={styles.historySection}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Toggle settlement history"
              accessibilityState={{ expanded: historyExpanded }}
              onPress={toggleHistory}
              style={({ pressed }) => [styles.historyHeader, pressed && styles.historyHeaderPressed]}
            >
              <View style={styles.historyTitle}>
                <Text style={styles.historyLabel}>SETTLEMENT HISTORY</Text>
                {totalHistoryCount > 0 ? (
                  <View style={styles.historyCount}>
                    <Text style={styles.historyCountText}>{String(totalHistoryCount)}</Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.historyHintRow}>
                <Text style={styles.historyHint}>{historyExpanded ? 'Hide' : 'Show'}</Text>
                <Ionicons name={historyExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textMuted} />
              </View>
            </Pressable>
            {historyExpanded ? (
              <View style={styles.historyBody}>
                {settlements.length === 0 && settledReceipts.length === 0 ? (
                  <View style={styles.historyEmpty}>
                    <Text style={styles.historyEmptyText}>No payments or settled receipts yet.</Text>
                  </View>
                ) : (
                  <>
                    {settlements.length > 0 ? (
                      <View>
                        <Text style={styles.historySubLabel}>PAYMENTS</Text>
                        <View style={styles.historyCard}>
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
                      </View>
                    ) : null}
                    {settledReceipts.length > 0 ? (
                      <View>
                        <View style={styles.historySubRow}>
                          <Text style={styles.historySubLabelInline}>SETTLED RECEIPTS</Text>
                          <Text style={styles.historyArchiveCount}>{sortedSettledReceipts.length} archived</Text>
                        </View>
                        <View style={styles.historyCard}>
                          {visibleSettledReceipts.map((item, index) => {
                            const name = receiptName(item);
                            const settledWhen = formatSmartDate(item.created_at);
                            return (
                              <View key={item.id}>
                                {index > 0 ? <View style={styles.settledDivider} /> : null}
                                <Pressable
                                  accessibilityRole="button"
                                  accessibilityLabel={name}
                                  onPress={() => {
                                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                    router.push({ pathname: '/receipt/[id]', params: { id: item.id } });
                                  }}
                                  style={({ pressed }) => [styles.settledRow, pressed && styles.settledRowPressed]}
                                >
                                  <View style={styles.settledMonogram}>
                                    <Text style={styles.settledMonogramText}>{monogram(name)}</Text>
                                  </View>
                                  <View style={styles.settledCopy}>
                                    <View style={styles.nameRow}>
                                      <Text style={styles.settledName} numberOfLines={1} ellipsizeMode="tail">{name}</Text>
                                    </View>
                                    <Text style={styles.settledDate} numberOfLines={1} ellipsizeMode="tail">
                                      {settledWhen ? `${settledWhen} · Settled` : 'Settled'}
                                    </Text>
                                  </View>
                                  <View style={styles.settledTrailing}>
                                    <MoneyText amountMinor={toMinorUnits(Number(item.total_amount || 0))} size="sm" color={theme.colors.textSecondary} />
                                    <Ionicons name="chevron-forward" size={14} color={theme.colors.textMuted} />
                                  </View>
                                </Pressable>
                              </View>
                            );
                          })}
                          {sortedSettledReceipts.length > SETTLED_RECEIPTS_PREVIEW_LIMIT ? (
                            <>
                              <View style={styles.settledFooterDivider} />
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={showAllSettledReceipts ? 'Show fewer settled receipts' : `Show ${hiddenSettledCount} more settled receipts`}
                                onPress={toggleSettledReceipts}
                                style={({ pressed }) => [styles.settledFooter, pressed && styles.settledRowPressed]}
                              >
                                <Text style={showAllSettledReceipts ? styles.settledFooterMuted : styles.settledFooterAccent}>
                                  {showAllSettledReceipts
                                    ? 'Show fewer'
                                    : `Show ${hiddenSettledCount} more settled ${hiddenSettledCount === 1 ? 'receipt' : 'receipts'}`}
                                </Text>
                              </Pressable>
                            </>
                          ) : null}
                        </View>
                      </View>
                    ) : null}
                  </>
                )}
              </View>
            ) : null}
          </View>
        </ScrollView>
      )}

      <PaymentSheetModal
        visible={payTarget !== null}
        hostUserId={payTarget?.toUserId ?? null}
        hostName={payTarget ? displayName(members, payTarget.toUserId) : ''}
        amountPence={payTarget?.amountMinor ?? 0}
        reference={groupName}
        onClose={() => setPayTarget(null)}
        onMarkPaid={confirmSheetPaid}
      />

      {groupId ? (
        <AddMemberModal
          visible={addOpen}
          groupId={groupId}
          groupName={groupName}
          onMemberAdded={addMember}
          onClose={() => setAddOpen(false)}
        />
      ) : null}

      <Modal visible={settingsOpen} animationType="fade" transparent statusBarTranslucent onRequestClose={closeSettings}>
        <View style={styles.settingsOverlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            disabled={groupAction !== null}
            style={StyleSheet.absoluteFill}
            onPress={closeSettings}
          />
          <View style={styles.settingsCard}>
            <View style={styles.settingsHeader}>
              <Text style={styles.settingsTitle}>Group Settings</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                disabled={groupAction !== null}
                hitSlop={10}
                onPress={closeSettings}
                style={({ pressed }) => [styles.settingsClose, pressed && styles.settingsClosePressed]}
              >
                <Ionicons name="close" size={15} color={theme.colors.textSecondary} />
              </Pressable>
            </View>

            <Text style={styles.settingsSection}>Danger zone</Text>
            {isCreator ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete Group"
                disabled={groupAction !== null}
                onPress={confirmDeleteGroup}
                style={({ pressed }) => [styles.dangerButton, pressed && groupAction === null && styles.dangerButtonPressed]}
              >
                {groupAction === 'delete' ? (
                  <ActivityIndicator color={theme.colors.danger} />
                ) : (
                  <>
                    <Ionicons name="trash-outline" size={18} color={theme.colors.danger} />
                    <Text style={styles.dangerText}>Delete Group</Text>
                  </>
                )}
              </Pressable>
            ) : isMember ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Leave Group"
                disabled={groupAction !== null}
                onPress={confirmLeaveGroup}
                style={({ pressed }) => [styles.dangerButton, pressed && groupAction === null && styles.dangerButtonPressed]}
              >
                {groupAction === 'leave' ? (
                  <ActivityIndicator color={theme.colors.danger} />
                ) : (
                  <>
                    <Ionicons name="log-out-outline" size={18} color={theme.colors.danger} />
                    <Text style={styles.dangerText}>Leave Group</Text>
                  </>
                )}
              </Pressable>
            ) : (
              <Text style={styles.settingsEmpty}>You are not a member of this group.</Text>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function PersonalStanding({ balance }: { balance: GroupNetBalance }) {
  if (balance.status === 'owed') {
    return (
      <View style={[styles.standingPill, styles.standingOwed]}>
        <Text style={[styles.standingText, styles.standingOwedText]}>{`You're owed ${formatPence(balance.netPence)}`}</Text>
      </View>
    );
  }
  if (balance.status === 'owes') {
    return (
      <View style={[styles.standingPill, styles.standingOwe]}>
        <Text style={[styles.standingText, styles.standingOweText]}>{`You owe ${formatPence(Math.abs(balance.netPence))}`}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.standingPill, styles.standingSettled]}>
      <Text style={styles.standingText}>All settled up</Text>
    </View>
  );
}

function GroupHeroPill({ status }: { status: GroupLedgerStatus }) {
  switch (status.kind) {
    case 'empty':
      return <StatusPill variant="neutral" label="No bills yet" />;
    case 'needs_split':
      return (
        <StatusPill
          variant="warning"
          label={`${status.unsplitActiveCount} ${status.unsplitActiveCount === 1 ? 'bill' : 'bills'} to split`}
        />
      );
    case 'settled':
      return <StatusPill variant="positive" label="All settled up" />;
    case 'balances_owed':
      if (status.userNetBalanceMinor > 0) {
        return <StatusPill variant="positive" label={`You are owed ${formatPence(status.userNetBalanceMinor)}`} />;
      }
      if (status.userNetBalanceMinor < 0) {
        return <StatusPill variant="warning" label={`You owe ${formatPence(Math.abs(status.userNetBalanceMinor))}`} />;
      }
      return (
        <StatusPill
          variant="warning"
          label={`${status.transferCount} ${status.transferCount === 1 ? 'balance' : 'balances'} open`}
        />
      );
  }
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
  standingPill: {
    alignSelf: 'flex-start',
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius.full,
  },
  standingOwed: { backgroundColor: 'rgba(16, 185, 129, 0.14)' },
  standingOwe: { backgroundColor: 'rgba(245, 158, 11, 0.14)' },
  standingSettled: { backgroundColor: theme.colors.surfaceElevated },
  standingText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: theme.colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  standingOwedText: { color: '#10B981' },
  standingOweText: { color: '#F59E0B' },
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
    borderColor: theme.colors.border,
  },
  actionCircleEmpty: { opacity: 0.45 },
  actionCircleSettled: { opacity: 0.55 },
  actionCirclePressed: { backgroundColor: theme.colors.surfaceElevated },
  actionLabel: { marginTop: 6, fontSize: 12, lineHeight: 16, fontWeight: '500', color: theme.colors.textSecondary, textAlign: 'center' },
  actionLabelActive: { color: theme.colors.textPrimary },
  actionLabelSettled: { color: theme.colors.textMuted },
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
  emptyReceiptCard: {
    backgroundColor: '#141417',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 20,
    paddingVertical: 28,
    alignItems: 'center',
  },
  emptyReceiptIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
  },
  emptyReceiptTitle: { marginTop: 12, fontSize: 16, lineHeight: 22, fontWeight: '600', color: theme.colors.textPrimary },
  emptyReceiptBody: { marginTop: 4, fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary, textAlign: 'center' },
  emptyReceiptButton: {
    alignSelf: 'stretch',
    marginTop: 18,
    minHeight: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  emptyReceiptButtonText: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: theme.colors.accentText },
  allSettledCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  allSettledBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.colors.positiveSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  allSettledCopy: { flex: 1, minWidth: 0 },
  allSettledTitle: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: theme.colors.textPrimary },
  allSettledSubtitle: { marginTop: 2, fontSize: 12, lineHeight: 16, color: theme.colors.textMuted },
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
  nameRow: { flexDirection: 'row' },
  receiptName: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '600', color: theme.colors.textPrimary },
  receiptMeta: { ...theme.typography.caption, color: theme.colors.textSecondary, marginTop: 2 },
  historySection: { marginHorizontal: 16, marginTop: 24 },
  historyHeader: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  historyHeaderPressed: { backgroundColor: theme.colors.surfaceElevated },
  historyTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  historyLabel: { ...theme.typography.sectionLabel, color: theme.colors.textSecondary },
  historyCount: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
  },
  historyCountText: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  historyHintRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  historyHint: { fontSize: 12, fontWeight: '500', color: theme.colors.textMuted },
  historyBody: { marginTop: 10, marginBottom: 40, gap: 14 },
  historyEmpty: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  historyEmptyText: { fontSize: 13, color: theme.colors.textMuted },
  historySubLabel: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    color: theme.colors.textMuted,
    marginBottom: 6,
    marginLeft: 4,
  },
  historySubRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  historySubLabelInline: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    color: theme.colors.textMuted,
  },
  historyArchiveCount: { fontSize: 11, color: theme.colors.textMuted },
  historyCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  settledDivider: { height: StyleSheet.hairlineWidth, marginLeft: 58, backgroundColor: theme.colors.border },
  settledRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  settledRowPressed: { backgroundColor: theme.colors.surfaceElevated },
  settledMonogram: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settledMonogramText: { color: theme.colors.textSecondary, fontSize: 14, fontWeight: '600' },
  settledCopy: { flex: 1, minWidth: 0, marginLeft: 10, marginRight: 8 },
  settledName: { flex: 1, fontSize: 14, fontWeight: '500', color: theme.colors.textSecondary },
  settledDate: { fontSize: 12, color: theme.colors.textMuted, marginTop: 2 },
  settledTrailing: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  settledFooterDivider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border },
  settledFooter: { paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  settledFooterAccent: { fontSize: 13, fontWeight: '600', color: theme.colors.accent },
  settledFooterMuted: { fontSize: 13, fontWeight: '600', color: theme.colors.textSecondary },
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
  settingsOverlay: {
    flex: 1,
    backgroundColor: theme.colors.scrim,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  settingsCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    padding: 20,
  },
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  settingsTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: theme.colors.textPrimary,
  },
  settingsClose: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
  },
  settingsClosePressed: { backgroundColor: theme.colors.surfacePressed },
  settingsSection: {
    ...theme.typography.sectionLabel,
    color: theme.colors.textMuted,
    marginTop: 22,
    marginBottom: 10,
  },
  dangerButton: {
    height: 48,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: theme.colors.dangerSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.dangerMutedBorder,
  },
  dangerButtonPressed: { opacity: 0.75 },
  dangerText: {
    color: theme.colors.danger,
    fontSize: 15,
    fontWeight: '700',
  },
  settingsEmpty: { ...theme.typography.caption, color: theme.colors.textSecondary },
});
