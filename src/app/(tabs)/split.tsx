import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Surface } from '@/components/surface';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { tapHaptic } from '@/lib/haptics';
import { parseReceiptParam, type ParsedReceipt, type ReceiptItem } from '@/lib/parse-receipt';

const PEOPLE = [
  { id: 'me', name: 'Me', initial: 'M', color: '#D6FF4A' },
  { id: 'sarah', name: 'Sarah', initial: 'S', color: '#C084FC' },
  { id: 'mike', name: 'Mike', initial: 'Mi', color: '#22D3EE' },
] as const;

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
    <View style={styles.screen}>
      <View
        style={[
          styles.peopleBar,
          { paddingTop: Platform.OS === 'web' ? 88 : insets.top + Spacing.three },
        ]}>
        <View style={styles.peopleRow}>
          {PEOPLE.map((person) => (
            <PersonAvatar
              key={person.id}
              person={person}
              selected={person.id === selected.id}
              onPress={() => setSelectedId(person.id)}
            />
          ))}
        </View>
        <Text style={styles.assignHint}>Tap a line to assign it to {selected.name}.</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        <Animated.View entering={FadeIn.duration(360)} style={styles.receipt}>
        {imageUri ? (
          <Image
            accessibilityLabel="Scanned receipt"
            contentFit="cover"
            source={{ uri: toImageUri(imageUri) }}
            style={styles.thumbnail}
          />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>Snap a receipt to see it here.</Text>
          </View>
        )}

        <View style={styles.items}>
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

      <View style={[styles.summaryWrap, { paddingBottom: Math.max(insets.bottom, Spacing.three) + 72 }]}>
        <Surface style={styles.totals}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Subtotal</Text>
          <Text style={styles.totalValue}>{money(receipt.subtotal)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Service Charge</Text>
          <Text style={styles.totalValue}>{money(receipt.serviceCharge)}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.totalRow}>
          <Text style={styles.grandLabel}>Total</Text>
          <Text style={styles.grandValue}>{money(receipt.total)}</Text>
        </View>

        <Animated.View key={selected.id} entering={FadeIn.duration(220)}>
          <Surface style={[styles.owed, { borderColor: selected.color }]}>
          <Text style={styles.owedKicker}>Individual Owed</Text>
          <View style={styles.totalRow}>
            <Text style={[styles.owedName, { color: selected.color }]}>{selected.name}</Text>
            <Text style={[styles.owedAmount, { color: selected.color }]}>{money(share.owed)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Share of subtotal</Text>
            <Text style={styles.totalValue}>{money(share.subtotalShare)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Share of service charge</Text>
            <Text style={styles.totalValue}>{money(share.serviceShare)}</Text>
          </View>
          </Surface>
        </Animated.View>

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Share Breakdown"
          activeOpacity={0.8}
          onPress={() => {
            tapHaptic();
            void shareBreakdown();
          }}
          style={styles.shareButton}>
          <Text style={styles.shareLabel}>Share Breakdown</Text>
        </TouchableOpacity>
        </Surface>
      </View>
    </View>
  );
}

