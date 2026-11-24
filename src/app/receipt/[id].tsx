import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AvatarBadge } from '@/components/AvatarBadge';
import { MoneyText } from '@/components/MoneyText';
import { useSupabaseSession } from '@/lib/use-session';
import { groupService, type GroupMemberProfile } from '@/services/GroupService';
import { listRecentNudgedRecipients, sendSettlementNudge } from '@/services/NotificationService';
import { getSignedReceiptImageUrl } from '@/services/ReceiptImageService';
import { receiptService } from '@/services/ReceiptService';
import { theme } from '@/theme/theme';
import type { Item, Receipt, Split } from '@/types/database.types';
import { mapErrorToUserMessage, mapSettlementNudgeError } from '@/utils/errorMapper';
import { logger } from '@/utils/logger';
import { allocateByItems, extrasMinor, formatPence, toMinorUnits } from '@/utils/money';
import { parseGBPToPence, penceToPounds } from '@/utils/manualBill';
import { receiptDiscrepancy, splitExtrasMinor } from '@/utils/receiptReconciliation';
import { createTapId } from '@/utils/notifications';

type LedgerReceipt = Receipt & {
  restaurant_name?: string | null;
  website?: string | null;
};

type Ledger = {
  receipt: LedgerReceipt;
  items: Item[];
  splits: Split[];
};

type Assignee = {
  id: string;
  name: string;
};

