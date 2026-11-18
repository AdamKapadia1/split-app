import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { supabase } from '@/lib/supabase';
import type { Receipt } from '@/types/database.types';

type GroupReceipt = Receipt & {
  restaurant_name?: string | null;
};

const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstParam(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() ? raw.trim() : null;
}

function receiptName(receipt: GroupReceipt) {
  const restaurant = receipt.restaurant_name?.trim();
  if (restaurant) return restaurant;
  const merchant = receipt.merchant_name?.trim();
  if (merchant) return merchant;
  const date = new Date(receipt.created_at).toLocaleDateString('en-GB', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `Receipt from ${date}`;
}

export default function GroupLedgerScreen() {
  const router = useRouter();
  const { id: idParam } = useLocalSearchParams<{ id?: string | string[] }>();
  const groupId = firstParam(idParam);
  const isValidId = groupId !== null && GROUP_ID.test(groupId);

  const [groupName, setGroupName] = useState('Group');
  const [receipts, setReceipts] = useState<GroupReceipt[]>([]);
  const [isLoading, setIsLoading] = useState(isValidId);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [missing, setMissing] = useState(!isValidId);

  const goBack = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  const loadLedger = useCallback(async (mode: 'load' | 'refresh' = 'load') => {
    if (!groupId || !GROUP_ID.test(groupId)) {
      setMissing(true);
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }

    if (!supabase) {
      setMissing(true);
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }

    if (mode === 'refresh') {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const [groupResult, receiptResult] = await Promise.all([
        supabase.from('groups').select('name').eq('id', groupId).maybeSingle(),
        supabase.from('receipts').select('*').eq('group_id', groupId).order('created_at', { ascending: false }),
      ]);

      if (groupResult.error) throw groupResult.error;
      if (receiptResult.error) throw receiptResult.error;
      if (!groupResult.data) {
        setMissing(true);
        setReceipts([]);
        return;
      }

      setMissing(false);
      setGroupName(typeof groupResult.data.name === 'string' && groupResult.data.name.trim() ? groupResult.data.name : 'Group');
      setReceipts((receiptResult.data ?? []) as GroupReceipt[]);
    } catch (error) {
      console.error('Failed to load group ledger:', error);
      setMissing(true);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [groupId]);

  useFocusEffect(
    useCallback(() => {
      void loadLedger();
    }, [loadLedger]),
  );

  const spent = receipts.reduce((sum, receipt) => sum + Number(receipt.total_amount || 0), 0);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={goBack}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={22} color="#38BDF8" />
          <Text style={styles.backLabel}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {missing ? 'Group' : groupName}
        </Text>
        <Text style={styles.subtitle}>
          {missing ? 'This group is not available.' : `£${spent.toFixed(2)} across ${receipts.length} ${receipts.length === 1 ? 'receipt' : 'receipts'}`}
        </Text>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#38BDF8" style={styles.loader} />
      ) : (
        <FlatList
          data={missing ? [] : receipts}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => {
                void loadLedger('refresh');
              }}
              tintColor="#38BDF8"
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name={missing ? 'alert-circle-outline' : 'receipt-outline'} size={64} color="#334155" />
              <Text style={styles.emptyTitle}>{missing ? 'Group unavailable' : 'No receipts yet'}</Text>
              <Text style={styles.emptySubtitle}>
                {missing
                  ? 'This group could not be opened. Go back and choose a saved group.'
                  : 'Scan a receipt into this group and it will show up here.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.receiptCard}
              activeOpacity={0.7}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push({ pathname: '/receipt/[id]', params: { id: item.id } });
              }}
            >
              <View style={styles.receiptInfo}>
                <Text style={styles.receiptName} numberOfLines={1}>{receiptName(item)}</Text>
                <Text style={styles.dateText}>
                  {new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </Text>
              </View>
              <Text style={styles.totalText}>£{Number(item.total_amount || 0).toFixed(2)}</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: { paddingHorizontal: 24, paddingTop: 64, paddingBottom: 16 },
  backButton: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginLeft: -6, marginBottom: 12 },
  backLabel: { color: '#38BDF8', fontSize: 16, fontWeight: '600' },
  title: { fontSize: 32, fontWeight: '800', color: 'white', letterSpacing: -0.5 },
  subtitle: { marginTop: 8, color: '#94a3b8', fontSize: 15, fontWeight: '500' },
  loader: { marginTop: 60 },
  listContent: { paddingHorizontal: 16, paddingBottom: 40, flexGrow: 1 },
  receiptCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1e293b', padding: 20, borderRadius: 20, marginBottom: 12, borderWidth: 1, borderColor: '#334155' },
  receiptInfo: { flex: 1, paddingRight: 12 },
  receiptName: { fontSize: 18, fontWeight: '700', color: 'white', marginBottom: 6, letterSpacing: -0.3 },
  dateText: { fontSize: 14, color: '#94a3b8', fontWeight: '500' },
  totalText: { fontSize: 20, fontWeight: '800', color: '#38BDF8', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: 'white', marginTop: 20, marginBottom: 8, letterSpacing: -0.5 },
  emptySubtitle: { fontSize: 16, color: '#64748b', textAlign: 'center', lineHeight: 24 },
});
