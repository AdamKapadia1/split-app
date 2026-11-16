import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors, Spacing } from '@/constants/theme';
import { parseReceiptParam, type ParsedReceipt } from '@/lib/parse-receipt';

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

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function toImageUri(uri: string) {
  if (/^(file|content|ph|assets-library|http|data):/i.test(uri)) {
    return uri;
  }

  return `data:image/jpeg;base64,${uri}`;
}

export default function SplitScreen() {
  const insets = useSafeAreaInsets();
  const { imageUri: imageUriParam, receipt: receiptParam } = useLocalSearchParams<{
    imageUri?: string | string[];
    receipt?: string | string[];
  }>();
  const imageUri = firstParam(imageUriParam);
  const receipt = parseReceiptParam(firstParam(receiptParam)) ?? FALLBACK_RECEIPT;
  const money = (amount: number) => formatMoney(amount, receipt.currency);

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: Platform.OS === 'web' ? 88 : insets.top + Spacing.four,
            paddingBottom: insets.bottom + Spacing.six,
          },
        ]}>
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
            <View key={`${item.name}-${index}`} style={styles.itemRow}>
              <Text style={styles.quantity}>{item.quantity}x</Text>
              <Text style={styles.itemName}>{item.name}</Text>
              <Text style={styles.itemAmount}>{money(item.amount)}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={[styles.totals, { paddingBottom: Math.max(insets.bottom, Spacing.three) + 72 }]}>
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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    paddingHorizontal: Spacing.four,
    gap: Spacing.four,
  },
  thumbnail: {
    width: '100%',
    height: 220,
    borderRadius: 24,
    backgroundColor: Colors.backgroundElement,
  },
  placeholder: {
    width: '100%',
    height: 220,
    borderRadius: 24,
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
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: Colors.backgroundElement,
    borderRadius: 18,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  quantity: {
    color: Colors.accent,
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
  totals: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    gap: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.backgroundSelected,
    backgroundColor: Colors.background,
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
});