const LedgerItem = memo(function LedgerItem({
  item,
  priceMinor,
  highlighted,
  assignees,
  activeMemberId,
  onToggle,
}: {
  item: Item;
  priceMinor: number;
  highlighted: boolean;
  assignees: Assignee[];
  activeMemberId: string | null;
  onToggle: (id: string) => void;
}) {
  const quantity = Number(item.quantity);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: highlighted }}
      onPress={() => onToggle(item.id)}
      style={({ pressed }) => [styles.itemRow, pressed && styles.itemRowPressed, highlighted && styles.itemRowSelected]}
    >
      <View style={styles.itemTop}>
        <View style={styles.itemIdentity}>
          {quantity > 1 ? (
            <View style={styles.quantityPill}>
              <Text style={styles.quantityText}>{quantity}x</Text>
            </View>
          ) : null}
          <Text style={styles.itemName} numberOfLines={2}>{item.display_name || item.original_name}</Text>
        </View>
        <MoneyText amountMinor={priceMinor} size="md" color={theme.colors.textPrimary} />
      </View>
      {assignees.length > 0 ? (
        <View style={styles.assigneeRow}>
          {assignees.map((person) => (
            <AvatarBadge
              key={person.id}
              name={person.name}
              userId={person.id}
              size={20}
              active={person.id === activeMemberId}
            />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
});

export default function ReceiptLedgerScreen() {
  const router = useRouter();
  const { session } = useSupabaseSession();
  const { id: idParam } = useLocalSearchParams<{ id?: string | string[] }>();
  const receiptId = Array.isArray(idParam) ? idParam[0] : idParam;

  const [receiptData, setReceiptData] = useState<Ledger | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(receiptId));
  const [notFound, setNotFound] = useState(!receiptId);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<GroupMemberProfile[]>([]);
  const [claims, setClaims] = useState<Record<string, string[]>>({});
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null);
  const [paidById, setPaidById] = useState<string | null>(null);
  const [savedShares, setSavedShares] = useState<Record<string, number>>({});
  const [nudgedRecipients, setNudgedRecipients] = useState<string[]>([]);
  const [nudgingId, setNudgingId] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [togglingSettled, setTogglingSettled] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [splitBasis, setSplitBasis] = useState<'items' | 'receipt'>('receipt');
  const [adjustMode, setAdjustMode] = useState<'add' | 'edit' | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftPrice, setDraftPrice] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const viewerGeneration = useRef(0);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    return () => {
      viewerGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!receiptId) return;
    const id = receiptId;
    let cancelled = false;

    async function loadLedger() {
      try {
        const data = await receiptService.getReceiptWithItems(id);
        if (cancelled) return;
        if (!data) {
          setReceiptData(null);
          setNotFound(true);
          return;
        }
        setReceiptData(data);
        setNotFound(false);

        if (!data.receipt.group_id) {
          setMembers([]);
          setClaims({});
          setSavedShares({});
          setPaidById(null);
          setActiveMemberId(null);
          setGroupError(null);
          return;
        }

        try {
          const [roster, savedSplits] = await Promise.all([
            groupService.getGroupMembers(data.receipt.group_id),
            receiptService.getReceiptSplits(data.receipt.id),
          ]);
          if (cancelled) return;
          const memberIds = new Set(roster.map((member) => member.userId));
          const nextClaims: Record<string, string[]> = {};
          for (const split of savedSplits) {
            if (!memberIds.has(split.user_id)) continue;
            for (const itemId of split.item_ids) {
              const existing = nextClaims[itemId] ?? [];
              if (!existing.includes(split.user_id)) existing.push(split.user_id);
              nextClaims[itemId] = existing;
            }
          }
          const preferred = preferredMemberId(data.receipt, roster);
          const shareMap: Record<string, number> = {};
          for (const split of savedSplits) {
            if (!memberIds.has(split.user_id)) continue;
            shareMap[split.user_id] = (shareMap[split.user_id] ?? 0) + split.amount_minor;
          }
          setMembers(roster);
          setClaims(nextClaims);
          setSavedShares(shareMap);
          setPaidById(preferred);
          setActiveMemberId(preferred);
          setGroupError(null);
        } catch (error) {
          if (cancelled) return;
          logger.error('receipt', { code: 'GROUP_FAILED' });
          setMembers([]);
          setClaims({});
          setSavedShares({});
          setPaidById(null);
          setActiveMemberId(null);
          setGroupError('Could not load this group.');
        }
      } catch (error) {
        if (!cancelled) logger.error('receipt', { code: 'LEDGER_FAILED' });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void loadLedger();
    return () => {
      cancelled = true;
    };
  }, [receiptId]);

  useEffect(() => {
    if (!receiptId || !session?.user.id) return;
    let cancelled = false;
    void listRecentNudgedRecipients(receiptId)
      .then((ids) => {
        if (!cancelled) setNudgedRecipients(ids);
      })
      .catch(() => {
        if (!cancelled) logger.error('notifications', { code: 'NUDGE_LIST_FAILED' });
      });
    return () => {
      cancelled = true;
    };
  }, [receiptId, session?.user.id]);

  const sendNudge = useCallback(async (recipientId: string) => {
    if (!receiptData || nudgingId) return;
    const tapId = createTapId();
    setNudgingId(recipientId);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const result = await sendSettlementNudge(receiptData.receipt.id, recipientId, tapId);
      if (result.sent || result.reason === 'NUDGE_COOLDOWN') {
        setNudgedRecipients((current) => (current.includes(recipientId) ? current : [...current, recipientId]));
      }
      if (result.sent) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert('Reminder not sent', result.message || 'Could not send that reminder. Please try again.');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'NUDGE_COOLDOWN') {
        setNudgedRecipients((current) => (current.includes(recipientId) ? current : [...current, recipientId]));
      }
      logger.error('notifications', { code: code || 'NUDGE_FAILED' });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Reminder not sent', mapSettlementNudgeError(error));
    } finally {
      setNudgingId(null);
    }
  }, [nudgingId, receiptData]);

  const toggleItem = useCallback((itemId: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);

  const toggleAssignment = useCallback((itemId: string) => {
    if (!activeMemberId) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSaved(false);
    setSaveError(null);
    setClaims((current) => {
      const existing = current[itemId] ?? [];
      const next = existing.includes(activeMemberId)
        ? existing.filter((id) => id !== activeMemberId)
        : [...existing, activeMemberId];
      return { ...current, [itemId]: next };
    });
  }, [activeMemberId]);

  const splitEqually = useCallback(() => {
    if (!receiptData || members.length === 0) return;
    const ids = members.map((member) => member.userId);
    const next: Record<string, string[]> = {};
    for (const item of receiptData.items) next[item.id] = [...ids];
    setClaims(next);
    setSaved(false);
    setSaveError(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [members, receiptData]);

  const saveSplit = useCallback(async () => {
    if (!receiptData || !paidById || members.length === 0 || saving) return;
    const memberIds = members.map((member) => member.userId);
    const shares = memberShares(receiptData.items, claims, memberIds, receiptData.receipt, splitBasis);
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await receiptService.saveReceiptSplits(
        receiptData.receipt.id,
        paidById,
        memberIds.map((userId) => ({
          user_id: userId,
          amount_minor: shares[userId] ?? 0,
          item_ids: receiptData.items.filter((item) => (claims[item.id] ?? []).includes(userId)).map((item) => item.id),
        })),
      );
      setReceiptData((current) => (
        current ? { ...current, receipt: { ...current.receipt, paid_by: paidById } } : current
      ));
      setSavedShares(shares);
      setSaved(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      logger.error('receipt', { code: 'SAVE_FAILED' });
      setSaveError(mapErrorToUserMessage(error, 'Could not save this split.'));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSaving(false);
    }
  }, [claims, members, paidById, receiptData, saving, splitBasis]);

  const closeViewer = useCallback(() => {
    viewerGeneration.current += 1;
    setViewerOpen(false);
    setSignedUrl(null);
    setViewerError(null);
    setViewerLoading(false);
  }, []);

  const openOriginal = useCallback(async (imagePath: string) => {
    const generation = viewerGeneration.current + 1;
    viewerGeneration.current = generation;
    setViewerOpen(true);
    setSignedUrl(null);
    setViewerError(null);
    setViewerLoading(true);
    try {
      const url = await getSignedReceiptImageUrl(imagePath);
      if (viewerGeneration.current !== generation) return;
      setSignedUrl(url);
    } catch (error) {
      if (viewerGeneration.current !== generation) return;
      logger.error('receipt', { code: 'IMAGE_SIGN_FAILED' });
      setViewerError(mapErrorToUserMessage(error, 'Could not open the receipt photo.'));
    } finally {
      if (viewerGeneration.current === generation) setViewerLoading(false);
    }
  }, []);

  const goBack = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  if (isLoading) {
    return (
      <View style={styles.container}>
        <SafeAreaView edges={['top']} style={styles.headerSafe}>
          <View style={styles.headerRow}>
            <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={goBack} hitSlop={12}>
              <Ionicons name="chevron-back" size={22} color={theme.colors.textPrimary} />
            </Pressable>
          </View>
        </SafeAreaView>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.colors.accent} />
        </View>
      </View>
    );
  }

  if (notFound || !receiptData) {
    return (
      <View style={styles.container}>
        <SafeAreaView edges={['top']} style={styles.headerSafe}>
          <View style={styles.headerRow}>
            <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={goBack} hitSlop={12} style={styles.backRow}>
              <Ionicons name="chevron-back" size={22} color={theme.colors.textPrimary} />
              <Text style={styles.backLabel}>Back</Text>
            </Pressable>
          </View>
        </SafeAreaView>
        <View style={styles.center}>
          <Text style={styles.missingTitle}>Receipt not found</Text>
          <Text style={styles.missingSubtitle}>This receipt was deleted or is no longer available.</Text>
        </View>
      </View>
    );
  }

  const { receipt, items } = receiptData;
  const isGroup = Boolean(receipt.group_id);
  const people = members.map((member) => toAssignee(member));
  const activeMember = people.find((person) => person.id === activeMemberId) ?? null;
  const memberIds = members.map((member) => member.userId);
  const shares = isGroup ? memberShares(items, claims, memberIds, receipt, splitBasis) : {};
  const unassigned = isGroup ? unassignedMinor(items, claims) : 0;
  const isTaxIncluded = receiptExtrasMinor(items, receipt) === 0 && Number(receipt.tax_amount || 0) > 0;
  const merchantName = receipt.restaurant_name || receipt.merchant_name || 'Ledger';
  const receiptDate = new Date(receipt.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const lineTotalMinor = items.reduce((sum, item) => sum + lineMinor(item), 0);
  const receiptTotalMinor = toMinorUnits(Number(receipt.total_amount || 0));
  const discrepancy = receiptDiscrepancy(lineTotalMinor, receiptTotalMinor);
  const differenceLabel = discrepancy.differenceMinor > 0
    ? `${formatPence(discrepancy.differenceMinor)} short of the receipt`
    : `${formatPence(Math.abs(discrepancy.differenceMinor))} over the receipt`;
  const assignedMinor = Math.max(0, lineTotalMinor - unassigned);
  const progress = Math.min(100, Math.round((assignedMinor / Math.max(1, lineTotalMinor)) * 100));
  const blocked = isGroup && unassigned > 0;
  const saveDisabled = saving || blocked || !paidById || members.length === 0;

  async function refreshSubtotal(nextItems: Item[]) {
    const nextMinor = nextItems.reduce((sum, item) => sum + lineMinor(item), 0);
    const updated = await receiptService.updateReceiptTotals(receipt.id, { subtotal: penceToPounds(nextMinor) });
    setReceiptData((current) => current ? { ...current, receipt: { ...current.receipt, ...updated }, items: nextItems } : current);
    setSaved(false);
  }

  async function commitAdjustment() {
    if (adjusting) return;
    const pricePence = parseGBPToPence(draftPrice);
    if (pricePence == null) {
      setAdjustError('Enter a price in pounds.');
      return;
    }
    setAdjusting(true);
    setAdjustError(null);
    try {
      if (adjustMode === 'add') {
        const name = draftName.trim();
        if (!name) {
          setAdjustError('Name the missing item.');
          setAdjusting(false);
          return;
        }
        const created = await receiptService.addScannedItems(receipt.id, [{
          original_name: name,
          display_name: name,
          price: penceToPounds(pricePence),
          quantity: 1,
          is_tax_exempt: false,
        }]);
        await refreshSubtotal([...items, ...created]);
      } else if (editingItemId) {
        await receiptService.updateItemPrice(editingItemId, penceToPounds(pricePence));
        const nextItems = items.map((item) => item.id === editingItemId ? { ...item, price: penceToPounds(pricePence) } : item);
        await refreshSubtotal(nextItems);
      }
      setAdjustMode(null);
      setDraftName('');
      setDraftPrice('');
      setEditingItemId(null);
    } catch (error) {
      logger.error('receipt', { code: 'RECONCILE_FAILED' });
      setAdjustError(mapErrorToUserMessage(error, 'Could not update the bill.'));
    } finally {
      setAdjusting(false);
    }
  }

  function askMarkSettled() {
    if (togglingSettled) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const sharedGroup = Boolean(receipt.group_id) && members.length > 1;
    Alert.alert(
      'Mark receipt as settled?',
      sharedGroup
        ? 'This archives the receipt into Settlement History to keep your active list clean. It will not change group cash balances—record a payment in Balances to clear debts.'
        : 'This moves the receipt out of Active Receipts and into Settlement History. You can reopen it anytime.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Mark Settled', onPress: () => { void commitSettled(true); } },
      ],
    );
  }

  function askReopen() {
    if (togglingSettled) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert('Move this receipt back to Active Receipts?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reopen', onPress: () => { void commitSettled(false); } },
    ]);
  }

  async function commitSettled(settled: boolean) {
    if (togglingSettled) return;
    const previous = receipt;
    setTogglingSettled(true);
    setReceiptData((current) => (
      current
        ? {
          ...current,
          receipt: {
            ...current.receipt,
            settled_at: settled ? new Date().toISOString() : null,
            settled_by: settled ? session?.user.id ?? current.receipt.settled_by : null,
          },
        }
        : current
    ));
    try {
      const updated = await receiptService.setReceiptSettled(receipt.id, settled);
      setReceiptData((current) => (
        current ? { ...current, receipt: { ...current.receipt, settled_at: updated.settled_at, settled_by: updated.settled_by, status: updated.status } } : current
      ));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (settled) router.back();
    } catch (error) {
      setReceiptData((current) => (current ? { ...current, receipt: previous } : current));
      logger.error('receipt', { code: 'ARCHIVE_FAILED' });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not update receipt', mapErrorToUserMessage(error, 'Try again.'));
    } finally {
      setTogglingSettled(false);
    }
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false, title: merchantName }} />

      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.headerRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={goBack} hitSlop={12}>
            <Ionicons name="chevron-back" size={22} color={theme.colors.textPrimary} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle} numberOfLines={1}>{merchantName}</Text>
            <Text style={styles.headerDate} numberOfLines={1}>{receiptDate}</Text>
          </View>
          <View style={styles.headerTrail}>
            <MoneyText amountMinor={toMinorUnits(Number(receipt.total_amount || 0))} size="sm" color={theme.colors.textPrimary} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={receipt.settled_at ? 'Settled' : 'Mark Settled'}
              accessibilityState={{ busy: togglingSettled }}
              disabled={togglingSettled}
              onPress={receipt.settled_at ? askReopen : askMarkSettled}
              style={({ pressed }) => [
                styles.settlePill,
                receipt.settled_at ? styles.settlePillDone : null,
                pressed && !receipt.settled_at && styles.settlePillPressed,
              ]}
            >
              {togglingSettled ? (
                <ActivityIndicator size="small" color={receipt.settled_at ? '#FFFFFF' : theme.colors.textPrimary} />
              ) : (
                <>
                  <Ionicons
                    name={receipt.settled_at ? 'checkmark-circle' : 'checkmark-circle-outline'}
                    size={14}
                    color={receipt.settled_at ? '#FFFFFF' : theme.colors.positive}
                  />
                  <Text style={[styles.settlePillText, receipt.settled_at && styles.settlePillTextDone]}>
                    {receipt.settled_at ? 'Settled' : 'Mark Settled'}
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
        {isGroup ? (
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${progress}%`,
                  backgroundColor: unassigned === 0 ? theme.colors.positive : theme.colors.accent,
                },
              ]}
            />
          </View>
        ) : null}
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {receipt.image_path ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="View original receipt"
            onPress={() => {
              const imagePath = receipt.image_path;
              if (!imagePath) return;
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              void openOriginal(imagePath);
            }}
            style={({ pressed }) => [styles.originalButton, pressed && styles.originalButtonPressed]}
          >
            <Ionicons name="receipt-outline" size={18} color={theme.colors.textPrimary} />
            <Text style={styles.originalButtonText}>View Original Receipt</Text>
          </Pressable>
        ) : null}

        {receipt.website ? (
          <Pressable
            accessibilityRole="link"
            onPress={() => Linking.openURL(receipt.website!.startsWith('http') ? receipt.website! : `https://${receipt.website}`)}
            style={styles.bookLink}
          >
            <Text style={styles.bookLinkText}>Book again</Text>
          </Pressable>
        ) : null}

        {isGroup ? (
          <View>
            <View style={styles.block}>
              <Text style={[styles.sectionLabel, styles.paidLabel]}>Paid by</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillScroller}>
                {people.map((person) => {
                  const selected = person.id === paidById;
                  return (
                    <Pressable
                      key={person.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => {
                        setPaidById(person.id);
                        setSaved(false);
                        setSaveError(null);
                        void Haptics.selectionAsync();
                      }}
                      style={[styles.paidPill, selected && styles.paidPillSelected]}
                    >
                      <Text style={[styles.paidPillText, selected && styles.paidPillTextSelected]}>{person.name}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>

            <View style={styles.assignBlock}>
              <View style={styles.assignHeader}>
                <Text style={styles.sectionLabel}>Assign to</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={splitEqually}
                  style={({ pressed }) => [styles.equalPill, pressed && styles.equalPillPressed]}
                >
                  <Text style={styles.equalText}>Split equally</Text>
                </Pressable>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.memberScroller}>
                {people.map((person) => {
                  const selected = person.id === activeMemberId;
                  const share = shares[person.id] ?? 0;
                  const creditorId = paidById ?? receipt.host_id;
                  const alreadyNudged = nudgedRecipients.includes(person.id);
                  const showNudge = session?.user.id === receipt.host_id
                    && !receipt.settled_at
                    && person.id !== session.user.id
                    && person.id !== creditorId
                    && (savedShares[person.id] ?? 0) > 0;
                  return (
                    <View key={person.id} style={styles.memberSlot}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${person.name}, ${formatPence(share)}`}
                        accessibilityState={{ selected }}
                        onPress={() => {
                          setActiveMemberId(person.id);
                          void Haptics.selectionAsync();
                        }}
                        style={[styles.memberCard, selected ? styles.memberCardActive : styles.memberCardIdle]}
                      >
                        <AvatarBadge name={person.name} userId={person.id} size={28} active={selected} />
                        <View style={styles.memberCopy}>
                          <Text style={styles.memberName} numberOfLines={1}>{person.name}</Text>
                          <MoneyText
                            amountMinor={share}
                            size="sm"
                            color={share > 0 ? theme.colors.textPrimary : theme.colors.textSecondary}
                          />
                        </View>
                      </Pressable>
                      {showNudge ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={alreadyNudged ? 'Nudged' : `Nudge ${person.name}`}
                          accessibilityState={{ disabled: alreadyNudged || nudgingId !== null, busy: nudgingId === person.id }}
                          disabled={alreadyNudged || nudgingId !== null}
                          onPress={() => {
                            void sendNudge(person.id);
                          }}
                          style={({ pressed }) => [
                            styles.nudgePill,
                            alreadyNudged && styles.nudgePillDone,
                            pressed && !alreadyNudged && styles.nudgePillPressed,
                          ]}
                        >
                          {nudgingId === person.id ? (
                            <ActivityIndicator size="small" color={theme.colors.accentText} />
                          ) : (
                            <Text style={[styles.nudgePillText, alreadyNudged && styles.nudgePillTextDone]}>{alreadyNudged ? 'Nudged' : 'Nudge'}</Text>
                          )}
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
            </View>

            <Text style={styles.assignHint}>
              {activeMember ? `Tap any item below to assign it to ${activeMember.name}` : 'Choose a person, then tap a line.'}
            </Text>
            {groupError ? <Text style={styles.errorText}>{groupError}</Text> : null}
          </View>
        ) : null}

        {!discrepancy.matches ? (
          <View style={styles.reconcile}>
            <Text style={styles.reconcileTitle}>Lines and total do not match</Text>
            <Text style={styles.reconcileBody}>
              {`Sum of items ${formatPence(discrepancy.itemsMinor)}. Receipt total ${formatPence(discrepancy.receiptTotalMinor)}. ${differenceLabel}.`}
            </Text>
            <View style={styles.reconcileActions}>
              <Pressable accessibilityRole="button" accessibilityLabel="Add a missing item" onPress={() => { setAdjustMode('add'); setAdjustError(null); }} style={styles.reconcileChip}>
                <Text style={styles.reconcileChipText}>Add item</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Edit an item price" onPress={() => { setAdjustMode('edit'); setAdjustError(null); }} style={styles.reconcileChip}>
                <Text style={styles.reconcileChipText}>Edit price</Text>
              </Pressable>
            </View>
            <View style={styles.reconcileActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: splitBasis === 'items' }}
                onPress={() => { setSplitBasis('items'); setSaved(false); }}
                style={[styles.reconcileChip, splitBasis === 'items' && styles.reconcileChipOn]}
              >
                <Text style={[styles.reconcileChipText, splitBasis === 'items' && styles.reconcileChipTextOn]}>Split itemised sum</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: splitBasis === 'receipt' }}
                onPress={() => { setSplitBasis('receipt'); setSaved(false); }}
                style={[styles.reconcileChip, splitBasis === 'receipt' && styles.reconcileChipOn]}
              >
                <Text style={[styles.reconcileChipText, splitBasis === 'receipt' && styles.reconcileChipTextOn]}>Split receipt total</Text>
              </Pressable>
            </View>
            {adjustMode === 'edit' ? (
              <View style={styles.reconcileList}>
                {items.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    onPress={() => setEditingItemId(item.id)}
                    style={[styles.reconcileChoice, editingItemId === item.id && styles.reconcileChipOn]}
                  >
                    <Text style={styles.reconcileChoiceText} numberOfLines={1}>{item.display_name || item.original_name}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {adjustMode === 'add' || (adjustMode === 'edit' && editingItemId) ? (
              <View style={styles.reconcileForm}>
                {adjustMode === 'add' ? (
                  <TextInput
                    accessibilityLabel="Missing item name"
                    placeholder="Item"
                    placeholderTextColor={theme.colors.textMuted}
                    value={draftName}
                    onChangeText={setDraftName}
                    style={styles.reconcileInput}
                  />
                ) : null}
                <TextInput
                  accessibilityLabel="Item price"
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                  placeholderTextColor={theme.colors.textMuted}
                  value={draftPrice}
                  onChangeText={setDraftPrice}
                  style={styles.reconcileInput}
                />
                <Pressable accessibilityRole="button" accessibilityLabel="Save adjustment" disabled={adjusting} onPress={() => { void commitAdjustment(); }} style={styles.reconcileSave}>
                  <Text style={styles.reconcileSaveText}>{adjusting ? 'Saving' : 'Save'}</Text>
                </Pressable>
              </View>
            ) : null}
            {adjustError ? <Text style={styles.reconcileError}>{adjustError}</Text> : null}
          </View>
        ) : null}

        <View style={styles.ledger}>
          {items.map((item, index) => {
            const assigned = people.filter((person) => (claims[item.id] ?? []).includes(person.id));
            const highlighted = isGroup
              ? (claims[item.id] ?? []).includes(activeMemberId ?? '')
              : selectedItemIds.has(item.id);
            return (
              <View key={item.id}>
                {index > 0 ? <View style={styles.itemDivider} /> : null}
                <LedgerItem
                  item={item}
                  priceMinor={isGroup ? lineMinor(item) : toMinorUnits(Number(item.price))}
                  highlighted={highlighted && !isGroup}
                  assignees={isGroup ? assigned : []}
                  activeMemberId={activeMemberId}
                  onToggle={isGroup ? toggleAssignment : toggleItem}
                />
              </View>
            );
          })}

          <View style={styles.footerDivider} />
          <View style={styles.footer}>
            <View style={styles.totalRow}>
              <Text style={styles.metaLabel}>Subtotal</Text>
              <MoneyText amountMinor={toMinorUnits(Number(receipt.subtotal || 0))} size="sm" color={theme.colors.textSecondary} />
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.metaLabel}>{isTaxIncluded ? 'Tax included' : 'Tax'}</Text>
              <MoneyText amountMinor={toMinorUnits(Number(receipt.tax_amount || 0))} size="sm" color={theme.colors.textSecondary} />
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.metaLabel}>Service Charge</Text>
              <MoneyText amountMinor={toMinorUnits(Number(receipt.service_charge || 0))} size="sm" color={theme.colors.textSecondary} />
            </View>
            {Number(receipt.tip_amount) > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.metaLabel}>Tip</Text>
                <MoneyText amountMinor={toMinorUnits(Number(receipt.tip_amount))} size="sm" color={theme.colors.textSecondary} />
              </View>
            ) : null}
            <View style={styles.grandRow}>
              <Text style={styles.grandLabel}>Total</Text>
              <MoneyText amountMinor={toMinorUnits(Number(receipt.total_amount || 0))} size="lg" color={theme.colors.textPrimary} />
            </View>
            {unassigned > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.unassignedLabel}>Unassigned</Text>
                <MoneyText amountMinor={unassigned} size="sm" color={theme.colors.warning} />
              </View>
            ) : null}
          </View>
        </View>
      </ScrollView>

      <SafeAreaView edges={['bottom']} style={styles.bottomBar}>
        {saveError ? <Text style={styles.barError}>{saveError}</Text> : null}
        {isGroup ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: saveDisabled, busy: saving }}
            disabled={saveDisabled}
            onPress={() => {
              void saveSplit();
            }}
            style={({ pressed }) => [
              styles.cta,
              saving && styles.ctaSaving,
              !saving && blocked && styles.ctaBlocked,
              !saving && !blocked && saved && styles.ctaSaved,
              !saving && !blocked && !saved && styles.ctaReady,
              !saving && !blocked && !saved && pressed && styles.ctaReadyPressed,
              saveDisabled && !saving && !blocked && !saved && styles.ctaUnavailable,
            ]}
          >
            {saving ? (
              <ActivityIndicator color={theme.colors.accentText} />
            ) : blocked ? (
              <Text style={styles.ctaBlockedText}>{formatPence(unassigned)} left to assign</Text>
            ) : saved ? (
              <Text style={styles.ctaSavedText}>Split Saved ✓</Text>
            ) : (
              <Text style={styles.ctaReadyText}>Save Split</Text>
            )}
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/split', params: { id: receiptId } })}
            style={({ pressed }) => [styles.cta, styles.ctaReady, pressed && styles.ctaReadyPressed]}
          >
            <Text style={styles.ctaReadyText}>Continue to Split</Text>
          </Pressable>
        )}
        {isGroup ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/split', params: { id: receiptId } })}
            style={styles.continueLink}
          >
            <Text style={styles.continueLinkText}>Continue to Split</Text>
          </Pressable>
        ) : null}
      </SafeAreaView>
      <Modal
        visible={viewerOpen}
        animationType="fade"
        transparent
        statusBarTranslucent
        onRequestClose={closeViewer}
      >
        <View style={styles.viewer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss receipt photo"
            style={StyleSheet.absoluteFill}
            onPress={closeViewer}
          />
          {viewerLoading ? (
            <View pointerEvents="none" style={styles.viewerCenter}>
              <ActivityIndicator accessibilityLabel="Loading receipt photo" color={theme.colors.textPrimary} size="large" />
            </View>
          ) : null}
          {viewerError ? (
            <View pointerEvents="box-none" style={styles.viewerCenter}>
              <Text style={styles.viewerError}>{viewerError}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry receipt photo"
                onPress={() => {
                  const imagePath = receipt.image_path;
                  if (!imagePath) return;
                  void openOriginal(imagePath);
                }}
                style={({ pressed }) => [styles.viewerRetry, pressed && styles.originalButtonPressed]}
              >
                <Text style={styles.viewerRetryText}>Retry</Text>
              </Pressable>
            </View>
          ) : null}
          {signedUrl ? (
            <ScrollView
              pointerEvents="box-none"
              style={styles.viewerScroll}
              contentContainerStyle={styles.viewerScrollContent}
              maximumZoomScale={4}
              minimumZoomScale={1}
              centerContent
              bouncesZoom
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
            >
              <View
                onStartShouldSetResponder={() => true}
                style={styles.viewerImageFrame}
              >
                <Image
                  accessibilityLabel="Original receipt"
                  source={{ uri: signedUrl }}
                  style={{ width: windowWidth, height: Math.max(windowHeight - insets.top - insets.bottom - 120, 240) }}
                  contentFit="contain"
                  onError={() => {
                    setSignedUrl(null);
                    setViewerError(mapErrorToUserMessage(new Error('This receipt photo link expired. Try again.'), 'Could not open the receipt photo.'));
                  }}
                />
              </View>
            </ScrollView>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close receipt photo"
            hitSlop={12}
            onPress={closeViewer}
            style={({ pressed }) => [
              styles.viewerClose,
              { top: Math.max(insets.top, 16) + 8 },
              pressed && styles.viewerClosePressed,
            ]}
          >
            <Ionicons name="close" size={22} color={theme.colors.textPrimary} />
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

function preferredMemberId(receipt: Receipt, roster: GroupMemberProfile[]) {
  const preferred = receipt.paid_by ?? receipt.host_id;
  if (roster.some((member) => member.userId === preferred)) return preferred;
  if (roster.some((member) => member.userId === receipt.host_id)) return receipt.host_id;
  return roster[0]?.userId ?? null;
}

function toAssignee(member: GroupMemberProfile): Assignee {
  return {
    id: member.userId,
    name: member.fullName,
  };
}

function lineMinor(item: Item) {
  return toMinorUnits(item.price) * item.quantity;
}

function receiptExtrasMinor(items: Item[], receipt: Receipt) {
  return extrasMinor(items.reduce((sum, item) => sum + lineMinor(item), 0), toMinorUnits(receipt.total_amount));
}

function memberShares(
  items: Item[],
  claims: Record<string, string[]>,
  memberIds: string[],
  receipt: Receipt,
  basis: 'items' | 'receipt',
) {
  const lines = items.reduce((sum, item) => sum + lineMinor(item), 0);
  return allocateByItems(
    items.map((item) => ({
      id: item.id,
      priceMinor: lineMinor(item),
      assignedUserIds: claims[item.id] ?? [],
    })),
    splitExtrasMinor(lines, toMinorUnits(receipt.total_amount), basis),
    memberIds,
  );
}

function unassignedMinor(items: Item[], claims: Record<string, string[]>) {
  return items.reduce((sum, item) => ((claims[item.id] ?? []).length === 0 ? sum + lineMinor(item) : sum), 0);
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.canvas },
  headerSafe: { backgroundColor: theme.colors.canvas },
  headerRow: {
    minHeight: 52,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  backLabel: { ...theme.typography.body, color: theme.colors.textSecondary },
  headerCenter: { flex: 1, minWidth: 0, marginHorizontal: 12 },
  headerTitle: { fontSize: 16, lineHeight: 20, fontWeight: '600', color: theme.colors.textPrimary },
  headerDate: { marginTop: 1, fontSize: 12, lineHeight: 16, color: theme.colors.textMuted },
  headerTrail: { alignItems: 'flex-end', gap: 6 },
  progressTrack: { height: 3, width: '100%', backgroundColor: theme.colors.surfaceElevated },
  progressFill: { height: 3 },
  settlePill: {
    height: 28,
    paddingHorizontal: 10,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  settlePillDone: {
    backgroundColor: '#10B981',
    borderColor: '#10B981',
  },
  settlePillPressed: { backgroundColor: theme.colors.surfacePressed },
  settlePillText: { fontSize: 12, fontWeight: '700', color: theme.colors.textPrimary },
  settlePillTextDone: { color: '#FFFFFF' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  missingTitle: { ...theme.typography.screenTitle, color: theme.colors.textPrimary, fontSize: 24, lineHeight: 30, textAlign: 'center' },
  missingSubtitle: { ...theme.typography.body, color: theme.colors.textSecondary, marginTop: 8, textAlign: 'center' },
  scrollContent: { paddingTop: 16, paddingBottom: 120 },
  originalButton: {
    marginHorizontal: 16,
    marginBottom: 16,
    minHeight: 48,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  originalButtonPressed: { backgroundColor: theme.colors.surfacePressed },
  originalButtonText: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: theme.colors.textPrimary },
  viewer: { flex: 1, backgroundColor: '#000000' },
  viewerClose: {
    position: 'absolute',
    right: 16,
    zIndex: 50,
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
  },
  viewerClosePressed: { backgroundColor: theme.colors.surfacePressed },
  viewerCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 16 },
  viewerError: { color: theme.colors.textSecondary, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  viewerRetry: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
  },
  viewerRetryText: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' },
  viewerScroll: { flex: 1 },
  viewerScrollContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  viewerImageFrame: { alignItems: 'center', justifyContent: 'center' },
  bookLink: { alignSelf: 'flex-start', marginLeft: 16, marginBottom: 16, paddingVertical: 4 },
  bookLinkText: { color: theme.colors.accent, fontSize: 13, fontWeight: '600' },
  block: { marginBottom: 18 },
  sectionLabel: { ...theme.typography.sectionLabel, color: theme.colors.textMuted },
  paidLabel: { marginBottom: 8, marginHorizontal: 16 },
  pillScroller: { paddingHorizontal: 16, gap: 8 },
  paidPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  paidPillSelected: {
    backgroundColor: theme.colors.accentSubtle,
    borderWidth: 1,
    borderColor: theme.colors.accentBorder,
  },
  paidPillText: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 18, fontWeight: '500' },
  paidPillTextSelected: { color: theme.colors.accent, fontWeight: '600' },
  assignBlock: { marginBottom: 18 },
  assignHeader: {
    paddingHorizontal: 16,
    marginBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  equalPill: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.radius.full,
  },
  equalPillPressed: { backgroundColor: theme.colors.surfacePressed },
  equalText: { color: theme.colors.accent, fontSize: 12, lineHeight: 16, fontWeight: '600' },
  memberScroller: { paddingHorizontal: 16, gap: 10 },
  memberSlot: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nudgePill: {
    height: 28,
    paddingHorizontal: 10,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 64,
  },
  nudgePillPressed: { backgroundColor: theme.colors.accentPressed },
  nudgePillDone: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
  },
  nudgePillText: { color: theme.colors.accentText, fontSize: 12, fontWeight: '700' },
  nudgePillTextDone: { color: theme.colors.textSecondary, fontWeight: '600' },
  memberCard: {
    minWidth: 124,
    padding: 10,
    borderRadius: theme.radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  memberCardActive: { borderWidth: 1.5, borderColor: theme.colors.accent, backgroundColor: '#181822' },
  memberCardIdle: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  memberCopy: { flexShrink: 1, minWidth: 0 },
  memberName: { fontSize: 13, lineHeight: 17, fontWeight: '600', color: theme.colors.textPrimary },
  assignHint: { paddingHorizontal: 16, marginBottom: 10, fontSize: 12, lineHeight: 16, color: theme.colors.textMuted },
  errorText: { color: theme.colors.danger, fontSize: 14, lineHeight: 20, marginHorizontal: 16, marginBottom: 10 },
  reconcile: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.28)',
    gap: 8,
  },
  reconcileTitle: { fontSize: 14, lineHeight: 18, fontWeight: '700', color: '#FDE68A' },
  reconcileBody: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  reconcileActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  reconcileChip: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  reconcileChipOn: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  reconcileChipText: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: theme.colors.textPrimary },
  reconcileChipTextOn: { color: theme.colors.accentText },
  reconcileList: { gap: 6 },
  reconcileChoice: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: theme.colors.surface },
  reconcileChoiceText: { fontSize: 13, lineHeight: 18, color: theme.colors.textPrimary },
  reconcileForm: { gap: 8 },
  reconcileInput: {
    height: 44,
    borderRadius: 12,
    paddingHorizontal: 12,
    backgroundColor: theme.colors.canvas,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.textPrimary,
    fontSize: 15,
  },
  reconcileSave: {
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  reconcileSaveText: { fontSize: 14, fontWeight: '700', color: theme.colors.accentText },
  reconcileError: { fontSize: 13, lineHeight: 18, color: theme.colors.danger },
  ledger: {
    marginHorizontal: 16,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  itemDivider: { height: StyleSheet.hairlineWidth, marginLeft: 14, backgroundColor: theme.colors.border },
  itemRow: { paddingHorizontal: 14, paddingVertical: 14 },
  itemRowPressed: { backgroundColor: theme.colors.surfaceElevated },
  itemRowSelected: { backgroundColor: theme.colors.accentSubtle },
  itemTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  itemIdentity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  quantityPill: {
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  quantityText: { ...theme.typography.micro, color: theme.colors.textSecondary },
  itemName: { flexShrink: 1, fontSize: 15, lineHeight: 20, fontWeight: '500', color: theme.colors.textPrimary },
  assigneeRow: { marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  footerDivider: { height: 1, backgroundColor: 'rgba(255, 255, 255, 0.10)' },
  footer: { padding: 14, gap: 8 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  metaLabel: { ...theme.typography.caption, color: theme.colors.textSecondary },
  grandRow: {
    marginTop: 4,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  grandLabel: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: theme.colors.textPrimary },
  unassignedLabel: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: theme.colors.warning },
  bottomBar: {
    backgroundColor: theme.colors.canvas,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  barError: { color: theme.colors.danger, fontSize: 13, lineHeight: 18, marginBottom: 8 },
  cta: { height: 52, borderRadius: theme.radius.md, alignItems: 'center', justifyContent: 'center' },
  ctaReady: { backgroundColor: theme.colors.accent },
  ctaReadyPressed: { backgroundColor: theme.colors.accentPressed },
  ctaUnavailable: { opacity: 0.45 },
  ctaSaving: { backgroundColor: theme.colors.accent, opacity: 0.75 },
  ctaBlocked: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(251, 146, 60, 0.30)',
  },
  ctaSaved: {
    backgroundColor: theme.colors.positiveSubtle,
    borderWidth: 1,
    borderColor: theme.colors.positive,
  },
  ctaReadyText: { color: theme.colors.accentText, fontSize: 16, fontWeight: '700' },
  ctaBlockedText: { color: theme.colors.warning, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  ctaSavedText: { color: theme.colors.positive, fontSize: 16, fontWeight: '600' },
  continueLink: { alignItems: 'center', paddingTop: 10, paddingBottom: 2 },
  continueLinkText: { color: theme.colors.textSecondary, fontSize: 13, fontWeight: '500' },
});