function PersonAvatar({
  person,
  selected,
  onPress,
}: {
  person: Person;
  selected: boolean;
  onPress: () => void;
}) {
  const scale = useSharedValue(1);

  useEffect(() => {
    scale.value = withSpring(selected ? 1.06 : 1, { damping: 16, stiffness: 240 });
  }, [scale, selected]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={person.name}
      accessibilityState={{ selected }}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={styles.personButton}>
      <Animated.View
        style={[
          styles.avatar,
          { backgroundColor: `${person.color}22`, borderColor: selected ? person.color : 'transparent' },
          animatedStyle,
        ]}>
        <Text style={[styles.initial, { color: person.color }]}>{person.initial}</Text>
      </Animated.View>
      <Text style={[styles.personName, selected && { color: person.color }]}>{person.name}</Text>
    </Pressable>
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
  const scale = useSharedValue(1);
  const claimKey = claimants.join(',');
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (!hasAnimated.current) {
      hasAnimated.current = true;
      return;
    }
    scale.value = withSequence(withSpring(0.98, { damping: 18, stiffness: 320 }), withSpring(1));
  }, [claimKey, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const primary = claimants.length === 1 ? personById(claimants[0]) : undefined;
  const names = claimants.flatMap((id) => {
    const name = personById(id)?.name;
    return name ? [name] : [];
  }).join(', ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        names ? `${item.quantity}x ${item.name}, claimed by ${names}` : `${item.quantity}x ${item.name}, unclaimed`
      }
      onPress={() => {
        tapHaptic();
        onPress();
      }}>
      <Animated.View style={animatedStyle}>
        <Surface
          style={[
            styles.itemRow,
            primary ? { borderColor: primary.color } : claimants.length > 1 ? styles.itemSplit : null,
          ]}>
          {primary ? <View style={[styles.tint, { backgroundColor: `${primary.color}1A` }]} /> : null}
        {claimants.length > 0 ? (
          <View style={styles.colorStack}>
            {claimants.map((id) => (
              <View
                key={id}
                style={[styles.colorSegment, { backgroundColor: personById(id)?.color ?? Colors.accent }]}
              />
            ))}
          </View>
        ) : null}
        <View style={styles.itemBody}>
          <View style={styles.itemMain}>
            <Text style={styles.quantity}>{item.quantity}x</Text>
            <Text style={styles.itemName}>{item.name}</Text>
            <Text style={styles.itemAmount}>{amountLabel}</Text>
          </View>
          {claimants.length > 0 ? (
            <View style={styles.indicators}>
              {claimants.map((id) => {
                const person = personById(id);
                if (!person) {
                  return null;
                }
                return (
                  <View key={id} style={[styles.indicator, { borderColor: person.color }]}>
                    <View style={[styles.indicatorDot, { backgroundColor: person.color }]} />
                    <Text style={[styles.indicatorName, { color: person.color }]}>{person.name}</Text>
                  </View>
                );
              })}
              {claimants.length > 1 ? (
                <Text style={styles.splitNote}>split {claimants.length} ways</Text>
              ) : null}
            </View>
          ) : null}
        </View>
        </Surface>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  peopleBar: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
    gap: Spacing.three,
  },
  peopleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  personButton: {
    alignItems: 'center',
    gap: Spacing.two,
    minWidth: 84,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    fontSize: 20,
    fontWeight: '700',
  },
  personName: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  assignHint: {
    color: Colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
  content: {
    paddingHorizontal: Spacing.four,
  },
  receipt: {
    gap: Spacing.four,
  },
  thumbnail: {
    width: '100%',
    height: 180,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.backgroundElement,
  },
  placeholder: {
    width: '100%',
    height: 180,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.backgroundElement,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  placeholderText: {
    color: Colors.textSecondary,
    fontSize: 16,
    textAlign: 'center',
  },
  items: {
    gap: Spacing.two,
  },
  itemRow: {
    flexDirection: 'row',
  },
  itemSplit: {
    borderColor: Colors.border,
  },
  tint: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  colorStack: {
    width: 6,
  },
  colorSegment: {
    flex: 1,
    minHeight: 8,
  },
  itemBody: {
    flex: 1,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    gap: Spacing.two,
  },
  itemMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  quantity: {
    color: Colors.textSecondary,
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 28,
  },
  itemName: {
    flex: 1,
    color: Colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  itemAmount: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  indicators: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.two,
  },
  indicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  indicatorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  indicatorName: {
    fontSize: 12,
    fontWeight: '700',
  },
  splitNote: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '500',
  },
  summaryWrap: {
    paddingHorizontal: Spacing.four,
  },
  totals: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.three,
    gap: Spacing.two,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  totalLabel: {
    color: Colors.textSecondary,
    fontSize: 15,
    fontWeight: '500',
  },
  totalValue: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.backgroundSelected,
    marginVertical: Spacing.one,
  },
  grandLabel: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  grandValue: {
    color: Colors.accent,
    fontSize: 22,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  owed: {
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    gap: Spacing.two,
  },
  owedKicker: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  owedName: {
    fontSize: 16,
    fontWeight: '700',
  },
  owedAmount: {
    fontSize: 22,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  shareButton: {
    marginTop: Spacing.two,
    backgroundColor: Colors.accent,
    borderRadius: 999,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  shareLabel: {
    color: Colors.background,
    fontSize: 17,
    fontWeight: '700',
  },
});
