import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { FadeIn, FadeInRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Frost } from '@/components/frost';
import { NightScreen } from '@/components/night-screen';
import { Colors, Spacing } from '@/constants/theme';
import { mediumHaptic, successHaptic, tickHaptic } from '@/lib/haptics';
import { SnapPressable, useSnapScale } from '@/lib/use-snap-scale';
import { parseReceiptParam, type ParsedReceipt, type ReceiptItem } from '@/lib/parse-receipt';

const PEOPLE = [
  { id: 'me', name: 'Me', initial: 'M', color: '#38BDF8' },
  { id: 'sarah', name: 'Sarah', initial: 'S', color: '#C084FC' },
  { id: 'mike', name: 'Mike', initial: 'Mi', color: '#22D3EE' },
] as const;

const ICE = '#38BDF8';
const NAVY = '#030712';

type Person = (typeof PEOPLE)[number];
type PersonId = Person['id'];

const RECEIPT_ITEMS = [
  { quantity: 3, name: 'Cheeseburger', amount: 36 },
  { quantity: 1, name: 'Spicy Wings', amount: 8.5 },
  { quantity: 4, name: 'Pale Ale', amount: 22 },
] as const;

const FALLBACK_RECEIPT: ParsedReceipt = {
  items: RECEIPT_ITEMS.map((item) => ({ ...item })),
  subtotal: 66.5,
  serviceCharge: 8.31,
  total: 74.81,
  currency: 'GBP',
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

function toImageUri(uri: string) {
  if (/^(file|content|ph|assets-library|http|data):/i.test(uri)) {
    return uri;
  }

  return `data:image/jpeg;base64,${uri}`;
}

function personById(id: string) {
  return PEOPLE.find((person) => person.id === id);
}

function shareFor(receipt: ParsedReceipt, claims: Record<number, PersonId[]>, personId: PersonId) {
  const subtotalShare = roundMoney(
    receipt.items.reduce((sum, item, index) => {
      const claimants = claims[index] ?? [];
      if (!claimants.includes(personId) || claimants.length === 0) {
        return sum;
      }
      return sum + item.amount / claimants.length;
    }, 0),
  );
  const serviceShare = roundMoney(
    receipt.subtotal > 0 ? (subtotalShare / receipt.subtotal) * receipt.serviceCharge : 0,
  );

  return {
    subtotalShare,
    serviceShare,
    owed: roundMoney(subtotalShare + serviceShare),
  };
}

function formatBreakdown(receipt: ParsedReceipt, claims: Record<number, PersonId[]>) {
  const assigned = PEOPLE.filter((person) =>
    Object.values(claims).some((claimants) => claimants.includes(person.id)),
  );

  if (assigned.length === 0) {
    return 'Receipt Breakdown: No items assigned yet. (Includes tax & tip)';
  }

  const parts = assigned.map((person) => {
    const { owed } = shareFor(receipt, claims, person.id);
    return `${person.name} owes ${formatMoney(owed, receipt.currency)}`;
  });

  return `Receipt Breakdown: ${parts.join(' | ')} (Includes tax & tip)`;
}

export default function SplitScreen() {
  const insets = useSafeAreaInsets();
  const { imageUri: imageUriParam, receipt: receiptParam } = useLocalSearchParams<{
    imageUri?: string | string[];
    receipt?: string | string[];
  }>();
  const imageUri = firstParam(imageUriParam);
  const receiptKey = firstParam(receiptParam) ?? 'fallback';
  const receipt = parseReceiptParam(firstParam(receiptParam)) ?? FALLBACK_RECEIPT;
  const [selectedId, setSelectedId] = useState<PersonId>('me');
  const [claimState, setClaimState] = useState<{ key: string; claims: Record<number, PersonId[]> }>({
    key: receiptKey,
    claims: {},
  });
  if (claimState.key !== receiptKey) {
    setClaimState({ key: receiptKey, claims: {} });
  }
  const claims = claimState.key === receiptKey ? claimState.claims : {};
  const selected = personById(selectedId) ?? PEOPLE[0];
  const share = shareFor(receipt, claims, selected.id);
  const money = (amount: number) => formatMoney(amount, receipt.currency);
  const scrollAnchor = useRef(0);

  function onPeopleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const x = event.nativeEvent.contentOffset.x;
    if (Math.abs(x - scrollAnchor.current) < 64) {
      return;
    }

    scrollAnchor.current = x;
    tickHaptic();
  }

  async function shareBreakdown() {
    try {
      await Share.share({ message: formatBreakdown(receipt, claims) });
    } catch {
      // The share sheet was dismissed or is unavailable.
    }
  }

  function toggleClaim(index: number) {
    setClaimState((current) => {
      const existing = current.claims[index] ?? [];
      const next = existing.includes(selected.id)
        ? existing.filter((id) => id !== selected.id)
        : [...existing, selected.id];
      return {
        key: receiptKey,
        claims: { ...current.claims, [index]: next },
      };
    });
  }

  return (
    <NightScreen>
      <View
        style={[
          styles.peopleBar,
          { paddingTop: Platform.OS === 'web' ? 88 : insets.top + Spacing.three },
        ]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={32}
          onScroll={onPeopleScroll}
          contentContainerStyle={styles.peopleRow}>
          {PEOPLE.map((person) => (
            <PersonPill
              key={person.id}
              person={person}
              selected={person.id === selected.id}
              totalLabel={money(shareFor(receipt, claims, person.id).owed)}
              onPress={() => setSelectedId(person.id)}
            />
          ))}
        </ScrollView>
        <Text style={styles.assignHint}>Tap a line to assign it to {selected.name}.</Text>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Spacing.four }]}>
        <Animated.View entering={FadeIn.duration(360)}>
          {imageUri ? (
            <Image
              accessibilityLabel="Scanned receipt"
              contentFit="cover"
              source={{ uri: toImageUri(imageUri) }}
              style={styles.thumbnail}
            />
          ) : (
            <Text style={styles.placeholderText}>Snap a receipt to see it here.</Text>
          )}

          <View>
            {receipt.items.map((item, index) => (
              <ReceiptLine
                key={`${item.name}-${index}`}
                item={item}
                claimants={claims[index] ?? []}
                amountLabel={money(item.amount)}
                onPress={() => toggleClaim(index)}
              />
            ))}
          </View>
        </Animated.View>
      </ScrollView>

      <View style={[styles.deckWrap, { paddingBottom: Math.max(insets.bottom, Spacing.three) + 64 }]}>
        <Frost style={styles.deck}>
          <LedgerRow label="Subtotal" value={money(receipt.subtotal)} />
          <LedgerRow label="Service Charge" value={money(receipt.serviceCharge)} />
          <View style={styles.totalRule} />
          <LedgerRow label="Total" value={money(receipt.total)} emphasis />

          <Animated.View key={selected.id} entering={FadeIn.duration(220)}>
            <View style={styles.statement}>
              <Text style={styles.statementKicker}>Individual Owed</Text>
              <View style={styles.statementHead}>
                <Text style={styles.statementName}>{selected.name}</Text>
                <Text style={styles.statementAmount}>{money(share.owed)}</Text>
              </View>
              <LedgerRow label="Share of subtotal" value={money(share.subtotalShare)} />
              <LedgerRow label="Share of service charge" value={money(share.serviceShare)} />
            </View>
          </Animated.View>

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Share Breakdown"
            activeOpacity={0.85}
            onPress={() => {
              successHaptic();
              void shareBreakdown();
            }}
            style={styles.sharePress}>
            <LinearGradient
              colors={['#7DD3FC', '#38BDF8']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.shareButton}>
              <Text style={styles.shareLabel}>Share Breakdown</Text>
            </LinearGradient>
          </TouchableOpacity>
        </Frost>
      </View>
    </NightScreen>
  );
}

