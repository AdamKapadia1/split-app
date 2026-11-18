import { supabase } from '@/lib/supabase';
import type { Receipt } from '@/types/database.types';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

type HistoryReceipt = Receipt & {
  restaurant_name?: string | null;
};

function money(value: number) {
  return `£${value.toFixed(2)}`;
}

function receiptTitle(item: HistoryReceipt) {
  const restaurant = item.restaurant_name?.trim();
  if (restaurant) return restaurant;
  const merchant = item.merchant_name?.trim();
  if (merchant) return merchant;

  const date = new Date(item.created_at);
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `Receipt • ${day}, ${time}`;
}

function receiptDate(createdAt: string) {
  return new Date(createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function HomeScreen() {
  const router = useRouter();
  const [receipts, setReceipts] = useState<HistoryReceipt[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchReceipts = useCallback(async (mode: 'load' | 'refresh' = 'load') => {
    if (!supabase) {
      console.error('Error fetching receipts: Supabase is not configured.');
      setIsLoading(false);
      setIsRefreshing(false);
      return;
    }

    try {
      if (mode === 'refresh') {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }

      const { data, error } = await supabase.from('receipts').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      setReceipts((data ?? []) as HistoryReceipt[]);
    } catch (error) {
      console.error('Error fetching receipts:', error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void fetchReceipts();
    }, [fetchReceipts]),
  );

  async function handleLogout() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  function onRefresh() {
    void fetchReceipts('refresh');
  }

  function openReceipt(id: string) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({ pathname: '/receipt/[id]', params: { id } });
  }

  function deleteReceipt(id: string, name: string) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert('Delete Receipt', `Are you sure you want to delete "${name}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void confirmDelete(id);
        },
      },
    ]);
  }

  async function confirmDelete(id: string) {
    if (!supabase) {
      console.error('Delete failed: Supabase is not configured.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', 'Could not delete receipt from the database.');
      return;
    }

    setReceipts((current) => current.filter((receipt) => receipt.id !== id));

    try {
      const { data, error } = await supabase.from('receipts').delete().eq('id', id).select();
      if (error || !data || data.length === 0) {
        console.error(
          'Delete failed:',
          error ?? 'No rows were deleted. Row-level security may have blocked the delete.',
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Error', 'Could not delete receipt from the database.');
        void fetchReceipts();
        return;
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error('Delete failed:', error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', 'Could not delete receipt from the database.');
      void fetchReceipts();
    }
  }

  const tracked = receipts.reduce((sum, receipt) => sum + Number(receipt.total_amount || 0), 0);
  const countLabel = `${receipts.length} ${receipts.length === 1 ? 'receipt' : 'receipts'}`;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>History</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Log Out" onPress={() => void handleLogout()} style={styles.logoutPill} activeOpacity={0.75}>
          <Ionicons name="log-out-outline" size={16} color="#F87171" />
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#38BDF8" style={styles.loader} />
      ) : (
        <FlatList
          data={receipts}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const title = receiptTitle(item);
            return (
              <View style={styles.card}>
                <TouchableOpacity style={styles.cardMain} activeOpacity={0.75} onPress={() => openReceipt(item.id)}>
                  <View style={styles.badge}>
                    <Ionicons name="receipt-outline" size={20} color="#38BDF8" />
                  </View>
                  <View style={styles.cardCopy}>
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {title}
                    </Text>
                    <Text style={styles.cardSubtitle}>{receiptDate(item.created_at)}</Text>
                  </View>
                </TouchableOpacity>
                <View style={styles.cardTrail}>
                  <Text style={styles.cardAmount}>{money(Number(item.total_amount || 0))}</Text>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${title}`}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    onPress={() => deleteReceipt(item.id, title)}
                    activeOpacity={0.6}
                  >
                    <Ionicons name="trash-outline" size={18} color="#64748B" />
                  </TouchableOpacity>
                </View>
              </View>
            );
          }}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor="#38BDF8" />}
          ListHeaderComponent={
            <LinearGradient colors={['#1E293B', '#0F172A']} style={styles.hero}>
              <View style={styles.heroTop}>
                <Text style={styles.heroLabel}>TOTAL TRACKED</Text>
                <View style={styles.countPill}>
                  <Text style={styles.countText}>{countLabel}</Text>
                </View>
              </View>
              <Text style={styles.heroAmount}>{money(tracked)}</Text>
            </LinearGradient>
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="receipt-outline" size={64} color="#334155" />
              <Text style={styles.emptyTitle}>No receipts yet</Text>
              <Text style={styles.emptySubtitle}>Tap the camera button below to scan your first bill.</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B1120' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 64,
    paddingBottom: 20,
  },
  title: { fontSize: 32, fontWeight: '800', color: '#F8FAFC', letterSpacing: -0.8 },
  logoutPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(239, 68, 68, 0.25)',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  logoutText: { color: '#F87171', fontSize: 14, fontWeight: '700' },
  loader: { marginTop: 60 },
  listContent: { paddingHorizontal: 16, paddingBottom: 40, flexGrow: 1 },
  hero: {
    borderRadius: 24,
    padding: 20,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.2)',
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroLabel: { color: '#94A3B8', fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  countPill: { backgroundColor: 'rgba(56, 189, 248, 0.12)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  countText: { color: '#38BDF8', fontSize: 12, fontWeight: '700' },
  heroAmount: { marginTop: 14, color: '#FFFFFF', fontSize: 36, fontWeight: '800', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#151F32',
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.12)',
  },
  cardMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  badge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(56, 189, 248, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardCopy: { flex: 1, marginHorizontal: 12 },
  cardTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
  cardSubtitle: { marginTop: 3, color: '#94A3B8', fontSize: 13 },
  cardTrail: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardAmount: { color: '#38BDF8', fontSize: 17, fontWeight: '800', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: '#F8FAFC', marginTop: 20, marginBottom: 8, letterSpacing: -0.5 },
  emptySubtitle: { fontSize: 16, color: '#94A3B8', textAlign: 'center', lineHeight: 24 },
});
