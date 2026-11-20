import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { groupService, type GroupMemberProfile } from '@/services/GroupService';
import { receiptService } from '@/services/ReceiptService';
import type { Item, Receipt, Split } from '@/types/database.types';
import { allocateByItems, extrasMinor, formatPence, toMinorUnits } from '@/utils/money';

type LedgerReceipt = Receipt & {
  restaurant_name?: string | null;
  website?: string | null;
};

type Ledger = {
  receipt: LedgerReceipt;
  items: Item[];
  splits: Split[];
};

const MEMBER_COLORS = ['#38BDF8', '#C084FC', '#22D3EE', '#4ADE80', '#F472B6', '#FBBF24', '#FB7185', '#A78BFA'];

type Assignee = {
  id: string;
  name: string;
  initial: string;
  color: string;
};

const LedgerItem = memo(function LedgerItem({ item, priceLabel, isSelected, assignees, onToggle }: { item: Item; priceLabel: string; isSelected: boolean; assignees: Assignee[]; onToggle: (id: string) => void }) {
  return (
    <Pressable
      onPress={() => onToggle(item.id)}
      style={[styles.itemCard, isSelected && styles.itemCardSelected]}
    >
      <View style={styles.itemCopy}>
        <Text style={styles.itemName}>{item.display_name || item.original_name}</Text>
        {assignees.length > 0 ? (
          <View style={styles.assigneeRow}>
            {assignees.map((person) => (
              <View key={person.id} style={[styles.assigneeBadge, { borderColor: person.color }]}>
                <Text style={[styles.assigneeBadgeText, { color: person.color }]}>{person.initial}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
      <Text style={styles.itemPrice}>{priceLabel}</Text>
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
          console.error('Failed to load group split:', error);
          setMembers([]);
          setClaims({});
          setPaidById(null);
          setActiveMemberId(null);
          setGroupError('Could not load this group.');
        }
      } catch (error) {
        if (!cancelled) console.error('Failed to load ledger:', error);
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
    void Haptics.selectionAsync();
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
      console.error('Failed to save split:', error);
      setSaveError(error instanceof Error ? error.message : 'Could not save this split.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSaving(false);
    }
  }, [claims, members, paidById, receiptData, saving]);

  if (isLoading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#4ade80" />
      </View>
    );
  }

  if (notFound || !receiptData) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.missingTitle}>Receipt not found</Text>
        <Text style={styles.missingSubtitle}>This receipt was deleted or is no longer available.</Text>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.missingButton}>
          <Text style={styles.missingButtonText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const { receipt, items } = receiptData;
  const isGroup = Boolean(receipt.group_id);
  const people = members.map((member, index) => toAssignee(member, index));
  const activeMember = people.find((person) => person.id === activeMemberId) ?? null;
  const memberIds = members.map((member) => member.userId);
  const shares = isGroup ? memberShares(items, claims, memberIds, receipt) : {};
  const unassigned = isGroup ? unassignedMinor(items, claims) : 0;
  const isTaxIncluded = receiptExtrasMinor(items, receipt) === 0 && Number(receipt.tax_amount || 0) > 0;

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Ledger',
          headerStyle: { backgroundColor: '#0f172a' },
          headerTintColor: '#fff',
          headerLeft: () => (
            <Pressable onPress={() => router.back()} style={{ padding: 8, marginLeft: -8 }}>
              <Text style={{ color: '#4ade80', fontSize: 16, fontWeight: '600' }}>Back</Text>
            </Pressable>
          )
        }}
      />

      <ScrollView contentContainerStyle={styles.scrollContent}>

        <View style={styles.headerContainer}>
          <Text style={styles.restaurantName}>
            {receipt.restaurant_name || receipt.merchant_name || 'Ledger'}
          </Text>

          {receipt.website ? (
            <Pressable
              onPress={() => Linking.openURL(receipt.website!.startsWith('http') ? receipt.website! : `https://${receipt.website}`)}
              style={styles.bookButton}
            >
              <Text style={styles.bookButtonText}>Book again</Text>
            </Pressable>
          ) : null}
        </View>

        {isGroup ? (
          <View style={styles.groupSection}>
            <Text style={styles.sectionLabel}>Paid by</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
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

            <Text style={styles.sectionLabel}>Assign to</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
              {people.map((person) => {
                const selected = person.id === activeMemberId;
                return (
                  <Pressable
                    key={person.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${person.name}, ${formatPence(shares[person.id] ?? 0)}`}
                    accessibilityState={{ selected }}
                    onPress={() => {
                      setActiveMemberId(person.id);
                      void Haptics.selectionAsync();
                    }}
                    style={[styles.memberChip, selected && { borderColor: person.color }]}
                  >
                    <View style={[styles.memberMark, { borderColor: person.color, backgroundColor: `${person.color}22` }]}>
                      <Text style={[styles.memberInitial, { color: person.color }]}>{person.initial}</Text>
                    </View>
                    <View style={styles.memberCopy}>
                      <Text style={styles.memberName} numberOfLines={1}>{person.name}</Text>
                      <Text style={[styles.memberShare, selected && { color: person.color }]}>{formatPence(shares[person.id] ?? 0)}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Pressable accessibilityRole="button" onPress={splitEqually} style={styles.equalButton}>
              <Text style={styles.equalButtonText}>Split equally</Text>
            </Pressable>
            <Text style={styles.assignHint}>
              {activeMember ? `Tap a line to assign it to ${activeMember.name}.` : 'Choose a person, then tap a line.'}
            </Text>
            {groupError ? <Text style={styles.errorText}>{groupError}</Text> : null}
          </View>
        ) : null}

        <View style={styles.itemsContainer}>
          {items.map((item) => (
            <LedgerItem
              key={item.id}
              item={item}
              priceLabel={isGroup ? formatPence(lineMinor(item)) : `£${Number(item.price).toFixed(2)}`}
              isSelected={isGroup ? (claims[item.id] ?? []).includes(activeMemberId ?? '') : selectedItemIds.has(item.id)}
              assignees={isGroup ? people.filter((person) => (claims[item.id] ?? []).includes(person.id)) : []}
              onToggle={isGroup ? toggleAssignment : toggleItem}
            />
          ))}
        </View>

        <View style={styles.totalsContainer}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal</Text>
            <Text style={styles.totalValue}>£{Number(receipt.subtotal || 0).toFixed(2)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>{isTaxIncluded ? 'Tax included' : 'Tax'}</Text>
            <Text style={styles.totalValue}>£{Number(receipt.tax_amount || 0).toFixed(2)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Service Charge</Text>
            <Text style={styles.totalValue}>£{Number(receipt.service_charge || 0).toFixed(2)}</Text>
          </View>
          {Number(receipt.tip_amount) > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Tip</Text>
              <Text style={styles.totalValue}>£{Number(receipt.tip_amount).toFixed(2)}</Text>
            </View>
          ) : null}
          <View style={[styles.totalRow, styles.grandTotalRow]}>
            <Text style={styles.grandTotalLabel}>Total</Text>
            <Text style={styles.grandTotalValue}>£{Number(receipt.total_amount || 0).toFixed(2)}</Text>
          </View>
          {unassigned > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Unassigned</Text>
              <Text style={styles.unassignedValue}>{formatPence(unassigned)}</Text>
            </View>
          ) : null}
        </View>

        {isGroup ? (
          <>
            {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
            <Pressable
              accessibilityRole="button"
              disabled={saving || !paidById || members.length === 0}
              onPress={() => {
                void saveSplit();
              }}
              style={[styles.continueButton, (saving || !paidById || members.length === 0) && styles.buttonDisabled]}
            >
              {saving ? (
                <ActivityIndicator color="#0f172a" />
              ) : (
                <Text style={styles.continueButtonText}>{saved ? 'Saved' : 'Save Split'}</Text>
              )}
            </Pressable>
          </>
        ) : null}

        <Pressable
          onPress={() => router.push({ pathname: '/split', params: { id: receiptId } })}
          style={isGroup ? styles.secondaryButton : styles.continueButton}
        >
          <Text style={isGroup ? styles.secondaryButtonText : styles.continueButtonText}>Continue to Split</Text>
        </Pressable>

      </ScrollView>
    </View>
  );
}

function preferredMemberId(receipt: Receipt, roster: GroupMemberProfile[]) {
  const preferred = receipt.paid_by ?? receipt.host_id;
  if (roster.some((member) => member.userId === preferred)) return preferred;
  if (roster.some((member) => member.userId === receipt.host_id)) return receipt.host_id;
  return roster[0]?.userId ?? null;
}

function toAssignee(member: GroupMemberProfile, index: number): Assignee {
  return {
    id: member.userId,
    name: member.fullName,
    initial: initials(member.fullName),
    color: MEMBER_COLORS[index % MEMBER_COLORS.length],
  };
}

function initials(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
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
  container: { flex: 1, backgroundColor: '#0f172a' },
  centerContainer: { flex: 1, backgroundColor: '#0f172a', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  missingTitle: { color: 'white', fontSize: 24, fontWeight: '800', letterSpacing: -0.4, textAlign: 'center' },
  missingSubtitle: { marginTop: 8, color: '#94a3b8', fontSize: 16, lineHeight: 24, textAlign: 'center' },
  missingButton: { marginTop: 24, backgroundColor: '#1e293b', borderRadius: 12, borderWidth: 1, borderColor: '#334155', paddingHorizontal: 20, paddingVertical: 14 },
  missingButtonText: { color: '#4ade80', fontSize: 16, fontWeight: '700' },
  scrollContent: { padding: 16, paddingBottom: 40 },
  headerContainer: { alignItems: 'center', marginBottom: 24 },
  restaurantName: { color: 'white', fontSize: 24, fontWeight: 'bold', textAlign: 'center' },
  bookButton: { marginTop: 12, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#1e293b', borderRadius: 8, borderWidth: 1, borderColor: '#334155' },
  bookButtonText: { color: '#4ade80', fontSize: 14, fontWeight: '600' },
  groupSection: { marginBottom: 20, gap: 10 },
  sectionLabel: { color: '#94a3b8', fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  pillRow: { gap: 8, paddingVertical: 2 },
  paidPill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: '#1e293b', borderWidth: 1, borderColor: '#334155' },
  paidPillSelected: { borderColor: '#4ade80', backgroundColor: '#14532d' },
  paidPillText: { color: '#e2e8f0', fontSize: 14, fontWeight: '600' },
  paidPillTextSelected: { color: '#4ade80' },
  memberChip: { width: 148, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 14, backgroundColor: '#1e293b', borderWidth: 1, borderColor: '#334155' },
  memberMark: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  memberInitial: { fontSize: 11, fontWeight: '700' },
  memberCopy: { flex: 1 },
  memberName: { color: 'white', fontSize: 14, fontWeight: '700' },
  memberShare: { color: '#94a3b8', fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  equalButton: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: '#334155', backgroundColor: '#1e293b' },
  equalButtonText: { color: '#e2e8f0', fontSize: 13, fontWeight: '700' },
  assignHint: { color: '#94a3b8', fontSize: 13 },
  errorText: { color: '#fca5a5', fontSize: 14, marginTop: 8 },
  itemsContainer: { gap: 12, marginBottom: 32 },
  itemCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1e293b', padding: 16, borderRadius: 12, borderWidth: 2, borderColor: 'transparent' },
  itemCardSelected: { borderColor: '#4ade80', backgroundColor: '#1e293b' },
  itemCopy: { flex: 1, marginRight: 12, gap: 8 },
  itemName: { color: 'white', fontSize: 16, fontWeight: '600' },
  itemPrice: { color: '#38bdf8', fontSize: 16, fontWeight: '600' },
  assigneeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  assigneeBadge: { minWidth: 26, height: 22, paddingHorizontal: 6, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  assigneeBadgeText: { fontSize: 11, fontWeight: '700' },
  totalsContainer: { borderTopWidth: 1, borderTopColor: '#334155', paddingTop: 16, gap: 8 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { color: '#94a3b8', fontSize: 14 },
  totalValue: { color: 'white', fontSize: 14 },
  unassignedValue: { color: '#fbbf24', fontSize: 14, fontWeight: '700' },
  grandTotalRow: { marginTop: 8 },
  grandTotalLabel: { color: 'white', fontSize: 20, fontWeight: 'bold' },
  grandTotalValue: { color: '#38bdf8', fontSize: 20, fontWeight: 'bold' },
  continueButton: { backgroundColor: '#4ade80', padding: 16, borderRadius: 12, marginTop: 32, alignItems: 'center' },
  continueButtonText: { color: '#0f172a', fontSize: 18, fontWeight: 'bold' },
  secondaryButton: { marginTop: 12, padding: 16, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#334155', backgroundColor: '#1e293b' },
  secondaryButtonText: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  buttonDisabled: { opacity: 0.55 },
});