function LedgerRow({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <View style={styles.ledgerRow}>
      <Text style={emphasis ? styles.totalLabel : styles.mutedLabel}>{label}</Text>
      <Text style={emphasis ? styles.totalValue : styles.mutedValue}>{value}</Text>
    </View>
  );
}

function PersonPill({
  person,
  selected,
  totalLabel,
  onPress,
}: {
  person: Person;
  selected: boolean;
  totalLabel: string;
  onPress: () => void;
}) {
  const snap = useSnapScale(selected);

  return (
    <SnapPressable
      accessibilityRole="button"
      accessibilityLabel={`${person.name}, ${totalLabel}`}
      accessibilityState={{ selected }}
      onPressIn={snap.onPressIn}
      onPressOut={snap.onPressOut}
      onPress={() => {
        if (!selected) {
          tickHaptic();
        }
        onPress();
      }}
      style={[styles.pillPress, snap.style]}>
      <Frost
        style={[
          styles.pill,
          selected && {
            borderColor: ICE,
            shadowColor: ICE,
            shadowOpacity: 0.45,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 0 },
          },
        ]}>
        <View style={[styles.pillMark, { backgroundColor: `${person.color}33`, borderColor: person.color }]}>
          <Text style={[styles.pillInitial, { color: person.color }]} numberOfLines={1}>
            {person.initial}
          </Text>
        </View>
        <View style={styles.pillCopy}>
          <Text style={styles.pillName} numberOfLines={1}>
            {person.name}
          </Text>
          <Text style={[styles.pillTotal, selected && styles.pillTotalSelected]} numberOfLines={1}>
            {totalLabel}
          </Text>
        </View>
      </Frost>
    </SnapPressable>
  );
}

