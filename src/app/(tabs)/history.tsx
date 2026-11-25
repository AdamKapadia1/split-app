import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlatList, ScrollView } from 'react-native-gesture-handler';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountSettingsSheet } from '@/components/AccountSettingsSheet';
import { AvatarBadge } from '@/components/AvatarBadge';
import { MoneyText } from '@/components/MoneyText';
import { VelorBrand } from '@/components/VelorBrand';
import { luxury } from '@/constants/theme';
import { resolveMemberIdentity } from '@/lib/memberName';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { groupService, subscribeGroupList, type AccountProfile, type MemberGroup } from '@/services/GroupService';
import { unregisterPushTokenAsync } from '@/services/NotificationService';
import { isAbortError, receiptService } from '@/services/ReceiptService';
import { theme } from '@/theme/theme';
import { hapticImpactLight, hapticSelection } from '@/utils/haptics';
import { logger } from '@/utils/logger';
import { formatSmartDate } from '@/utils/formatSmartDate';
import {
  collapseHistoryToPreview,
  filterAndGroupReceipts,
  getInitialHistoryLimit,
  HISTORY_PAGE_SIZE,
  HISTORY_PREVIEW_LIMIT,
  HISTORY_SEARCH_DEBOUNCE_MS,
  isHistoryFiltered,
  isValidGroupUuid,
  mergePaginatedReceipts,
  normalizeHistorySearchQuery,
  reconcileGroupFilter,
  type HistorySection,
  type ReceiptHistoryCursor,
  type ReceiptHistoryFilter,
  type ReceiptHistoryGroupFilter,
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

export default function HistoryScreen() {
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
  const abortRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedOnceRef = useRef(false);
  const pageLoadingRef = useRef(false);
  const skipFocusRefreshRef = useRef(true);
  const filterRef = useRef<ReceiptHistoryFilter>({ searchQuery: '', groupFilter: 'all' });

  const [mode, setMode] = useState<HistoryMode>('preview');
  const [items, setItems] = useState<ReceiptHistoryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<ReceiptHistoryCursor | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFilterLoading, setIsFilterLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [rawSearchText, setRawSearchText] = useState('');
  const [appliedSearchText, setAppliedSearchText] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [groupFilter, setGroupFilter] = useState<ReceiptHistoryGroupFilter>('all');
  const [groups, setGroups] = useState<MemberGroup[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);

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

  const beginHistoryRequest = useCallback(() => {
    const generation = ++requestGenRef.current;
    const previous = abortRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    previous?.abort();
    moreTokenRef.current += 1;
    inFlightMoreRef.current = false;
    endReachedArmed.current = false;
    nextCursorRef.current = null;
    pageLoadingRef.current = true;
    setNextCursor(null);
    setIsLoadingMore(false);
    setLoadMoreError(null);
    return { generation, signal: controller.signal };
  }, []);

  const loadFirstPage = useCallback(async (kind: 'load' | 'refresh' | 'filter') => {
    const activeFilter = filterRef.current;
    const filtered = isHistoryFiltered(activeFilter);
    const { generation, signal } = beginHistoryRequest();

    const hasRows = itemsRef.current.length > 0;
    if (kind === 'refresh') {
      setIsRefreshing(true);
      setIsFilterLoading(false);
    } else if (kind === 'filter' || hasRows) {
      setIsFilterLoading(true);
      setIsRefreshing(false);
    } else {
      setIsInitialLoading(true);
      setIsFilterLoading(false);
    }

    try {
      const page = await receiptService.fetchReceiptHistoryPage({
        limit: getInitialHistoryLimit(activeFilter),
        cursor: null,
        searchQuery: activeFilter.searchQuery,
        groupFilter: activeFilter.groupFilter,
        signal,
      });
      if (generation !== requestGenRef.current) return;
      hasLoadedOnceRef.current = true;
      commitPage(page.items, page.hasMore, page.nextCursor, filtered ? 'expanded' : 'preview');
      setInitialError(null);
    } catch (error) {
      if (isAbortError(error) || generation !== requestGenRef.current) return;
      logger.error('history', { code: 'FETCH_FAILED' });
      if (itemsRef.current.length === 0) setInitialError('Could not load receipts.');
    } finally {
      if (generation !== requestGenRef.current) return;
      pageLoadingRef.current = false;
      setIsInitialLoading(false);
      setIsRefreshing(false);
      setIsFilterLoading(false);
      setIsLoadingMore(false);
    }
  }, [beginHistoryRequest, commitPage]);

  const loadMore = useCallback(async () => {
    if (pageLoadingRef.current || inFlightMoreRef.current) return;
    if (!hasMoreRef.current || !nextCursorRef.current) return;

    const generation = requestGenRef.current;
    const token = ++moreTokenRef.current;
    const cursor = nextCursorRef.current;
    const signal = abortRef.current?.signal;
    const activeFilter = filterRef.current;
    if (signal?.aborted) return;

    inFlightMoreRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError(null);

    try {
      const page = await receiptService.fetchReceiptHistoryPage({
        limit: HISTORY_PAGE_SIZE,
        cursor,
        searchQuery: activeFilter.searchQuery,
        groupFilter: activeFilter.groupFilter,
        signal,
      });
      if (generation !== requestGenRef.current) return;
      const merged = mergePaginatedReceipts(itemsRef.current, page.items);
      commitPage(merged, page.hasMore, page.nextCursor, 'expanded');
    } catch (error) {
      if (isAbortError(error) || generation !== requestGenRef.current) return;
      logger.error('history', { code: 'PAGE_FAILED' });
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
      logger.error('account', { code: 'PROFILE_FAILED' });
    }
  }, [userId]);

  const loadGroups = useCallback(async () => {
    if (!userId) {
      setGroups([]);
      setGroupsLoaded(false);
      return;
    }
    try {
      const next = await groupService.listMemberGroups(userId);
      setGroups(next);
      setGroupsLoaded(true);
    } catch (error) {
      logger.error('history', { code: 'GROUPS_FAILED' });
    }
  }, [userId]);

  useEffect(() => {
    filterRef.current = { searchQuery: appliedSearchText, groupFilter };
    void loadFirstPage(hasLoadedOnceRef.current ? 'filter' : 'load');
  }, [appliedSearchText, groupFilter, loadFirstPage]);

  useEffect(() => subscribeGroupList(() => {
    void loadGroups();
  }), [loadGroups]);

  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    requestGenRef.current += 1;
    abortRef.current?.abort();
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadGroups();
      void loadProfile();
      if (skipFocusRefreshRef.current) {
        skipFocusRefreshRef.current = false;
        return;
      }
      void loadFirstPage('refresh');
    }, [loadFirstPage, loadGroups, loadProfile]),
  );

  async function handleLogout() {
    if (!supabase) return;
    setAccountOpen(false);
    const userId = session?.user.id;
    if (userId) await unregisterPushTokenAsync(userId);
    await supabase.auth.signOut();
  }

  function onRefresh() {
    void loadFirstPage('refresh');
    void loadProfile();
    void loadGroups();
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
      logger.error('receipt delete', { code: 'NOT_CONFIGURED' });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', 'Could not delete receipt from the database.');
      return;
    }

    const remaining = itemsRef.current.filter((receipt) => receipt.id !== id);
    commitPage(remaining, hasMoreRef.current, nextCursorRef.current, mode);

    try {
      const { data, error } = await supabase.from('receipts').delete().eq('id', id).select();
      if (error || !data || data.length === 0) {
        logger.error('receipt delete', { code: 'DELETE_BLOCKED' });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Error', 'Could not delete receipt from the database.');
        void loadFirstPage('refresh');
        return;
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      logger.error('receipt delete', { code: 'DELETE_FAILED' });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', 'Could not delete receipt from the database.');
      void loadFirstPage('refresh');
    }
  }, [commitPage, loadFirstPage, mode]);

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
    const previous = abortRef.current;
    abortRef.current = new AbortController();
    previous?.abort();
    pageLoadingRef.current = false;
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

  const ledger = useMemo(
    () => filterAndGroupReceipts({ receipts: items, searchQuery: '', selectedGroupKey: 'all' }),
    [items],
  );
  const rows = useMemo(() => flattenHistorySections(ledger.sections), [ledger.sections]);
  const activeFilter = useMemo<ReceiptHistoryFilter>(
    () => ({ searchQuery: appliedSearchText, groupFilter }),
    [appliedSearchText, groupFilter],
  );
  const isFiltered = isHistoryFiltered(activeFilter);
  const queryActive = normalizeHistorySearchQuery(appliedSearchText).length > 0;
  const searchPending = normalizeHistorySearchQuery(rawSearchText) !== appliedSearchText;
  const groupOptions = useMemo(
    () => groups.filter((group) => isValidGroupUuid(group.id)),
    [groups],
  );
  const [trackedGroups, setTrackedGroups] = useState(groups);
  if (groupsLoaded && trackedGroups !== groups) {
    setTrackedGroups(groups);
    setGroupFilter((current) => reconcileGroupFilter(current, groupOptions.map((group) => group.id)));
  }
  const selectedGroupTitle = groupFilter === 'ungrouped'
    ? 'Personal'
    : groupOptions.find((group) => group.id === groupFilter)?.name ?? null;
  const heroLabel = !isFiltered
    ? (hasMore ? 'Settled & active splits' : 'Total split')
    : queryActive
      ? 'Matching splits'
      : `${selectedGroupTitle ?? 'Group'} splits`;
  const visibleCount = ledger.filteredCount;
  const countLabel = `${visibleCount}${hasMore ? '+' : ''} ${visibleCount === 1 && !hasMore ? 'bill split' : 'bills split'}`;
  const settledVisible = items.reduce((count, item) => count + (item.balance_settled ? 1 : 0), 0);
  const unsettledVisible = items.length - settledVisible;

  function commitSearch(value: string) {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    const normalized = normalizeHistorySearchQuery(value);
    if (filterRef.current.searchQuery === normalized) return;
    filterRef.current = { ...filterRef.current, searchQuery: normalized };
    beginHistoryRequest();
    setAppliedSearchText(normalized);
  }

  function onChangeSearch(value: string) {
    setRawSearchText(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null;
      commitSearch(value);
    }, HISTORY_SEARCH_DEBOUNCE_MS);
  }

  function selectGroup(key: ReceiptHistoryGroupFilter) {
    if (key !== 'all' && key !== 'ungrouped' && !isValidGroupUuid(key)) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    commitSearch(rawSearchText);
    if (filterRef.current.groupFilter === key) return;
    filterRef.current = { ...filterRef.current, groupFilter: key };
    beginHistoryRequest();
    setGroupFilter(key);
  }

  function clearSearch() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRawSearchText('');
    commitSearch('');
  }

  function resetFilters() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRawSearchText('');
    commitSearch('');
    if (filterRef.current.groupFilter === 'all') return;
    filterRef.current = { ...filterRef.current, groupFilter: 'all' };
    beginHistoryRequest();
    setGroupFilter('all');
  }

  const identity = resolveMemberIdentity({
    metadata: session?.user.user_metadata,
    profileFullName: profile?.fullName,
    email: profile?.email || session?.user.email,
  });
  const displayName = identity.fullName ?? 'Account';
  const subtitle = profile?.phone || profile?.email || session?.user.phone || session?.user.email || '';
  const showSkeleton = isInitialLoading && items.length === 0;
  const showInitialError = !showSkeleton && Boolean(initialError) && items.length === 0;

  const listHeader = (
    <View>
      <LinearGradient
        colors={['#171A26', '#0E1018', '#090A0F']}
        locations={[0, 0.52, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <View style={styles.heroTop}>
          <Text style={styles.heroLabel}>{heroLabel}</Text>
          <VelorBrand variant="watermark" opacity={0.28} />
        </View>
        <MoneyText amountMinor={ledger.filteredTotalMinor} size="hero" splitDecimals figureSize={40} />
        <View style={styles.metricStrip}>
          <View style={styles.countPill}>
            <Text style={styles.countText}>{countLabel}</Text>
          </View>
          <View style={styles.metricItem}>
            <View style={[styles.metricDot, styles.metricSettled]} />
            <Text style={styles.metricText}>{`${settledVisible} settled`}</Text>
          </View>
          <View style={styles.metricItem}>
            <View style={[styles.metricDot, styles.metricOpen]} />
            <Text style={styles.metricText}>{`${unsettledVisible} unsettled`}</Text>
          </View>
        </View>
      </LinearGradient>

      <View style={[styles.search, isSearchFocused && styles.searchFocused]}>
        <Ionicons name="search" size={16} color={isSearchFocused ? luxury.accentPrimary : luxury.textMuted} />
        <TextInput
          accessibilityLabel="Search bills or venues"
          autoCorrect={false}
          placeholder="Search bills or venues"
          placeholderTextColor={theme.colors.textMuted}
          returnKeyType="search"
          selectionColor={theme.colors.accent}
          style={styles.searchInput}
          value={rawSearchText}
          onBlur={() => setIsSearchFocused(false)}
          onChangeText={onChangeSearch}
          onFocus={() => setIsSearchFocused(true)}
          onSubmitEditing={() => commitSearch(rawSearchText)}
        />
        {searchPending || isFilterLoading ? (
          <ActivityIndicator
            accessibilityLabel="Searching receipts"
            color={theme.colors.accent}
            size="small"
          />
        ) : null}
        {rawSearchText.length > 0 ? (
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

      <ScrollView
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        style={styles.chips}
        contentContainerStyle={styles.chipsContent}
      >
        <FilterChip label="All" active={groupFilter === 'all'} onPress={() => selectGroup('all')} />
        {groupOptions.map((group) => (
          <FilterChip
            key={group.id}
            label={group.name}
            active={groupFilter === group.id}
            onPress={() => selectGroup(group.id)}
          />
        ))}
        <FilterChip label="Personal" active={groupFilter === 'ungrouped'} onPress={() => selectGroup('ungrouped')} />
      </ScrollView>
    </View>
  );

  const listFooter = (
    <HistoryPaginationFooter
      canContinue={nextCursor !== null}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      loadMoreError={loadMoreError}
      mode={mode}
      showCollapse={mode === 'expanded' && !isFiltered}
      onLoadMore={continueHistory}
      onRetry={retryLoadMore}
      onShowLess={showLess}
      onViewMore={viewMore}
    />
  );

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <VelorBrand variant="header" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open account settings"
            hitSlop={10}
            onPress={() => {
              hapticImpactLight();
              setAccountOpen(true);
            }}
            style={styles.avatarRing}
          >
            <AvatarBadge name={identity.avatarName} userId={userId ?? undefined} size={36} />
          </Pressable>
        </View>
        <Text accessibilityRole="header" style={styles.title}>History</Text>
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
              void loadFirstPage('load');
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
          extraData={`${mode}:${String(hasMore)}:${String(isLoadingMore)}:${String(isFiltered)}:${loadMoreError ?? ''}:${items.length}`}
          keyExtractor={keyExtractor}
          renderItem={renderRow}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          style={isFilterLoading ? styles.listDimmed : undefined}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
          ListEmptyComponent={isFilterLoading ? (
            <ActivityIndicator accessibilityLabel="Searching receipts" color={theme.colors.accent} style={styles.footerSpinner} />
          ) : isFiltered ? (
            <HistoryNoMatch
              groupLabel={groupFilter === 'all' ? null : selectedGroupTitle}
              query={appliedSearchText}
              onReset={resetFilters}
            />
          ) : (
            <HistoryEmpty onScan={() => {
              hapticImpactLight();
              router.push('/scan');
            }} />
          )}
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
        onClose={() => setAccountOpen(false)}
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
  showCollapse,
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
  showCollapse: boolean;
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
  if (!showCollapse && !isLoadingMore && !loadMoreError && !showLoadMore) return null;

  return (
    <View style={styles.footer}>
      {showCollapse ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show less"
          onPress={onShowLess}
          style={styles.footerQuiet}
        >
          <Text style={styles.footerQuietText}>Show less</Text>
        </Pressable>
      ) : null}
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

function HistoryEmpty({ onScan }: { onScan: () => void }) {
  return (
    <View style={[styles.card, styles.emptyCard]}>
      <View style={styles.emptyState}>
        <View style={styles.emptyBadge}>
          <Ionicons name="receipt-outline" size={22} color={theme.colors.accent} />
        </View>
        <Text style={styles.emptyTitle}>No bills split yet</Text>
        <Text style={styles.emptySubtitle}>Scan a bill to itemise it and settle the split.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scan your first bill"
          onPress={onScan}
          style={styles.scanButton}
        >
          <Text style={styles.scanButtonText}>Scan your first bill</Text>
        </Pressable>
      </View>
    </View>
  );
}

function HistoryNoMatch({
  query,
  groupLabel,
  onReset,
}: {
  query: string;
  groupLabel: string | null;
  onReset: () => void;
}) {
  const detail = query.length > 0 && groupLabel
    ? `No bills match “${query}” in ${groupLabel}.`
    : query.length > 0
      ? `No bills match “${query}”.`
      : groupLabel
        ? `No bills in ${groupLabel}.`
        : 'Try a different venue.';

  return (
    <View style={styles.noMatchCard}>
      <View style={styles.noMatchBadge}>
        <Ionicons name="search" size={18} color={theme.colors.textMuted} />
      </View>
      <Text style={styles.noMatchTitle}>No matching bills found.</Text>
      <Text style={styles.noMatchSubtitle}>{detail}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Clear filters"
        onPress={onReset}
        style={styles.resetPill}
      >
        <Text style={styles.resetText}>Clear filters</Text>
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
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
          <View style={styles.monogram}>
            <Text style={styles.monogramText}>{title.trim().charAt(0).toUpperCase() || '?'}</Text>
          </View>
          <View style={styles.copy}>
            <View style={styles.nameRow}>
              <Text style={styles.merchant} numberOfLines={1} ellipsizeMode="tail">{title}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.date} numberOfLines={1}>{formatSmartDate(item.created_at)}</Text>
              <View style={[styles.statusPill, item.balance_settled ? styles.statusSettled : styles.statusOpen]}>
                <View style={[styles.statusDot, item.balance_settled ? styles.metricSettled : styles.metricOpen]} />
                <Text style={[styles.statusText, item.balance_settled ? styles.statusSettledText : styles.statusOpenText]}>
                  {item.balance_settled ? 'Settled' : 'Unsettled'}
                </Text>
              </View>
            </View>
          </View>
          <View style={styles.trail}>
            <MoneyText amountMinor={item.total_minor} size="lg" color="#FFFFFF" />
            <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.28)" />
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
      accessibilityLabel={`${label} receipts`}
      accessibilityState={{ selected: active }}
      onPress={() => {
        hapticSelection();
        onPress();
      }}
      style={({ pressed }) => [styles.chip, active ? styles.chipActive : styles.chipInactive, pressed && styles.pressed]}
    >
      <Text style={[styles.chipText, active ? styles.chipTextActive : styles.chipTextInactive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: luxury.bgCanvas },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  avatarRing: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(16,185,129,0.16)',
  },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.6, color: luxury.textPrimary },
  scrollContent: { paddingBottom: 32, flexGrow: 1 },
  hero: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.11)',
    borderTopColor: 'rgba(255,255,255,0.16)',
    padding: 20,
    overflow: 'hidden',
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  heroLabel: {
    flex: 1,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.48)',
  },
  metricStrip: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.07)',
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
  },
  countPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  countText: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: luxury.textPrimary, fontVariant: ['tabular-nums'] },
  metricItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metricDot: { width: 6, height: 6, borderRadius: 3 },
  metricSettled: { backgroundColor: '#10B981' },
  metricOpen: { backgroundColor: '#F59E0B' },
  metricText: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: 'rgba(247,248,250,0.62)', fontVariant: ['tabular-nums'] },
  search: {
    marginHorizontal: 16,
    marginBottom: 12,
    height: 48,
    borderRadius: 14,
    backgroundColor: '#07080D',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  searchFocused: { borderColor: luxury.borderFocus },
  listDimmed: { opacity: 0.55 },
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
    backgroundColor: '#161A2B',
    borderWidth: 1,
    borderColor: 'rgba(139,149,255,0.55)',
    shadowColor: '#8B95FF',
    shadowOpacity: 0.28,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  chipInactive: {
    backgroundColor: luxury.bgElevated,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  chipText: { fontSize: 13 },
  chipTextActive: { fontWeight: '600', color: '#FFFFFF' },
  chipTextInactive: { fontWeight: '500', color: 'rgba(247,248,250,0.58)' },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.92 },
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
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: 'rgba(247, 248, 250, 0.42)',
  },
  emptyCard: { marginHorizontal: 16 },
  card: {
    backgroundColor: luxury.bgElevated,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: luxury.borderSubtle,
    borderTopColor: luxury.borderHighlight,
    overflow: 'hidden',
  },
  cardPiece: {
    marginBottom: 8,
    backgroundColor: luxury.bgElevated,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: luxury.borderSubtle,
    borderTopColor: luxury.borderHighlight,
    overflow: 'hidden',
  },
  cardPieceStart: {},
  cardPieceEnd: {},
  divider: { height: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: luxury.bgElevated,
  },
  monogram: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: '#141724',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogramText: { color: theme.colors.accent, fontSize: 16, fontWeight: '700' },
  copy: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 8 },
  nameRow: { flexDirection: 'row' },
  merchant: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '600', color: luxury.textPrimary },
  date: { flexShrink: 1, fontSize: 12, lineHeight: 16, color: luxury.textSecondary },
  metaRow: { marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusSettled: { backgroundColor: luxury.positiveSoft },
  statusOpen: { backgroundColor: luxury.warningSoft },
  statusText: { fontSize: 10, lineHeight: 14, fontWeight: '700', letterSpacing: 0.2 },
  statusSettledText: { color: '#10B981' },
  statusOpenText: { color: '#F59E0B' },
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
  scanButton: {
    alignSelf: 'stretch',
    marginTop: 18,
    minHeight: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  scanButtonText: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: theme.colors.accentText },
  noMatchCard: {
    marginHorizontal: 16,
    paddingVertical: 32,
    paddingHorizontal: 20,
    borderRadius: 18,
    backgroundColor: luxury.bgElevated,
    borderWidth: 1,
    borderColor: luxury.borderSubtle,
    borderTopColor: luxury.borderHighlight,
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
