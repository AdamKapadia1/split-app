import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useRealtimeSync, type SyncStatus } from '@/hooks/useRealtimeSync';
import { receiptService } from '@/services/ReceiptService';
import type { Item, Receipt, Split } from '@/types/database.types';

const MOCK_USER_ID = '7924d43c-1f07-4bba-9762-4b62f0b6b071';

type Ledger = {
  receipt: Receipt;
  items: Item[];
  splits: Split[];
};

const STATUS_COLOR: Record<SyncStatus, string> = {
  live: '#10B981',
  connecting: '#F59E0B',
  error: '#EF4444',
  disconnected: '#EF4444',
};

export default function ReceiptLedgerScreen() {
  const { id: idParam } = useLocalSearchParams<{ id?: string | string[] }>();
  const receiptId = firstParam(idParam);
  const [receiptData, setReceiptData] = useState<Ledger | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadLedger = useCallback(() => {
    if (!receiptId) {
      return;
    }

    void receiptService.getReceiptWithItems(receiptId).then(
      (ledger) => {
        setReceiptData(ledger);
        setIsLoading(false);
      },
      (error: unknown) => {
        console.error('[Ledger][loadLedger] Failed to load receipt:', error);
        setIsLoading(false);
      },
    );
  }, [receiptId]);

  useEffect(() => {
    loadLedger();
  }, [loadLedger]);

  const { status } = useRealtimeSync(receiptId, loadLedger);

  const receipt = receiptData?.receipt ?? null;
  const items = receiptData?.items ?? [];
  const splits = receiptData?.splits ?? [];

  function claimItem(itemId: string) {
    if (!receiptId) {
      return;
    }

    void Haptics.selectionAsync();
    void receiptService.toggleItemClaim(itemId, MOCK_USER_ID, receiptId).catch((error: unknown) => {
      console.error('[Ledger][toggleItemClaim] Failed to toggle claim:', error);
    });
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: 'Ledger',
          headerShown: true,
          headerShadowVisible: false,
          headerStyle: { backgroundColor: '#0B0F19' },
          headerTintColor: '#F8FAFC',
          headerTitleStyle: { color: '#F8FAFC' },
          headerRight: () => <LiveDot status={status} />,
        }}
      />

      {receiptId && isLoading && receiptData === null ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#38BDF8" size="large" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {receipt?.merchant_name ? <Text style={styles.merchant}>{receipt.merchant_name}</Text> : null}
          {items.map((item) => {
            const isClaimedByMe = splits.some((split) => split.item_id === item.id && split.user_id === MOCK_USER_ID);
            const label = item.original_name || item.display_name || 'Item';

            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={isClaimedByMe ? `${label}, claimed by you` : label}
                accessibilityState={{ selected: isClaimedByMe }}
                onPress={() => claimItem(item.id)}
                style={[styles.card, isClaimedByMe && styles.cardClaimed]}>
                <Text style={[styles.itemName, isClaimedByMe && styles.claimedText]}>{label}</Text>
                <Text style={[styles.itemPrice, isClaimedByMe && styles.claimedText]}>{formatPounds(item.price)}</Text>
              </Pressable>
            );
          })}
          <View style={styles.footer}>
            <TotalRow label="Subtotal" value={formatPounds(receipt?.subtotal ?? 0)} />
            <TotalRow label="Tax" value={formatPounds(receipt?.tax_amount ?? 0)} />
            <TotalRow label="Service Charge" value={formatPounds(receipt?.service_charge ?? 0)} />
            <TotalRow label="Total" value={formatPounds(receipt?.total_amount ?? 0)} emphasis />
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function LiveDot({ status }: { status: SyncStatus }) {
  return (
    <View
      accessibilityLabel={`Connection ${status}`}
      style={[styles.dot, { backgroundColor: STATUS_COLOR[status] }]}
    />
  );
}

function TotalRow({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <View style={styles.totalRow}>
      <Text style={emphasis ? styles.totalLabel : styles.footerLabel}>{label}</Text>
      <Text style={emphasis ? styles.totalValue : styles.footerValue}>{value}</Text>
    </View>
  );
}

function firstParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  return raw;
}

function formatPounds(value: number): string {
  const amount = Number.isFinite(value) ? value : 0;
  return `£${amount.toFixed(2)}`;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0B0F19',
    padding: 16,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingBottom: 24,
  },
  merchant: {
    color: '#94A3B8',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  cardClaimed: {
    backgroundColor: '#064E3B',
    borderWidth: 1,
    borderColor: '#10B981',
  },
  claimedText: {
    color: '#34D399',
  },
  itemName: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  itemPrice: {
    color: '#38BDF8',
    fontSize: 16,
    fontWeight: '700',
  },
  footer: {
    borderTopWidth: 1,
    borderColor: '#334155',
    paddingTop: 16,
    marginTop: 16,
    gap: 10,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  footerLabel: {
    color: '#94A3B8',
    fontSize: 15,
  },
  footerValue: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '600',
  },
  totalLabel: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '700',
  },
  totalValue: {
    color: '#38BDF8',
    fontSize: 22,
    fontWeight: '700',
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 8,
  },
});