function ReceiptLine({
  item,
  claimants,
  amountLabel,
  onPress,
}: {
  item: ReceiptItem;
  claimants: PersonId[];
  amountLabel: string;
  onPress: () => void;
}) {
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
          ? `${item.quantity}x ${item.name}, claimed by ${names.join(', ')}`
          : `${item.quantity}x ${item.name}, unclaimed`
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
          {item.name}
        </Text>
        {claimants.length > 0 ? (
          <View style={styles.badges}>
            {claimants.map((id) => {
              const person = personById(id);
              if (!person) {
                return null;
              }
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
  peopleBar: {
    paddingBottom: Spacing.two,
    gap: Spacing.three,
  },
  peopleRow: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    gap: Spacing.two,
    alignItems: 'stretch',
  },
  pillPress: {
    width: 156,
    height: 64,
  },
  pill: {
    width: 156,
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 18,
    paddingHorizontal: 12,
  },
  pillMark: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  pillInitial: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  pillCopy: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  pillName: {
    color: Colors.text,
    fontSize: 15,
    lineHeight: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  pillTotal: {
    marginTop: 2,
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '600',
    letterSpacing: -0.1,
    fontVariant: ['tabular-nums'],
  },
  pillTotalSelected: {
    color: ICE,
  },
  assignHint: {
    color: Colors.textSecondary,
    fontSize: 13,
    letterSpacing: -0.1,
    paddingHorizontal: Spacing.four,
  },
  content: {
    paddingTop: Spacing.two,
  },
  thumbnail: {
    width: '100%',
    height: 168,
    marginBottom: Spacing.three,
  },
  placeholderText: {
    color: Colors.textSecondary,
    fontSize: 15,
    letterSpacing: -0.1,
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(30, 41, 59, 0.4)',
  },
  lineCopy: {
    flex: 1,
    gap: Spacing.two,
  },
  lineName: {
    color: Colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  lineQty: {
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  linePrice: {
    color: Colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.3,
    fontVariant: ['tabular-nums'],
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  badge: {
    minWidth: 28,
    height: 24,
    paddingHorizontal: Spacing.two,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  deckWrap: {
    paddingHorizontal: Spacing.four,
  },
  deck: {
    borderRadius: 28,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    paddingBottom: Spacing.three,
    gap: Spacing.three,
  },
  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  mutedLabel: {
    color: Colors.textSecondary,
    fontSize: 15,
    fontWeight: '500',
    letterSpacing: -0.1,
  },
  mutedValue: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.2,
    fontVariant: ['tabular-nums'],
  },
  totalRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(30, 41, 59, 0.4)',
  },
  totalLabel: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  totalValue: {
    color: ICE,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
  },
  statement: {
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    gap: Spacing.two,
    borderWidth: 1,
    borderColor: ICE,
    backgroundColor: 'rgba(56, 189, 248, 0.06)',
  },
  statementKicker: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  statementHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statementName: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  statementAmount: {
    color: ICE,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
  },
  sharePress: {
    borderRadius: 999,
    shadowColor: ICE,
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  shareButton: {
    minHeight: 56,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  shareLabel: {
    color: NAVY,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
});
