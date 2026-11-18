import { BlurTargetView } from 'expo-blur';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Platform, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { FadeIn, FadeInRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Frost } from '@/components/frost';
import { NightScreen } from '@/components/night-screen';
import { PayoutSetup, type PayoutBank } from '@/components/payout-setup';
import { Colors, Spacing } from '@/constants/theme';
import { mediumHaptic, successHaptic, tickHaptic } from '@/lib/haptics';
import { SnapPressable, useSnapScale } from '@/lib/use-snap-scale';
import { groupService, type GroupMemberProfile } from '@/services/GroupService';
import { receiptService } from '@/services/ReceiptService';
import type { Item, Receipt, Split } from '@/types/database.types';
import { allocateByItems, formatPence, toMinorUnits } from '@/utils/money';

const PEOPLE = [
  { id: '11111111-1111-4111-a111-111111111111', name: 'Me', initial: 'M', color: '#38BDF8' },
  { id: '22222222-2222-4222-a222-222222222222', name: 'Sarah', initial: 'S', color: '#C084FC' },
  { id: '33333333-3333-4333-a333-333333333333', name: 'Mike', initial: 'Mi', color: '#22D3EE' },
] as const;

const ICE = '#38BDF8';
const NAVY = '#030712';

const MEMBER_COLORS = ['#38BDF8', '#C084FC', '#22D3EE', '#4ADE80', '#F472B6', '#FBBF24', '#FB7185', '#A78BFA'];

type SplitPerson = {
  id: string;
  name: string;
  initial: string;
  color: string;
};

type LedgerData = {
  receipt: Receipt;
  items: Item[];
  splits: Split[];
};

function formatMoney(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
  } catch {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount);
  }
}

