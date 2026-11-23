import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AvatarBadge } from '@/components/AvatarBadge';
import { MoneyText } from '@/components/MoneyText';
import { groupService, type GroupMemberProfile } from '@/services/GroupService';
import { getSignedReceiptImageUrl } from '@/services/ReceiptImageService';
import { receiptService } from '@/services/ReceiptService';
import { theme } from '@/theme/theme';
import type { Item, Receipt, Split } from '@/types/database.types';
import { allocateByItems, extrasMinor, formatPence, toMinorUnits } from '@/utils/money';
import { mapErrorToUserMessage } from '@/utils/errorMapper';
import { logger } from '@/utils/logger';

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
  const [groupError, setGroupError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [togglingSettled, setTogglingSettled] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
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
          setMembers(roster);
          setClaims(nextClaims);
          setPaidById(preferred);
          setActiveMemberId(preferred);
          setGroupError(null);
        } catch (error) {
          if (cancelled) return;
          logger.error('receipt', { code: 'GROUP_FAILED' });
          setMembers([]);
          setClaims({});
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
    const shares = memberShares(receiptData.items, claims, memberIds, receiptData.receipt);
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
      setSaved(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      logger.error('receipt', { code: 'SAVE_FAILED' });
      setSaveError(mapErrorToUserMessage(error, 'Could not save this split.'));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSaving(false);
    }
  }, [claims, members, paidById, receiptData, saving]);

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
  const shares = isGroup ? memberShares(items, claims, memberIds, receipt) : {};
  const unassigned = isGroup ? unassignedMinor(items, claims) : 0;
  const isTaxIncluded = receiptExtrasMinor(items, receipt) === 0 && Number(receipt.tax_amount || 0) > 0;
  const merchantName = receipt.restaurant_name || receipt.merchant_name || 'Ledger';
  const receiptDate = new Date(receipt.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const lineTotalMinor = items.reduce((sum, item) => sum + lineMinor(item), 0);
  const assignedMinor = Math.max(0, lineTotalMinor - unassigned);
  const progress = Math.min(100, Math.round((assignedMinor / Math.max(1, lineTotalMinor)) * 100));
  const blocked = isGroup && unassigned > 0;
  const saveDisabled = saving || blocked || !paidById || members.length === 0;

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
    setTogglingSettled(true);
    try {
      const updated = await receiptService.setReceiptSettled(receipt.id, settled);
      setReceiptData((current) => (
        current ? { ...current, receipt: { ...current.receipt, settled_at: updated.settled_at, settled_by: updated.settled_by } } : current
      ));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (settled) router.back();
    } catch (error) {
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
          <MoneyText amountMinor={toMinorUnits(Number(receipt.total_amount || 0))} size="lg" color={theme.colors.textPrimary} />
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

      {receipt.settled_at ? (
        <View style={styles.settledBanner}>
          <View style={styles.settledBannerCopy}>
            <Ionicons name="checkmark-circle-outline" size={16} color={theme.colors.positive} />
            <Text style={styles.settledBannerText} numberOfLines={1}>Marked as settled</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reopen"
            disabled={togglingSettled}
            onPress={askReopen}
            style={({ pressed }) => [styles.reopenPill, pressed && styles.settlePillPressed]}
          >
            {togglingSettled ? (
              <ActivityIndicator size="small" color={theme.colors.textPrimary} />
            ) : (
              <Text style={styles.reopenText}>Reopen</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <View style={styles.settleActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Mark Settled"
            disabled={togglingSettled}
            onPress={askMarkSettled}
            style={({ pressed }) => [styles.settlePill, pressed && styles.settlePillPressed]}
          >
            {togglingSettled ? (
              <ActivityIndicator size="small" color={theme.colors.textPrimary} />
            ) : (
              <>
                <Ionicons name="checkmark-circle-outline" size={14} color={theme.colors.positive} />
                <Text style={styles.settlePillText}>Mark Settled</Text>
              </>
            )}
          </Pressable>
        </View>
      )}

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
                  return (
                    <Pressable
                      key={person.id}
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

function memberShares(items: Item[], claims: Record<string, string[]>, memberIds: string[], receipt: Receipt) {
  return allocateByItems(
    items.map((item) => ({
      id: item.id,
      priceMinor: lineMinor(item),
      assignedUserIds: claims[item.id] ?? [],
    })),
    receiptExtrasMinor(items, receipt),
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
    height: 52,
    paddingHorizontal: theme.spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  backLabel: { ...theme.typography.body, color: theme.colors.textSecondary },
  headerCenter: { flex: 1, minWidth: 0, marginHorizontal: 12 },
  headerTitle: { fontSize: 16, lineHeight: 20, fontWeight: '600', color: theme.colors.textPrimary },
  headerDate: { marginTop: 1, fontSize: 12, lineHeight: 16, color: theme.colors.textMuted },
  progressTrack: { height: 3, width: '100%', backgroundColor: theme.colors.surfaceElevated },
  progressFill: { height: 3 },
  settleActions: { alignItems: 'flex-end', marginHorizontal: 16, marginTop: 12 },
  settlePill: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  settlePillPressed: { backgroundColor: theme.colors.surfacePressed },
  settlePillText: { fontSize: 12, fontWeight: '600', color: theme.colors.textPrimary },
  settledBanner: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.positiveSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(52, 211, 153, 0.30)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  settledBannerCopy: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  settledBannerText: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: theme.colors.positive },
  reopenPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
  },
  reopenText: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: '600' },
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
