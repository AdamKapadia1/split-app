import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, { FadeIn, FadeInRight, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Frost } from '@/components/frost';
import { NightScreen } from '@/components/night-screen';
import { Colors, Spacing } from '@/constants/theme';
import { tapHaptic } from '@/lib/haptics';
import { parseReceiptParam, type ParsedReceipt, type ReceiptItem } from '@/lib/parse-receipt';

const PEOPLE = [
  { id: 'me', name: 'Me', initial: 'M', color: '#D6FF4A' },
  { id: 'sarah', name: 'Sarah', initial: 'S', color: '#C084FC' },
  { id: 'mike', name: 'Mike', initial: 'Mi', color: '#22D3EE' },
] as const;

const ICE = '#38BDF8';

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
                isLast={index === receipt.items.length - 1}
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
            <Frost style={[styles.statement, { borderColor: selected.color }]}>
              <Text style={styles.statementKicker}>Individual Owed</Text>
              <View style={styles.statementHead}>
                <Text style={[styles.statementName, { color: selected.color }]}>{selected.name}</Text>
                <Text style={[styles.statementAmount, { color: selected.color }]}>{money(share.owed)}</Text>
              </View>
              <LedgerRow label="Share of subtotal" value={money(share.subtotalShare)} />
              <LedgerRow label="Share of service charge" value={money(share.serviceShare)} />
            </Frost>
          </Animated.View>

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Share Breakdown"
            activeOpacity={0.85}
            onPress={() => {
              tapHaptic();
              void shareBreakdown();
            }}
            style={styles.sharePress}>
            <LinearGradient
              colors={['#F4FFB0', '#D6FF4A', '#A3E635']}
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
  const scale = useSharedValue(1);

  useEffect(() => {
    scale.value = withSpring(selected ? 1.03 : 1, { damping: 16, stiffness: 240 });
  }, [scale, selected]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${person.name}, ${totalLabel}`}
      accessibilityState={{ selected }}
      onPress={() => {
        tapHaptic();
        onPress();
      }}>
      <Animated.View style={animatedStyle}>
        <Frost
          style={[
            styles.pill,
            selected && {
              borderColor: ICE,
              shadowColor: ICE,
              shadowOpacity: 0.55,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: 0 },
            },
          ]}>
          <View style={[styles.pillMark, { backgroundColor: `${person.color}33`, borderColor: person.color }]}>
            <Text style={[styles.pillInitial, { color: person.color }]}>{person.initial}</Text>
          </View>
          <View>
            <Text style={styles.pillName}>{person.name}</Text>
            <Text style={[styles.pillTotal, selected && { color: ICE }]}>{totalLabel}</Text>
          </View>
        </Frost>
      </Animated.View>
    </Pressable>
  );
}

function ReceiptLine({
  item,
  claimants,
  amountLabel,
  isLast,
  onPress,
}: {
  item: ReceiptItem;
  claimants: PersonId[];
  amountLabel: string;
  isLast: boolean;
  onPress: () => void;
}) {
  const names = claimants.flatMap((id) => {
    const name = personById(id)?.name;
    return name ? [name] : [];
  });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        names.length > 0
          ? `${item.quantity}x ${item.name}, claimed by ${names.join(', ')}`
          : `${item.quantity}x ${item.name}, unclaimed`
      }
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={[styles.line, !isLast && styles.lineRule]}>
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  peopleBar: {
    paddingBottom: Spacing.two,
    gap: Spacing.three,
  },
  peopleRow: {
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderRadius: 22,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    minWidth: 168,
  },
  pillMark: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillInitial: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  pillName: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  pillTotal: {
    marginTop: 2,
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: -0.1,
    fontVariant: ['tabular-nums'],
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
  },
  lineRule: {
    borderBottomWidth: StyleSheet.hairlineWidth,
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
    color: Colors.accent,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
  },
  statement: {
    borderRadius: 20,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    gap: Spacing.two,
    borderWidth: 1,
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
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  statementAmount: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
  },
  sharePress: {
    borderRadius: 999,
    shadowColor: '#D6FF4A',
    shadowOpacity: 0.38,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  shareButton: {
    minHeight: 56,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  shareLabel: {
    color: '#071006',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
});