function roundMoney(amount: number) {
  return Math.round(amount * 100) / 100;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function toImageUri(uri: string | null) {
  if (!uri) return '';
  if (/^(file|content|ph|assets-library|http|data):/i.test(uri)) {
    return uri;
  }
  return `data:image/jpeg;base64,${uri}`;
}

function personById(people: readonly SplitPerson[], id: string) {
  return people.find((person) => person.id === id);
}

function initials(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function toSplitPerson(member: GroupMemberProfile, index: number): SplitPerson {
  return {
    id: member.userId,
    name: member.fullName,
    initial: initials(member.fullName),
    color: MEMBER_COLORS[index % MEMBER_COLORS.length],
  };
}

function preferredMemberId(receipt: Receipt, roster: GroupMemberProfile[]) {
  const preferred = receipt.paid_by ?? receipt.host_id;
  if (roster.some((member) => member.userId === preferred)) return preferred;
  if (roster.some((member) => member.userId === receipt.host_id)) return receipt.host_id;
  return roster[0]?.userId ?? null;
}

function lineMinor(item: Item) {
  return toMinorUnits(item.price) * item.quantity;
}

function memberShares(items: Item[], claims: Record<string, string[]>, memberIds: string[], receipt: Receipt) {
  return allocateByItems(
    items.map((item) => ({
      id: item.id,
      priceMinor: lineMinor(item),
      assignedUserIds: claims[item.id] ?? [],
    })),
    toMinorUnits(receipt.tax_amount) + toMinorUnits(receipt.service_charge) + toMinorUnits(receipt.tip_amount),
    memberIds,
  );
}

// Fixed share calculation to use the live Supabase Item array
function shareFor(items: Item[], claims: Record<string, string[]>, personId: string, subtotal: number, serviceCharge: number) {
  const subtotalShare = roundMoney(
    items.reduce((sum, item) => {
      const claimants = claims[item.id] ?? [];
      if (!claimants.includes(personId) || claimants.length === 0) {
        return sum;
      }
      return sum + Number(item.price) / claimants.length;
    }, 0)
  );
  
  const serviceShare = roundMoney(
    subtotal > 0 ? (subtotalShare / subtotal) * serviceCharge : 0
  );

  return {
    subtotalShare,
    serviceShare,
    owed: roundMoney(subtotalShare + serviceShare),
  };
}

export default function SplitScreen() {
  const insets = useSafeAreaInsets();
  const { id: idParam } = useLocalSearchParams<{ id?: string | string[] }>();
  const receiptId = firstParam(idParam);
  
  const [ledgerData, setLedgerData] = useState<LedgerData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [members, setMembers] = useState<GroupMemberProfile[]>([]);
  const [paidById, setPaidById] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [selectedId, setSelectedId] = useState<string>(PEOPLE[0].id);
  // Local state for instant visual feedback before persisting
  const [claims, setClaims] = useState<Record<string, string[]>>({});

  const isGroup = Boolean(ledgerData?.receipt.group_id);
  const people: SplitPerson[] = isGroup
    ? members.map((member, index) => toSplitPerson(member, index))
    : PEOPLE.map((person) => ({ id: person.id, name: person.name, initial: person.initial, color: person.color }));
  const selected = personById(people, selectedId) ?? people[0];
  const memberIds = members.map((member) => member.userId);
  const groupShares = isGroup && ledgerData
    ? memberShares(ledgerData.items, claims, memberIds, ledgerData.receipt)
    : {};
  
  const scrollAnchor = useRef(0);
  const blurTarget = useRef<ComponentRef<typeof View>>(null);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [payout, setPayout] = useState<PayoutBank | null>(null);

  // Load the live data from Supabase
  useEffect(() => {
    async function loadLedger() {
      if (!receiptId) {
        setIsLoading(false);
        return;
      }
      try {
        setIsLoading(true);
        const data = await receiptService.getReceiptWithItems(receiptId);
        if (!data) {
          setLedgerData(null);
          return;
        }
        setLedgerData(data as LedgerData);

        if (data.receipt.group_id) {
          try {
            const [roster, savedSplits] = await Promise.all([
              groupService.getGroupMembers(data.receipt.group_id),
              receiptService.getReceiptSplits(data.receipt.id),
            ]);
            const rosterIds = new Set(roster.map((member) => member.userId));
            const initialClaims: Record<string, string[]> = {};
            for (const split of savedSplits) {
              if (!rosterIds.has(split.user_id)) continue;
              for (const itemId of split.item_ids) {
                const existing = initialClaims[itemId] ?? [];
                if (!existing.includes(split.user_id)) existing.push(split.user_id);
                initialClaims[itemId] = existing;
              }
            }
            const preferred = preferredMemberId(data.receipt, roster);
            setMembers(roster);
            setClaims(initialClaims);
            setPaidById(preferred);
            setGroupError(null);
            if (preferred) setSelectedId(preferred);
          } catch (groupLoadError) {
            console.error('Failed to load group split:', groupLoadError);
            setMembers([]);
            setClaims({});
            setPaidById(null);
            setGroupError('Could not load this group.');
          }
        } else {
          setMembers([]);
          setPaidById(null);
          setGroupError(null);
          // Populate local claims state from database splits
          const initialClaims: Record<string, string[]> = {};
          data.splits.forEach(split => {
            if (!initialClaims[split.item_id]) initialClaims[split.item_id] = [];
            // In a real app we'd map auth UUIDs to our mock PEOPLE array.
            // For now, if user_id matches a mock ID, use it, else default to 'me'
            const pid = PEOPLE.some(p => p.id === split.user_id) ? split.user_id : 'me';
            if (!initialClaims[split.item_id].includes(pid)) {
               initialClaims[split.item_id].push(pid);
            }
          });
          setClaims(initialClaims);
        }
      } catch (error) {
        console.error("Failed to load split ledger:", error);
      } finally {
        setIsLoading(false);
      }
    }
    loadLedger();
  }, [receiptId]);

  function onPeopleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const x = event.nativeEvent.contentOffset.x;
    if (Math.abs(x - scrollAnchor.current) < 64) return;
    scrollAnchor.current = x;
    tickHaptic();
  }

  async function shareBreakdown() {
    if (!ledgerData) return;
    try {
      const assigned = people.filter((person) => Object.values(claims).some((c) => c.includes(person.id)));
      if (assigned.length === 0) {
        await Share.share({ message: 'Receipt Breakdown: No items assigned yet.' });
        return;
      }
      const parts = assigned.map((person) => {
        if (isGroup) {
          return `${person.name} owes ${formatPence(groupShares[person.id] ?? 0)}`;
        }
        const { owed } = shareFor(ledgerData.items, claims, person.id, Number(ledgerData.receipt.subtotal), Number(ledgerData.receipt.service_charge));
        return `${person.name} owes ${formatMoney(owed, ledgerData.receipt.currency_code)}`;
      });
      await Share.share({ message: `Receipt Breakdown: ${parts.join(' | ')} (Includes tax & tip)` });
    } catch {
      // Dismissed
    }
  }

  function splitEqually() {
    if (!ledgerData || members.length === 0) return;
    const ids = members.map((member) => member.userId);
    const next: Record<string, string[]> = {};
    for (const item of ledgerData.items) next[item.id] = [...ids];
    setClaims(next);
    setSaved(false);
    setSaveError(null);
    tickHaptic();
  }

  async function saveSplit() {
    if (!ledgerData || !paidById || members.length === 0 || saving) return;
    const ids = members.map((member) => member.userId);
    const shares = memberShares(ledgerData.items, claims, ids, ledgerData.receipt);
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await receiptService.saveReceiptSplits(
        ledgerData.receipt.id,
        paidById,
        ids.map((userId) => ({
          user_id: userId,
          amount_minor: shares[userId] ?? 0,
          item_ids: ledgerData.items.filter((item) => (claims[item.id] ?? []).includes(userId)).map((item) => item.id),
        })),
      );
      setLedgerData((current) => (
        current ? { ...current, receipt: { ...current.receipt, paid_by: paidById } } : current
      ));
      setSaved(true);
      successHaptic();
    } catch (error) {
      console.error('Failed to save split:', error);
      setSaveError(error instanceof Error ? error.message : 'Could not save this split.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleClaim(itemId: string) {
    if (!receiptId || !selected) return;

    setSaved(false);
    setSaveError(null);
    // Optimistic UI update for zero lag
    setClaims(current => {
      const existing = current[itemId] ?? [];
      const next = existing.includes(selected.id)
        ? existing.filter((id) => id !== selected.id)
        : [...existing, selected.id];
      return { ...current, [itemId]: next };
    });

    if (isGroup) return;

    // Persist to database in background
    try {
      // Assuming selected.id is the user's UUID in a real auth setup.
      await receiptService.toggleItemClaim(itemId, selected.id, receiptId);
    } catch (error) {
      console.error("Failed to persist split:", error);
      // If persistence fails, you could revert the optimistic state here
    }
  }

  if (isLoading) {
    return (
      <NightScreen>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color="#4ade80" />
        </View>
      </NightScreen>
    );
  }

  if (!ledgerData) {
    return (
      <NightScreen>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text style={{ color: 'white', textAlign: 'center', fontSize: 18 }}>
            No receipt selected. Please start a scan or select a receipt from the home screen.
          </Text>
        </View>
      </NightScreen>
    );
  }

  const { receipt, items } = ledgerData;
  const currency = receipt.currency_code;
  const money = (amount: number) => formatMoney(amount, currency);
  const shareLabel = (personId: string) => (
    isGroup ? formatPence(groupShares[personId] ?? 0) : money(shareFor(items, claims, personId, Number(receipt.subtotal), Number(receipt.service_charge)).owed)
  );
  const unassigned = isGroup ? items.reduce((sum, item) => ((claims[item.id] ?? []).length === 0 ? sum + lineMinor(item) : sum), 0) : 0;

  return (
    <NightScreen>
      <BlurTargetView ref={blurTarget} style={styles.flex}>
      <View style={[styles.peopleBar, { paddingTop: Platform.OS === 'web' ? 88 : insets.top + Spacing.three }]}>
        {isGroup ? (
          <View style={styles.paidByBlock}>
            <Text style={styles.assignHint}>Paid by</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.paidByRow}>
              {people.map((person) => {
                const paying = person.id === paidById;
                return (
                  <TouchableOpacity
                    key={person.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: paying }}
                    activeOpacity={0.85}
                    onPress={() => {
                      setPaidById(person.id);
                      setSaved(false);
                      setSaveError(null);
                      tickHaptic();
                    }}
                    style={[styles.paidByPill, paying && styles.paidByPillSelected]}
                  >
                    <Text style={[styles.paidByText, paying && styles.paidByTextSelected]}>{person.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} scrollEventThrottle={32} onScroll={onPeopleScroll} contentContainerStyle={styles.peopleRow}>
          {people.map((person) => (
            <PersonPill
              key={person.id}
              person={person}
              selected={person.id === selected?.id}
              totalLabel={shareLabel(person.id)}
              onPress={() => setSelectedId(person.id)}
            />
          ))}
        </ScrollView>
        <Text style={styles.assignHint}>{selected ? `Tap a line to assign it to ${selected.name}.` : 'Choose a person, then tap a line.'}</Text>
        {isGroup ? (
          <TouchableOpacity accessibilityRole="button" activeOpacity={0.85} onPress={splitEqually} style={styles.equalButton}>
            <Text style={styles.equalButtonText}>Split equally</Text>
          </TouchableOpacity>
        ) : null}
        {groupError ? <Text style={styles.saveError}>{groupError}</Text> : null}
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: isGroup ? 220 : 120 }]}>
        <Animated.View entering={FadeIn.duration(360)}>
          {receipt.image_url ? (
            <Image accessibilityLabel="Scanned receipt" contentFit="cover" source={{ uri: toImageUri(receipt.image_url) }} style={styles.thumbnail} />
          ) : null}

          <View style={styles.listContainer}>
            {items.map((item) => (
              <ReceiptLine
                key={item.id}
                item={item}
                people={people}
                claimants={claims[item.id] ?? []}
                amountLabel={isGroup ? formatPence(lineMinor(item)) : money(Number(item.price))}
                onPress={() => toggleClaim(item.id)}
              />
            ))}
          </View>
        </Animated.View>
      </ScrollView>

      {/* NEW COMPACT FOOTER UI */}
      <View style={[styles.compactFooterWrap, { paddingBottom: Math.max(insets.bottom, Spacing.three) }]}>
        <Frost style={styles.compactFooter}>
          <View style={styles.compactRow}>
            <View style={styles.compactSummaryColumn}>
              <Text style={styles.compactSummaryLabel}>Bill Total</Text>
              <Text style={styles.compactSummaryValue}>{money(Number(receipt.total_amount))}</Text>
            </View>
            
            <View style={styles.compactShareColumn}>
              <Text style={styles.compactShareLabel}>{selected ? `${selected.name}'s Share` : 'Share'}</Text>
              <Text style={styles.compactShareValue}>{selected ? shareLabel(selected.id) : money(0)}</Text>
            </View>

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => {
                successHaptic();
                void shareBreakdown();
              }}
              style={styles.compactShareButton}
            >
              <LinearGradient
                colors={['#7DD3FC', '#38BDF8']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.compactGradientWrap}
              >
                <Text style={styles.compactShareText}>Share</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
          {isGroup ? (
            <View style={styles.saveBlock}>
              {unassigned > 0 ? <Text style={styles.unassignedText}>{formatPence(unassigned)} still unassigned</Text> : null}
              {saveError ? <Text style={styles.saveError}>{saveError}</Text> : null}
              <TouchableOpacity
                accessibilityRole="button"
                activeOpacity={0.85}
                disabled={saving || !paidById || members.length === 0}
                onPress={() => {
                  void saveSplit();
                }}
                style={[styles.saveButton, (saving || !paidById || members.length === 0) && styles.saveButtonDisabled]}
              >
                {saving ? <ActivityIndicator color={NAVY} /> : <Text style={styles.saveButtonText}>{saved ? 'Saved' : 'Save Split'}</Text>}
              </TouchableOpacity>
            </View>
          ) : null}
        </Frost>
      </View>

      </BlurTargetView>
      <PayoutSetup
        blurTarget={blurTarget}
        visible={payoutOpen}
        onClose={() => setPayoutOpen(false)}
        onConnected={(bank) => {
          setPayoutOpen(false);
          setTimeout(() => setPayout(bank), 360);
        }}
      />
    </NightScreen>
  );
}

function PersonPill({ person, selected, totalLabel, onPress }: { person: SplitPerson; selected: boolean; totalLabel: string; onPress: () => void }) {
  const snap = useSnapScale(selected);
  return (
    <SnapPressable
      accessibilityRole="button"
      accessibilityLabel={`${person.name}, ${totalLabel}`}
      accessibilityState={{ selected }}
      onPressIn={snap.onPressIn}
      onPressOut={snap.onPressOut}
      onPress={() => {
        if (!selected) tickHaptic();
        onPress();
      }}
      style={[styles.pillPress, snap.style]}>
      <Frost
        style={[
          styles.pill,
          selected && { borderColor: ICE, shadowColor: ICE, shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } },
        ]}>
        <View style={[styles.pillMark, { backgroundColor: `${person.color}33`, borderColor: person.color }]}>
          <Text style={[styles.pillInitial, { color: person.color }]} numberOfLines={1}>{person.initial}</Text>
        </View>
        <View style={styles.pillCopy}>
          <Text style={styles.pillName} numberOfLines={1}>{person.name}</Text>
          <Text style={[styles.pillTotal, selected && styles.pillTotalSelected]} numberOfLines={1}>{totalLabel}</Text>
        </View>
      </Frost>
    </SnapPressable>
  );
}

function ReceiptLine({ item, people, claimants, amountLabel, onPress }: { item: Item; people: SplitPerson[]; claimants: string[]; amountLabel: string; onPress: () => void }) {
  const names = claimants.flatMap((id) => {
    const name = personById(people, id)?.name;
    return name ? [name] : [];
  });
  const snap = useSnapScale(names.join('|'));

  return (
    <SnapPressable
      accessibilityRole="button"
      accessibilityLabel={
        names.length > 0
          ? `${item.quantity}x ${item.display_name || item.original_name}, claimed by ${names.join(', ')}`
          : `${item.quantity}x ${item.display_name || item.original_name}, unclaimed`
      }
      onPressIn={snap.onPressIn}
      onPressOut={snap.onPressOut}
      onPress={() => {
        mediumHaptic();
        onPress();
      }}
      style={[styles.line, snap.style]}>
      <View style={styles.lineCopy}>
        <Text style={styles.lineName}>
          <Text style={styles.lineQty}>{item.quantity}× </Text>
          {item.display_name || item.original_name}
        </Text>
        {claimants.length > 0 ? (
          <View style={styles.badges}>
            {claimants.map((id) => {
              const person = personById(people, id);
              if (!person) return null;
              return (
                <Animated.View
                  key={id}
                  entering={FadeInRight.duration(280).springify()}
                  style={[styles.badge, { borderColor: person.color, backgroundColor: `${person.color}22` }]}>
                  <Text style={[styles.badgeText, { color: person.color }]}>{person.initial}</Text>
                </Animated.View>
              );
            })}
          </View>
        ) : null}
      </View>
      <Text style={styles.linePrice}>{amountLabel}</Text>
    </SnapPressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  peopleBar: { paddingBottom: Spacing.two, gap: Spacing.three },
  peopleRow: { paddingHorizontal: Spacing.four, paddingVertical: Spacing.two, gap: Spacing.two, alignItems: 'stretch' },
  pillPress: { width: 156, height: 64 },
  pill: { width: 156, height: 64, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 18, paddingHorizontal: 12 },
  pillMark: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  pillInitial: { fontSize: 12, lineHeight: 14, fontWeight: '700', textAlign: 'center', letterSpacing: -0.3 },
  pillCopy: { flex: 1, minWidth: 0, justifyContent: 'center' },
  pillName: { color: Colors.text, fontSize: 15, lineHeight: 18, fontWeight: '700', letterSpacing: -0.3 },
  pillTotal: { marginTop: 2, color: Colors.textSecondary, fontSize: 13, lineHeight: 16, fontWeight: '600', letterSpacing: -0.1, fontVariant: ['tabular-nums'] },
  pillTotalSelected: { color: ICE },
  assignHint: { color: Colors.textSecondary, fontSize: 13, letterSpacing: -0.1, paddingHorizontal: Spacing.four },
  paidByBlock: { gap: Spacing.two },
  paidByRow: { paddingHorizontal: Spacing.four, gap: Spacing.two },
  paidByPill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(148, 163, 184, 0.35)', backgroundColor: 'rgba(15, 23, 42, 0.65)' },
  paidByPillSelected: { borderColor: ICE, backgroundColor: 'rgba(56, 189, 248, 0.16)' },
  paidByText: { color: Colors.text, fontSize: 14, fontWeight: '600' },
  paidByTextSelected: { color: ICE },
  equalButton: { alignSelf: 'flex-start', marginLeft: Spacing.four, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(148, 163, 184, 0.35)' },
  equalButtonText: { color: Colors.text, fontSize: 13, fontWeight: '700' },
  saveBlock: { marginTop: Spacing.three, gap: Spacing.two },
  saveButton: { backgroundColor: ICE, borderRadius: 999, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  saveButtonDisabled: { opacity: 0.55 },
  saveButtonText: { color: NAVY, fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  saveError: { color: '#FCA5A5', fontSize: 13, fontWeight: '600', paddingHorizontal: Spacing.four },
  unassignedText: { color: '#FBBF24', fontSize: 13, fontWeight: '700' },
  content: { paddingTop: Spacing.two },
  thumbnail: { width: '100%', height: 168, marginBottom: Spacing.three },
  listContainer: { paddingBottom: 24 },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.three, paddingHorizontal: Spacing.four, paddingVertical: Spacing.three, borderBottomWidth: 1, borderBottomColor: 'rgba(30, 41, 59, 0.4)' },
  lineCopy: { flex: 1, gap: Spacing.two },
  lineName: { color: Colors.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  lineQty: { color: Colors.textSecondary, fontWeight: '600' },
  linePrice: { color: Colors.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.3, fontVariant: ['tabular-nums'] },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  badge: { minWidth: 28, height: 24, paddingHorizontal: Spacing.two, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.2 },
  
  // NEW COMPACT FOOTER STYLES
  compactFooterWrap: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: Spacing.four },
  compactFooter: { borderRadius: 24, padding: Spacing.three, paddingHorizontal: Spacing.four, borderWidth: 1, borderColor: 'rgba(56, 189, 248, 0.2)', backgroundColor: 'rgba(3, 7, 18, 0.85)' },
  compactRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  compactSummaryColumn: { flex: 1 },
  compactSummaryLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  compactSummaryValue: { color: Colors.text, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  compactShareColumn: { flex: 1, paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: 'rgba(30, 41, 59, 0.8)' },
  compactShareLabel: { color: ICE, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  compactShareValue: { color: ICE, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  compactShareButton: { marginLeft: 16 },
  compactGradientWrap: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 999 },
  compactShareText: { color: NAVY, fontSize: 14, fontWeight: '800', letterSpacing: -0.2 },
});