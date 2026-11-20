import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MoneyText } from '@/components/MoneyText';
import { StatusPill } from '@/components/StatusPill';
import { supabase } from '@/lib/supabase';
import { theme } from '@/theme/theme';
import type { Receipt } from '@/types/database.types';
import { toMinorUnits } from '@/utils/money';

type HistoryReceipt = Receipt & {
  restaurant_name?: string | null;
};

function receiptTitle(item: HistoryReceipt) {
  const merchant = item.merchant_name?.trim();
  if (merchant) return merchant;
  const restaurant = item.restaurant_name?.trim();
  if (restaurant) return restaurant;

  const date = new Date(item.created_at);
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `Receipt • ${day}, ${time}`;
}

function receiptDate(createdAt: string) {
  return new Date(createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function monogram(name: string) {
  const letter = name.trim().charAt(0).toUpperCase();
  return letter || '?';
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
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
    <SafeAreaView edges={['top']} style={styles.container}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>History</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log Out"
          hitSlop={8}
          onPress={() => {
            void handleLogout();
          }}
          style={({ pressed }) => [styles.logoutPill, pressed && styles.logoutPressed]}
        >
          <Ionicons name="log-out-outline" size={14} color={theme.colors.danger} />
          <Text style={styles.logoutText}>Log Out</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color={theme.colors.accent} style={styles.loader} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={theme.colors.accent} />}
        >
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>Total tracked</Text>
            <MoneyText amountMinor={toMinorUnits(tracked)} size="hero" splitDecimals />
            <View style={styles.countWrap}>
              <StatusPill variant="neutral" bordered label={countLabel} />
            </View>
          </View>

          <Text style={styles.sectionHeading}>Recent receipts</Text>
          <View style={styles.card}>
            {receipts.length === 0 ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyBadge}>
                  <Ionicons name="receipt-outline" size={22} color={theme.colors.accent} />
                </View>
                <Text style={styles.emptyTitle}>No receipts yet</Text>
                <Text style={styles.emptySubtitle}>Scan your first bill to start splitting.</Text>
              </View>
            ) : (
              receipts.map((item, index) => {
                const title = receiptTitle(item);
                return (
                  <View key={item.id}>
                    {index > 0 ? <View style={styles.divider} /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={title}
                      onPress={() => openReceipt(item.id)}
                      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    >
                      <View style={styles.monogram}>
                        <Text style={styles.monogramText}>{monogram(title)}</Text>
                      </View>
                      <View style={styles.copy}>
                        <Text style={styles.merchant} numberOfLines={1}>{title}</Text>
                        <Text style={styles.date}>{receiptDate(item.created_at)}</Text>
                      </View>
                      <View style={styles.trail}>
                        <MoneyText amountMinor={toMinorUnits(Number(item.total_amount || 0))} size="md" color={theme.colors.textPrimary} />
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Delete ${title}`}
                          hitSlop={10}
                          onPress={() => deleteReceipt(item.id, title)}
                          style={styles.deleteButton}
                        >
                          {({ pressed }) => (
                            <Ionicons name="trash-outline" size={17} color={pressed ? theme.colors.danger : theme.colors.textMuted} />
                          )}
                        </Pressable>
                      </View>
                    </Pressable>
                  </View>
                );
              })
            )}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.canvas },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { ...theme.typography.screenTitle, color: theme.colors.textPrimary },
  logoutPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.dangerBorder,
  },
  logoutPressed: { backgroundColor: theme.colors.surfacePressed },
  logoutText: { color: theme.colors.danger, fontSize: 13, fontWeight: '600' },
  loader: { marginTop: 48 },
  scrollContent: { paddingBottom: 32 },
  hero: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 24 },
  heroLabel: { ...theme.typography.sectionLabel, color: theme.colors.textMuted, marginBottom: 4 },
  countWrap: { marginTop: 10, alignSelf: 'flex-start' },
  sectionHeading: {
    ...theme.typography.sectionLabel,
    color: theme.colors.textMuted,
    marginBottom: 8,
    marginLeft: 20,
  },
  card: {
    marginHorizontal: 16,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border, marginLeft: 66 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14 },
  rowPressed: { backgroundColor: theme.colors.surfaceElevated },
  monogram: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramText: { color: theme.colors.accent, fontSize: 16, fontWeight: '700' },
  copy: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 8 },
  merchant: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: theme.colors.textPrimary },
  date: { marginTop: 2, fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  trail: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  deleteButton: { padding: 4 },
  emptyState: { paddingVertical: 36, paddingHorizontal: 24, alignItems: 'center' },
  emptyBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { marginTop: 12, fontSize: 16, fontWeight: '600', color: theme.colors.textPrimary },
  emptySubtitle: { marginTop: 4, fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary, textAlign: 'center' },
});
