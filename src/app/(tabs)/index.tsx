import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlatList, ScrollView } from 'react-native-gesture-handler';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountSettingsSheet } from '@/components/AccountSettingsSheet';
import { AvatarBadge } from '@/components/AvatarBadge';
import { MoneyText } from '@/components/MoneyText';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { groupService, type AccountProfile } from '@/services/GroupService';
import { receiptService } from '@/services/ReceiptService';
import { theme } from '@/theme/theme';
import { formatSmartDate } from '@/utils/formatSmartDate';
import {
  collapseHistoryToPreview,
  filterAndGroupReceipts,
  HISTORY_PAGE_SIZE,
  HISTORY_PREVIEW_LIMIT,
  mergePaginatedReceipts,
  type HistorySection,
  type ReceiptHistoryCursor,
  type ReceiptHistoryItem,
} from '@/utils/receiptHistory';

type HistoryMode = 'preview' | 'expanded';

type HistoryListRow = ReceiptHistoryItem & {
  sectionKey: string;
  sectionTitle: string;
  showDivider: boolean;
  sectionStart: boolean;
  sectionEnd: boolean;
};

function receiptTitle(item: Pick<ReceiptHistoryItem, 'merchant_name' | 'restaurant_name' | 'created_at'>) {
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

function flattenHistorySections(sections: readonly HistorySection<ReceiptHistoryItem>[]): HistoryListRow[] {
  const rows: HistoryListRow[] = [];
  for (const section of sections) {
    section.data.forEach((item, index) => {
      rows.push({
        ...item,
        sectionKey: section.key,
        sectionTitle: section.title,
        showDivider: index > 0,
        sectionStart: index === 0,
        sectionEnd: index === section.data.length - 1,
      });
    });
  }
  return rows;
}

function keyExtractor(item: HistoryListRow) {
  return item.id;
}

export default function HomeScreen() {
  const router = useRouter();
  const { session } = useSupabaseSession();
  const userId = session?.user.id ?? null;
  const listRef = useRef<FlatList<HistoryListRow>>(null);
  const requestGenRef = useRef(0);
  const moreTokenRef = useRef(0);
  const inFlightMoreRef = useRef(false);
  const endReachedArmed = useRef(false);
  const itemsRef = useRef<ReceiptHistoryItem[]>([]);
  const hasMoreRef = useRef(false);
  const nextCursorRef = useRef<ReceiptHistoryCursor | null>(null);

  const [mode, setMode] = useState<HistoryMode>('preview');
  const [items, setItems] = useState<ReceiptHistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<ReceiptHistoryCursor | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [selectedGroupKey, setSelectedGroupKey] = useState<'all' | 'personal' | string>('all');

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const commitPage = useCallback((
    nextItems: ReceiptHistoryItem[],
    nextHasMore: boolean,
    cursor: ReceiptHistoryCursor | null,
    nextMode: HistoryMode,
  ) => {
    itemsRef.current = nextItems;
    hasMoreRef.current = nextHasMore;
    nextCursorRef.current = cursor;
    setItems(nextItems);
    setHasMore(nextHasMore);
    setNextCursor(cursor);
    setMode(nextMode);
  }, []);

  const loadPreview = useCallback(async (kind: 'load' | 'refresh') => {
    const generation = ++requestGenRef.current;
    moreTokenRef.current += 1;
    inFlightMoreRef.current = false;
    endReachedArmed.current = false;
    setIsLoadingMore(false);
    setLoadMoreError(null);

    const hasRows = itemsRef.current.length > 0;
    if (kind === 'refresh' || hasRows) setIsRefreshing(true);
    if (!hasRows) setIsInitialLoading(true);

    try {
      const page = await receiptService.fetchReceiptHistoryPage({
        limit: HISTORY_PREVIEW_LIMIT,
        cursor: null,
      });
      if (generation !== requestGenRef.current) return;
      commitPage(page.items, page.hasMore, page.nextCursor, 'preview');
      setInitialError(null);
    } catch (error) {
      console.error('Error fetching receipts:', error);
      if (generation !== requestGenRef.current) return;
      if (itemsRef.current.length === 0) setInitialError('Could not load receipts.');
    } finally {
      if (generation !== requestGenRef.current) return;
      setIsInitialLoading(false);
      setIsRefreshing(false);
      setIsLoadingMore(false);
    }
  }, [commitPage]);

  const loadMore = useCallback(async () => {
    if (inFlightMoreRef.current) return;
    if (!hasMoreRef.current || !nextCursorRef.current) return;

    const generation = requestGenRef.current;
    const token = ++moreTokenRef.current;
    const cursor = nextCursorRef.current;
    inFlightMoreRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError(null);

    try {
      const page = await receiptService.fetchReceiptHistoryPage({
        limit: HISTORY_PAGE_SIZE,
        cursor,
      });
      if (generation !== requestGenRef.current) return;
      const merged = mergePaginatedReceipts(itemsRef.current, page.items);
      commitPage(merged, page.hasMore, page.nextCursor, 'expanded');
    } catch (error) {
      console.error('Error loading more receipts:', error);
      if (generation !== requestGenRef.current) return;
      setLoadMoreError('Could not load more receipts.');
    } finally {
      if (token === moreTokenRef.current) inFlightMoreRef.current = false;
      if (generation === requestGenRef.current) setIsLoadingMore(false);
    }
  }, [commitPage]);

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
      const kind = itemsRef.current.length > 0 ? 'refresh' : 'load';
      void loadPreview(kind);
      void loadProfile();
    }, [loadPreview, loadProfile]),
  );

  async function handleLogout() {
    if (!supabase) return;
    setAccountOpen(false);
    await supabase.auth.signOut();
  }

  function onRefresh() {
    void loadPreview('refresh');
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

    const remaining = itemsRef.current.filter((receipt) => receipt.id !== id);
    commitPage(remaining, hasMoreRef.current, nextCursorRef.current, mode);

    try {
      const { data, error } = await supabase.from('receipts').delete().eq('id', id).select();
      if (error || !data || data.length === 0) {
        console.error(
          'Delete failed:',
          error ?? 'No rows were deleted. Row-level security may have blocked the delete.',
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Error', 'Could not delete receipt from the database.');
        void loadPreview('refresh');
        return;
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error('Delete failed:', error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', 'Could not delete receipt from the database.');
      void loadPreview('refresh');
    }
  }, [commitPage, loadPreview, mode]);

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

  const viewMore = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMode('expanded');
    endReachedArmed.current = false;
    void loadMore();
  }, [loadMore]);

  const continueHistory = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void loadMore();
  }, [loadMore]);

  const showLess = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    requestGenRef.current += 1;
    moreTokenRef.current += 1;
    inFlightMoreRef.current = false;
    endReachedArmed.current = false;
    const page = collapseHistoryToPreview(itemsRef.current, hasMoreRef.current);
    commitPage(page.items, page.hasMore, page.nextCursor, 'preview');
    setLoadMoreError(null);
    setIsLoadingMore(false);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [commitPage]);

  const retryLoadMore = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void loadMore();
  }, [loadMore]);

  const onEndReached = useCallback(() => {
    if (!endReachedArmed.current) return;
    if (mode !== 'expanded' || loadMoreError) return;
    void loadMore();
  }, [loadMore, loadMoreError, mode]);

  const onScrollBeginDrag = useCallback(() => {
    endReachedArmed.current = true;
  }, []);

  const renderRow = useCallback(({ item }: { item: HistoryListRow }) => (
    <GroupedHistoryRow row={item} onDelete={deleteReceipt} onOpen={openReceipt} onOpenGroup={openGroup} />
  ), [deleteReceipt, openGroup, openReceipt]);

  const everything = useMemo(
    () => filterAndGroupReceipts({ receipts: items, searchQuery: '', selectedGroupKey: 'all' }),
    [items],
  );
  const filtered = useMemo(
    () => filterAndGroupReceipts({ receipts: items, searchQuery, selectedGroupKey }),
    [items, searchQuery, selectedGroupKey],
  );
  const rows = useMemo(() => flattenHistorySections(filtered.sections), [filtered.sections]);

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
      : hasMore
        ? 'RECENT SPEND'
        : 'TOTAL TRACKED';
  const loadedCountLabel = `${allCount}${hasMore ? '+' : ''} ${allCount === 1 && !hasMore ? 'receipt' : 'receipts'}`;
  const countLabel = isFiltered
    ? `${filtered.filteredCount} of ${allCount}${hasMore ? '+' : ''} receipts`
    : loadedCountLabel;

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
  const showSkeleton = isInitialLoading && items.length === 0;
  const showInitialError = !showSkeleton && Boolean(initialError) && items.length === 0;

  const listHeader = (
    <View>
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
    </View>
  );

  const listFooter = (
    <HistoryPaginationFooter
      canContinue={nextCursor !== null}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      loadMoreError={loadMoreError}
      mode={mode}
      onLoadMore={continueHistory}
      onRetry={retryLoadMore}
      onShowLess={showLess}
      onViewMore={viewMore}
    />
  );

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

      {showSkeleton ? (
        <HistorySkeleton />
      ) : showInitialError ? (
        <View style={styles.initialError}>
          <Text style={styles.initialErrorText}>{initialError}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry"
            onPress={() => {
              void loadPreview('load');
            }}
            style={styles.footerButton}
          >
            <Text style={styles.footerButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={rows}
          extraData={`${mode}:${String(hasMore)}:${String(isLoadingMore)}:${loadMoreError ?? ''}:${items.length}`}
          keyExtractor={keyExtractor}
          renderItem={renderRow}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
          ListEmptyComponent={items.length === 0 ? <HistoryEmpty /> : <HistoryNoMatch onReset={resetFilters} />}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={theme.colors.accent} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          onScrollBeginDrag={onScrollBeginDrag}
          initialNumToRender={8}
          windowSize={7}
        />
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

function HistoryPaginationFooter({
  mode,
  hasMore,
  canContinue,
  isLoadingMore,
  loadMoreError,
  onViewMore,
  onLoadMore,
  onShowLess,
  onRetry,
}: {
  mode: HistoryMode;
  hasMore: boolean;
  canContinue: boolean;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  onViewMore: () => void;
  onLoadMore: () => void;
  onShowLess: () => void;
  onRetry: () => void;
}) {
  if (mode === 'preview') {
    if (!hasMore || !canContinue) return null;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="View more receipts"
        onPress={onViewMore}
        style={styles.footerButton}
      >
        <Text style={styles.footerButtonText}>View more receipts</Text>
      </Pressable>
    );
  }

  const showLoadMore = hasMore && canContinue && !isLoadingMore && !loadMoreError;

  return (
    <View style={styles.footer}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show less"
        onPress={onShowLess}
        style={styles.footerQuiet}
      >
        <Text style={styles.footerQuietText}>Show less</Text>
      </Pressable>
      {isLoadingMore ? (
        <ActivityIndicator color={theme.colors.accent} style={styles.footerSpinner} />
      ) : null}
      {loadMoreError ? (
        <View style={styles.loadError}>
          <Text style={styles.loadErrorText}>{loadMoreError}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry"
            onPress={onRetry}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {showLoadMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load more receipts"
          onPress={onLoadMore}
          style={styles.footerButton}
        >
          <Text style={styles.footerButtonText}>Load more receipts</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function HistorySkeleton() {
  return (
    <View accessibilityLabel="Loading receipts" accessibilityRole="progressbar" style={styles.skeletonWrap}>
      <View style={[styles.skeletonBar, styles.skeletonHero]} />
      <View style={styles.section}>
        <View style={[styles.skeletonBar, styles.skeletonLabel]} />
        <View style={styles.card}>
          {Array.from({ length: HISTORY_PREVIEW_LIMIT }, (_, index) => (
            <View key={index}>
              {index > 0 ? <View style={styles.divider} /> : null}
              <View style={styles.row}>
                <View style={[styles.monogram, styles.skeletonBlock]} />
                <View style={styles.copy}>
                  <View style={[styles.skeletonBar, styles.skeletonTitle]} />
                  <View style={[styles.skeletonBar, styles.skeletonDate]} />
                </View>
                <View style={[styles.skeletonBar, styles.skeletonAmount]} />
              </View>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function HistoryEmpty() {
  return (
    <View style={[styles.card, styles.emptyCard]}>
      <View style={styles.emptyState}>
        <View style={styles.emptyBadge}>
          <Ionicons name="receipt-outline" size={22} color={theme.colors.accent} />
        </View>
        <Text style={styles.emptyTitle}>No receipts yet</Text>
        <Text style={styles.emptySubtitle}>Scan your first bill to start splitting.</Text>
      </View>
    </View>
  );
}

function HistoryNoMatch({ onReset }: { onReset: () => void }) {
  return (
    <View style={styles.noMatchCard}>
      <View style={styles.noMatchBadge}>
        <Ionicons name="search" size={18} color={theme.colors.textMuted} />
      </View>
      <Text style={styles.noMatchTitle}>No matching receipts</Text>
      <Text style={styles.noMatchSubtitle}>Try searching a different merchant, group, or amount.</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Reset filters"
        onPress={onReset}
        style={styles.resetPill}
      >
        <Text style={styles.resetText}>Reset filters</Text>
      </Pressable>
    </View>
  );
}

const GroupedHistoryRow = memo(function GroupedHistoryRow({
  row,
  onOpen,
  onDelete,
  onOpenGroup,
}: {
  row: HistoryListRow;
  onOpen: (id: string) => void;
  onDelete: (id: string, name: string) => void;
  onOpenGroup: (id: string) => void;
}) {
  return (
    <View style={[styles.sectionBlock, row.sectionEnd && styles.sectionBlockEnd]}>
      {row.sectionStart ? (
        <View style={styles.sectionHeader}>
          {row.group_id ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={row.sectionTitle}
              onPress={() => onOpenGroup(row.group_id as string)}
              style={styles.sectionTitleRow}
            >
              <Text style={styles.sectionTitle} numberOfLines={1} ellipsizeMode="tail">{row.sectionTitle}</Text>
              <Ionicons name="chevron-forward" size={12} color={theme.colors.textMuted} />
            </Pressable>
          ) : (
            <View style={styles.sectionTitleRow}>
              <Text style={styles.sectionTitle} numberOfLines={1} ellipsizeMode="tail">{row.sectionTitle}</Text>
            </View>
          )}
        </View>
      ) : null}
      <View style={[styles.cardPiece, row.sectionStart && styles.cardPieceStart, row.sectionEnd && styles.cardPieceEnd]}>
        <HistoryRow item={row} showDivider={row.showDivider} onDelete={onDelete} onOpen={onOpen} />
      </View>
    </View>
  );
});

const HistoryRow = memo(function HistoryRow({
  item,
  showDivider,
  onOpen,
  onDelete,
}: {
  item: ReceiptHistoryItem;
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
  scrollContent: { paddingBottom: 32, flexGrow: 1 },
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
  sectionBlock: { marginHorizontal: 16 },
  sectionBlockEnd: { marginBottom: 22 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  sectionTitleRow: { maxWidth: '100%', minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  sectionTitle: {
    flexShrink: 1,
    ...theme.typography.sectionLabel,
    color: theme.colors.textSecondary,
  },
  emptyCard: { marginHorizontal: 16 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  cardPiece: {
    backgroundColor: theme.colors.surface,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  cardPieceStart: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
  },
  cardPieceEnd: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: theme.radius.lg,
    borderBottomRightRadius: theme.radius.lg,
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
  footer: { paddingBottom: 8 },
  footerButton: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.accentBorder,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  footerButtonText: { fontSize: 15, fontWeight: '600', color: theme.colors.accent },
  footerQuiet: {
    alignSelf: 'center',
    marginTop: 2,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  footerQuietText: { fontSize: 13, fontWeight: '600', color: theme.colors.textSecondary },
  footerSpinner: { marginVertical: 12 },
  loadError: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: theme.colors.dangerSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.dangerBorder,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  loadErrorText: { flex: 1, fontSize: 13, lineHeight: 18, color: theme.colors.textPrimary },
  retryButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface,
  },
  retryText: { fontSize: 13, fontWeight: '600', color: theme.colors.accent },
  initialError: { paddingTop: 24 },
  initialErrorText: {
    marginHorizontal: 24,
    marginBottom: 16,
    textAlign: 'center',
    fontSize: 15,
    lineHeight: 20,
    color: theme.colors.textSecondary,
  },
  skeletonWrap: { paddingTop: 8 },
  skeletonBlock: { backgroundColor: theme.colors.surfaceElevated },
  skeletonBar: { borderRadius: 6, backgroundColor: theme.colors.surfaceElevated },
  skeletonHero: { height: 56, marginHorizontal: 20, marginBottom: 22 },
  skeletonLabel: { width: 88, height: 12, marginBottom: 8, marginLeft: 4 },
  skeletonTitle: { width: '62%', height: 14 },
  skeletonDate: { width: '36%', height: 12, marginTop: 8 },
  skeletonAmount: { width: 52, height: 14 },
});
