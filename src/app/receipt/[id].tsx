import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { type SyncStatus } from '@/hooks/useRealtimeSync';
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

// 1. MEMOIZED ITEM ROW: Fixes the tap delay so the green box appears instantly
const LedgerItem = memo(({ item, isSelected, onToggle }: { item: Item, isSelected: boolean, onToggle: (id: string) => void }) => (
  <Pressable 
    onPress={() => onToggle(item.id)}
    style={[styles.itemCard, isSelected && styles.itemCardSelected]}
  >
    <Text style={styles.itemName}>{item.name}</Text>
    <Text style={styles.itemPrice}>£{Number(item.price).toFixed(2)}</Text>
  </Pressable>
));

export default function ReceiptLedgerScreen() {
  const { id: idParam } = useLocalSearchParams<{ id?: string | string[] }>();
  // Helper to safely extract string ID whether it's an array or string
  const receiptId = Array.isArray(idParam) ? idParam[0] : idParam;
  
  const [receiptData, setReceiptData] = useState<Ledger | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  // Local state for instantly toggling the UI before running heavy math
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());

  const loadLedger = useCallback(async () => {
    if (!receiptId) return;
    try {
      setIsLoading(true);
      const data = await receiptService.getReceiptWithItems(receiptId);
      setReceiptData(data as Ledger);
    } catch (error) {
      console.error("Failed to load ledger:", error);
    } finally {
      setIsLoading(false);
    }
  }, [receiptId]);

  useEffect(() => {
    loadLedger();
  }, [loadLedger]);

  const toggleItem = useCallback((itemId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedItemIds(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);

  if (isLoading || !receiptData) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#4ade80" />
      </View>
    );
  }

  const { receipt, items } = receiptData;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Ledger', headerStyle: { backgroundColor: '#0f172a' }, headerTintColor: '#fff' }} />
      
      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        {/* 2. NEW UI HEADER: Restaurant Name & Actionable Booking Link */}
        <View style={styles.headerContainer}>
          <Text style={styles.restaurantName}>
            {receipt.restaurant_name || 'Ledger'}
          </Text>
          
          {receipt.website && (
            <Pressable 
              onPress={() => Linking.openURL(receipt.website.startsWith('http') ? receipt.website : `https://${receipt.website}`)}
              style={styles.bookButton}
            >
              <Text style={styles.bookButtonText}>Book again</Text>
            </Pressable>
          )}
        </View>

        {/* 3. ITEMS LIST: Uses the fast-rendering Memoized component */}
        <View style={styles.itemsContainer}>
          {items.map(item => (
            <LedgerItem 
              key={item.id} 
              item={item} 
              isSelected={selectedItemIds.has(item.id)} 
              onToggle={toggleItem} 
            />
          ))}
        </View>

        {/* 4. TOTALS FOOTER */}
        <View style={styles.totalsContainer}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal</Text>
            <Text style={styles.totalValue}>£{Number(receipt.subtotal).toFixed(2)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Tax</Text>
            <Text style={styles.totalValue}>£{Number(receipt.tax).toFixed(2)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Service Charge</Text>
            <Text style={styles.totalValue}>£{Number(receipt.tip || 0).toFixed(2)}</Text>
          </View>
          <View style={[styles.totalRow, styles.grandTotalRow]}>
            <Text style={styles.grandTotalLabel}>Total</Text>
            <Text style={styles.grandTotalValue}>£{Number(receipt.total).toFixed(2)}</Text>
          </View>
        </View>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a', // Midnight Navy background
  },
  centerContainer: {
    flex: 1,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  headerContainer: {
    alignItems: 'center',
    marginBottom: 24,
  },
  restaurantName: {
    color: 'white',
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  bookButton: {
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#1e293b',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  bookButtonText: {
    color: '#4ade80',
    fontSize: 14,
    fontWeight: '600',
  },
  itemsContainer: {
    gap: 12,
    marginBottom: 32,
  },
  itemCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  itemCardSelected: {
    borderColor: '#4ade80',
    backgroundColor: '#1e293b', // Keeps the navy interior, adds green border
  },
  itemName: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  itemPrice: {
    color: '#38bdf8', // Light blue price text from your design
    fontSize: 16,
    fontWeight: '600',
  },
  totalsContainer: {
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingTop: 16,
    gap: 8,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: {
    color: '#94a3b8',
    fontSize: 14,
  },
  totalValue: {
    color: 'white',
    fontSize: 14,
  },
  grandTotalRow: {
    marginTop: 8,
  },
  grandTotalLabel: {
    color: 'white',
    fontSize: 20,
    fontWeight: 'bold',
  },
  grandTotalValue: {
    color: '#38bdf8',
    fontSize: 20,
    fontWeight: 'bold',
  },
});