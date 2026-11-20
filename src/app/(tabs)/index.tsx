import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountSettingsSheet } from '@/components/AccountSettingsSheet';
import { AvatarBadge } from '@/components/AvatarBadge';
import { MoneyText } from '@/components/MoneyText';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { groupService, type AccountProfile } from '@/services/GroupService';
import { receiptService, type HistoryReceiptRecord } from '@/services/ReceiptService';
import { theme } from '@/theme/theme';
import { formatSmartDate } from '@/utils/formatSmartDate';
import { formatPence, toMinorUnits } from '@/utils/money';
import { filterAndGroupReceipts, type HistoryReceiptInput } from '@/utils/receiptHistory';

type LedgerReceipt = HistoryReceiptInput & {
  restaurant_name?: string | null;
};

function receiptTitle(item: Pick<LedgerReceipt, 'merchant_name' | 'restaurant_name' | 'created_at'>) {
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

function toLedger(receipt: HistoryReceiptRecord): LedgerReceipt {
  return {
    id: receipt.id,
    group_id: receipt.group_id,
    group_name: receipt.group_name,
    merchant_name: receipt.merchant_name,
    restaurant_name: receipt.restaurant_name,
    total_minor: toMinorUnits(Number(receipt.total_amount || 0)),
    created_at: receipt.created_at,
  };
}

export default function HomeScreen() {
  const router = useRouter();
  const { session } = useSupabaseSession();
  const userId = session?.user.id ?? null;
  const [receipts, setReceipts] = useState<HistoryReceiptRecord[]>([]);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [selectedGroupKey, setSelectedGroupKey] = useState<'all' | 'personal' | string>('all');
  const loadedOnce = useRef(false);

  const fetchReceipts = useCallback(async (mode: 'load' | 'refresh' = 'load') => {
    try {
      if (mode === 'refresh') {
        setIsRefreshing(true);
      } else if (!loadedOnce.current) {
        setIsLoading(true);
      }

      const data = await receiptService.listHistoryReceipts();
      setReceipts(data);
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

  const openReceipt = useCallback((id: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({ pathname: '/receipt/[id]', params: { id } });
  }, [router]);

  const openGroup = useCallback((id: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({ pathname: '/group/[id]', params: { id } });
  }, [router]);

  const confirmDelete = useCallback(async (id: string) => {
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
  }, [fetchReceipts]);

  const deleteReceipt = useCallback((id: string, name: string) => {
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
  }, [confirmDelete]);

  const ledger = useMemo(() => receipts.map(toLedger), [receipts]);
  const everything = useMemo(
    () => filterAndGroupReceipts({ receipts: ledger, searchQuery: '', selectedGroupKey: 'all' }),
    [ledger],
  );
  const filtered = useMemo(
    () => filterAndGroupReceipts({ receipts: ledger, searchQuery, selectedGroupKey }),
    [ledger, searchQuery, selectedGroupKey],
  );

  const allCount = everything.filteredCount;
  const allTotalMinor = everything.filteredTotalMinor;
  const groupChips = everything.sections.filter((section) => section.groupId !== null);
  const hasPersonal = everything.sections.some((section) => section.groupId === null);
  const showChips = everything.sections.length > 1 || groupChips.length > 0;
  const queryActive = searchQuery.trim().length > 0;
  const isFiltered = queryActive || selectedGroupKey !== 'all';
  const selectedGroupTitle = selectedGroupKey === 'personal'
    ? 'Personal'
    : everything.sections.find((section) => section.key === selectedGroupKey)?.title ?? 'Group';
  const heroLabel = queryActive
    ? 'MATCHING SPEND'
    : selectedGroupKey !== 'all'
      ? `${selectedGroupTitle.toUpperCase()} SPEND`
      : 'TOTAL TRACKED';
  const countLabel = isFiltered
    ? `${filtered.filteredCount} of ${allCount} receipts`
    : `${allCount} ${allCount === 1 ? 'receipt' : 'receipts'}`;

  function selectGroup(key: 'all' | 'personal' | string) {
    if (key === selectedGroupKey) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedGroupKey(key);
  }

  function clearSearch() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSearchQuery('');
  }

  function resetFilters() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSearchQuery('');
    setSelectedGroupKey('all');
  }

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
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={theme.colors.accent} />}
        >
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>{heroLabel}</Text>
            <MoneyText amountMinor={isFiltered ? filtered.filteredTotalMinor : allTotalMinor} size="hero" splitDecimals />
            <View style={styles.countPill}>
              {isFiltered ? <View style={styles.countDot} /> : null}
              <Text style={styles.countText}>{countLabel}</Text>
            </View>
          </View>

          <View style={[styles.search, isSearchFocused && styles.searchFocused, !showChips && styles.searchSolo]}>
            <Ionicons name="search" size={16} color={isSearchFocused ? theme.colors.accent : theme.colors.textMuted} />
            <TextInput
              accessibilityLabel="Search receipts"
              autoCorrect={false}
              placeholder="Search merchant, group, or amount..."
              placeholderTextColor={theme.colors.textMuted}
              returnKeyType="search"
              selectionColor={theme.colors.accent}
              style={styles.searchInput}
              value={searchQuery}
              onBlur={() => setIsSearchFocused(false)}
              onChangeText={setSearchQuery}
              onFocus={() => setIsSearchFocused(true)}
            />
            {searchQuery.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                hitSlop={10}
                onPress={clearSearch}
                style={styles.clearButton}
              >
                <Ionicons name="close" size={12} color={theme.colors.textSecondary} />
              </Pressable>
            ) : null}
          </View>

          {showChips ? (
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
              style={styles.chips}
              contentContainerStyle={styles.chipsContent}
            >
              <FilterChip label="All" active={selectedGroupKey === 'all'} onPress={() => selectGroup('all')} />
              {groupChips.map((section) => (
                <FilterChip
                  key={section.key}
                  label={section.title}
                  active={selectedGroupKey === section.key}
                  onPress={() => selectGroup(section.key)}
                />
              ))}
              {hasPersonal ? (
                <FilterChip label="Personal" active={selectedGroupKey === 'personal'} onPress={() => selectGroup('personal')} />
              ) : null}
            </ScrollView>
          ) : null}

          {allCount === 0 ? (
            <View style={[styles.card, styles.emptyCard]}>
              <View style={styles.emptyState}>
                <View style={styles.emptyBadge}>
                  <Ionicons name="receipt-outline" size={22} color={theme.colors.accent} />
                </View>
                <Text style={styles.emptyTitle}>No receipts yet</Text>
                <Text style={styles.emptySubtitle}>Scan your first bill to start splitting.</Text>
              </View>
            </View>
          ) : filtered.filteredCount === 0 ? (
            <View style={styles.noMatchCard}>
              <View style={styles.noMatchBadge}>
                <Ionicons name="search" size={18} color={theme.colors.textMuted} />
              </View>
              <Text style={styles.noMatchTitle}>No matching receipts</Text>
              <Text style={styles.noMatchSubtitle}>Try searching a different merchant, group, or amount.</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reset filters"
                onPress={resetFilters}
                style={styles.resetPill}
              >
                <Text style={styles.resetText}>Reset filters</Text>
              </Pressable>
            </View>
          ) : (
            filtered.sections.map((section) => (
              <View key={section.key} style={styles.section}>
                <View style={styles.sectionHeader}>
                  {section.groupId ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={section.title}
                      onPress={() => openGroup(section.groupId as string)}
                      style={styles.sectionTitleRow}
                    >
                      <Text style={styles.sectionTitle} numberOfLines={1} ellipsizeMode="tail">{section.title}</Text>
                      <Ionicons name="chevron-forward" size={12} color={theme.colors.textMuted} />
                    </Pressable>
                  ) : (
                    <View style={styles.sectionTitleRow}>
                      <Text style={styles.sectionTitle} numberOfLines={1} ellipsizeMode="tail">{section.title}</Text>
                    </View>
                  )}
                  <Text style={styles.sectionMeta}>{`${formatPence(section.subtotalMinor)} · ${section.data.length}`}</Text>
                </View>
                <View style={styles.card}>
                  {section.data.map((item, index) => (
                    <HistoryRow
                      key={item.id}
                      item={item}
                      showDivider={index > 0}
                      onDelete={deleteReceipt}
                      onOpen={openReceipt}
                    />
                  ))}
                </View>
              </View>
            ))
          )}
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

