import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountSettingsSheet } from '@/components/AccountSettingsSheet';
import { AvatarBadge } from '@/components/AvatarBadge';
import { MoneyText } from '@/components/MoneyText';
import { StatusPill } from '@/components/StatusPill';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { groupService, type AccountProfile } from '@/services/GroupService';
import { theme } from '@/theme/theme';
import type { Receipt } from '@/types/database.types';
import { formatSmartDate } from '@/utils/formatSmartDate';
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

function sessionDisplayName(metadata: unknown, email: string | null | undefined) {
  const record = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : null;
  const fullName = typeof record?.full_name === 'string' ? record.full_name.trim() : '';
  const name = typeof record?.name === 'string' ? record.name.trim() : '';
  if (fullName) return fullName;
  if (name) return name;
  const local = email?.split('@')[0]?.trim();
  return local || 'Account';
}

export default function HomeScreen() {
  const router = useRouter();
  const { session } = useSupabaseSession();
  const userId = session?.user.id ?? null;
  const [receipts, setReceipts] = useState<HistoryReceipt[]>([]);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const loadedOnce = useRef(false);

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
      } else if (!loadedOnce.current) {
        setIsLoading(true);
      }

      const { data, error } = await supabase.from('receipts').select('*, settled_at, settled_by').order('created_at', { ascending: false });
      if (error) throw error;
      setReceipts((data ?? []) as HistoryReceipt[]);
    } catch (error) {
      console.error('Error fetching receipts:', error);
    } finally {
      loadedOnce.current = true;
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  const loadProfile = useCallback(async () => {
    if (!userId) return;
    try {
      const next = await groupService.getAccountProfile(userId);
      setProfile(next);
    } catch (error) {
      console.error('Error loading account profile:', error);
    }
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      void fetchReceipts();
      void loadProfile();
    }, [fetchReceipts, loadProfile]),
  );

  async function handleLogout() {
    if (!supabase) return;
    setAccountOpen(false);
    await supabase.auth.signOut();
  }

  function onRefresh() {
    void fetchReceipts('refresh');
    void loadProfile();
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
  const displayName = profile?.displayName || sessionDisplayName(session?.user.user_metadata, session?.user.email);
  const subtitle = profile?.phone || profile?.email || session?.user.phone || session?.user.email || '';

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>History</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open account settings"
          hitSlop={10}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setAccountOpen(true);
          }}
        >
          <AvatarBadge name={displayName} userId={userId ?? undefined} size={36} />
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
                    <Swipeable
                      friction={2}
                      overshootRight={false}
                      rightThreshold={40}
                      renderRightActions={() => (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Delete ${title}`}
                          onPress={() => deleteReceipt(item.id, title)}
                          style={styles.deleteAction}
                        >
                          <Ionicons name="trash" size={18} color={theme.colors.textPrimary} />
                          <Text style={styles.deleteLabel}>Delete</Text>
                        </Pressable>
                      )}
                    >
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={title}
                        onPress={() => openReceipt(item.id)}
                        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                      >
                        <View style={styles.monogram}>
                          <Text style={styles.monogramText}>{title.trim().charAt(0).toUpperCase() || '?'}</Text>
                        </View>
                        <View style={styles.copy}>
                          <View style={styles.nameRow}>
                            <Text style={styles.merchant} numberOfLines={1} ellipsizeMode="tail">{title}</Text>
                          </View>
                          <Text style={styles.date}>{formatSmartDate(item.created_at)}</Text>
                        </View>
                        <View style={styles.trail}>
                          <MoneyText amountMinor={toMinorUnits(Number(item.total_amount || 0))} size="md" color={theme.colors.textPrimary} />
                          <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
                        </View>
                      </Pressable>
                    </Swipeable>
                  </View>
                );
              })
            )}
          </View>
        </ScrollView>
      )}

      <AccountSettingsSheet
        visible={accountOpen}
        userId={userId}
        displayName={displayName}
        subtitle={subtitle}
        paymentLink={profile?.paymentLink ?? null}
        onClose={() => setAccountOpen(false)}
        onPaymentLinkChange={(paymentLink) => {
          setProfile((current) => current
            ? { ...current, paymentLink }
            : {
                id: userId ?? '',
                displayName,
                email: session?.user.email ?? null,
                phone: session?.user.phone ?? null,
                paymentLink,
              });
        }}
        onLogout={() => {
          void handleLogout();
        }}
      />
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: theme.colors.surface,
  },
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
  nameRow: { flexDirection: 'row' },
  merchant: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '600', color: theme.colors.textPrimary },
  date: { marginTop: 2, fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  trail: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  deleteAction: {
    width: 76,
    backgroundColor: theme.colors.dangerStrong,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  deleteLabel: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: '600' },
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
