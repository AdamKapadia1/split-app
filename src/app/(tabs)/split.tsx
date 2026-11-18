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
import { receiptService } from '@/services/ReceiptService';
import type { Item, Receipt, Split } from '@/types/database.types';

const PEOPLE = [
  { id: '11111111-1111-4111-a111-111111111111', name: 'Me', initial: 'M', color: '#38BDF8' },
  { id: '22222222-2222-4222-a222-222222222222', name: 'Sarah', initial: 'S', color: '#C084FC' },
  { id: '33333333-3333-4333-a333-333333333333', name: 'Mike', initial: 'Mi', color: '#22D3EE' },
] as const;

const ICE = '#38BDF8';
const NAVY = '#030712';

type Person = (typeof PEOPLE)[number];
type PersonId = Person['id'];

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

function personById(id: string) {
  return PEOPLE.find((person) => person.id === id);
}

// Fixed share calculation to use the live Supabase Item array
function shareFor(items: Item[], claims: Record<string, PersonId[]>, personId: PersonId, subtotal: number, serviceCharge: number) {
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
  
  const [selectedId, setSelectedId] = useState<PersonId>('me');
  // Local state for instant visual feedback before persisting
  const [claims, setClaims] = useState<Record<string, PersonId[]>>({});
  
  const selected = personById(selectedId) ?? PEOPLE[0];
  
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
        setLedgerData(data as LedgerData);
        
        // Populate local claims state from database splits
        const initialClaims: Record<string, PersonId[]> = {};
        data.splits.forEach(split => {
          if (!initialClaims[split.item_id]) initialClaims[split.item_id] = [];
          // In a real app we'd map auth UUIDs to our mock PEOPLE array. 
          // For now, if user_id matches a mock ID, use it, else default to 'me'
          const pid = PEOPLE.some(p => p.id === split.user_id) ? split.user_id as PersonId : 'me';
          if (!initialClaims[split.item_id].includes(pid)) {
             initialClaims[split.item_id].push(pid);
          }
        });
        setClaims(initialClaims);
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
      const assigned = PEOPLE.filter((person) => Object.values(claims).some((c) => c.includes(person.id)));
      if (assigned.length === 0) {
        await Share.share({ message: 'Receipt Breakdown: No items assigned yet.' });
        return;
      }
      const parts = assigned.map((person) => {
        const { owed } = shareFor(ledgerData.items, claims, person.id, Number(ledgerData.receipt.subtotal), Number(ledgerData.receipt.service_charge));
        return `${person.name} owes ${formatMoney(owed, ledgerData.receipt.currency_code)}`;
      });
      await Share.share({ message: `Receipt Breakdown: ${parts.join(' | ')} (Includes tax & tip)` });
    } catch {
      // Dismissed
    }
  }

  async function toggleClaim(itemId: string) {
    if (!receiptId) return;
    
    // Optimistic UI update for zero lag
    setClaims(current => {
      const existing = current[itemId] ?? [];
      const next = existing.includes(selected.id)
        ? existing.filter((id) => id !== selected.id)
        : [...existing, selected.id];
      return { ...current, [itemId]: next };
    });

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
  const share = shareFor(items, claims, selected.id, Number(receipt.subtotal), Number(receipt.service_charge));
  const money = (amount: number) => formatMoney(amount, currency);

  return (
    <NightScreen>
      <BlurTargetView ref={blurTarget} style={styles.flex}>
      <View style={[styles.peopleBar, { paddingTop: Platform.OS === 'web' ? 88 : insets.top + Spacing.three }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} scrollEventThrottle={32} onScroll={onPeopleScroll} contentContainerStyle={styles.peopleRow}>
          {PEOPLE.map((person) => (
            <PersonPill
              key={person.id}
              person={person}
              selected={person.id === selected.id}
              totalLabel={money(shareFor(items, claims, person.id, Number(receipt.subtotal), Number(receipt.service_charge)).owed)}
              onPress={() => setSelectedId(person.id)}
            />
          ))}
        </ScrollView>
        <Text style={styles.assignHint}>Tap a line to assign it to {selected.name}.</Text>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 120 }]}>
        <Animated.View entering={FadeIn.duration(360)}>
          {receipt.image_url ? (
            <Image accessibilityLabel="Scanned receipt" contentFit="cover" source={{ uri: toImageUri(receipt.image_url) }} style={styles.thumbnail} />
          ) : null}

          <View style={styles.listContainer}>
            {items.map((item) => (
              <ReceiptLine
                key={item.id}
                item={item}
                currency={currency}
                claimants={claims[item.id] ?? []}
                amountLabel={money(Number(item.price))}
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
              <Text style={styles.compactShareLabel}>{selected.name}'s Share</Text>
              <Text style={styles.compactShareValue}>{money(share.owed)}</Text>
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

function PersonPill({ person, selected, totalLabel, onPress }: { person: Person; selected: boolean; totalLabel: string; onPress: () => void }) {
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

function ReceiptLine({ item, currency, claimants, amountLabel, onPress }: { item: Item; currency: string; claimants: PersonId[]; amountLabel: string; onPress: () => void }) {
  const names = claimants.flatMap((id) => {
    const name = personById(id)?.name;
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
              const person = personById(id);
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