const HistoryRow = memo(function HistoryRow({
  item,
  showDivider,
  onOpen,
  onDelete,
}: {
  item: LedgerReceipt;
  showDivider: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const title = receiptTitle(item);

  return (
    <View>
      {showDivider ? <View style={styles.divider} /> : null}
      <Swipeable
        friction={2}
        overshootRight={false}
        rightThreshold={40}
        renderRightActions={() => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete ${title}`}
            onPress={() => onDelete(item.id, title)}
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
          onPress={() => onOpen(item.id)}
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
            <MoneyText amountMinor={item.total_minor} size="md" color={theme.colors.textPrimary} />
            <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
          </View>
        </Pressable>
      </Swipeable>
    </View>
  );
});

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, active ? styles.chipActive : styles.chipInactive]}
    >
      <Text style={[styles.chipText, active ? styles.chipTextActive : styles.chipTextInactive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
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
  hero: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16 },
  heroLabel: { ...theme.typography.sectionLabel, color: theme.colors.textMuted, marginBottom: 4 },
  countPill: {
    marginTop: 10,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  countDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.accent },
  countText: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: theme.colors.textSecondary, fontVariant: ['tabular-nums'] },
  search: {
    marginHorizontal: 16,
    marginBottom: 12,
    height: 44,
    borderRadius: 14,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  searchFocused: { borderColor: theme.colors.accentBorder },
  searchSolo: { marginBottom: 18 },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: theme.colors.textPrimary,
    paddingVertical: 0,
  },
  clearButton: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
  },
  chips: { marginBottom: 18, flexGrow: 0 },
  chipsContent: { paddingHorizontal: 16, gap: 8 },
  chip: {
    height: 34,
    paddingHorizontal: 13,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: theme.colors.accentSubtle,
    borderWidth: 1,
    borderColor: theme.colors.accentBorder,
  },
  chipInactive: {
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  chipText: { fontSize: 13 },
  chipTextActive: { fontWeight: '600', color: theme.colors.accent },
  chipTextInactive: { fontWeight: '500', color: theme.colors.textSecondary },
  section: { marginHorizontal: 16, marginBottom: 22 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    paddingHorizontal: 4,
    gap: 12,
  },
  sectionTitleRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  sectionTitle: {
    flex: 1,
    ...theme.typography.sectionLabel,
    color: theme.colors.textSecondary,
  },
  sectionMeta: { fontSize: 12, fontWeight: '600', color: theme.colors.textMuted, fontVariant: ['tabular-nums'] },
  emptyCard: { marginHorizontal: 16 },
  card: {
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
  noMatchCard: {
    marginHorizontal: 16,
    paddingVertical: 32,
    paddingHorizontal: 20,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    alignItems: 'center',
  },
  noMatchBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noMatchTitle: { marginTop: 12, fontSize: 15, fontWeight: '600', color: theme.colors.textPrimary },
  noMatchSubtitle: { marginTop: 4, fontSize: 13, lineHeight: 18, color: theme.colors.textMuted, textAlign: 'center' },
  resetPill: {
    marginTop: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceElevated,
  },
  resetText: { fontSize: 13, fontWeight: '600', color: theme.colors.accent },
});
