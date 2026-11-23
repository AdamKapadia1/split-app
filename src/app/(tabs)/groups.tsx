import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AvatarBadge } from '@/components/AvatarBadge';
import { MoneyText } from '@/components/MoneyText';
import { Skeleton } from '@/components/skeleton';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { groupService, subscribeGroupList, type GroupBalanceSummary } from '@/services/GroupService';
import { theme } from '@/theme/theme';
import { logger } from '@/utils/logger';
import { formatPence } from '@/utils/money';
import type { GroupLedgerStatus } from '@/utils/settlements';

type Group = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
};

export default function GroupsScreen() {
  const router = useRouter();
  const { session } = useSupabaseSession();
  const userId = session?.user.id ?? null;
  const [groups, setGroups] = useState<Group[]>([]);
  const [summaries, setSummaries] = useState<Record<string, GroupBalanceSummary>>({});
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isModalVisible, setModalVisible] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [nameFocused, setNameFocused] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const hydrateRequest = useRef(0);
  const nameReady = newGroupName.trim().length > 0;

  const hydrateBalances = useCallback(async (list: Group[], viewerId: string) => {
    const requestId = hydrateRequest.current + 1;
    hydrateRequest.current = requestId;
    const ids = list.map((group) => group.id).filter((id) => !id.startsWith('temp-'));
    if (ids.length === 0) {
      setLoadingBalances(false);
      return;
    }

    setLoadingBalances(true);
    try {
      const rows = await groupService.getGroupBalanceSummaries(ids, viewerId);
      if (hydrateRequest.current !== requestId) return;
      setSummaries(Object.fromEntries(rows.map((row) => [row.id, row])));
    } catch (error) {
      logger.error('groups', { code: 'BALANCES_FAILED' });
      if (hydrateRequest.current !== requestId) return;
      setSummaries((current) => {
        const next = { ...current };
        for (const id of ids) {
          if (!next[id]) {
            next[id] = { id, memberPreviews: [], memberCount: 0, receiptCount: 0, userNetBalanceMinor: 0, status: EMPTY_GROUP_STATUS };
          }
        }
        return next;
      });
    } finally {
      if (hydrateRequest.current === requestId) setLoadingBalances(false);
    }
  }, []);

  const fetchGroups = useCallback(async (mode: 'load' | 'refresh' = 'load') => {
    try {
      if (mode === 'refresh') setIsRefreshing(true);
      if (!supabase) return;
      const { data: { session: active } } = await supabase.auth.getSession();
      const viewerId = active?.user?.id ?? userId;
      if (!viewerId) return;

      const { data, error } = await supabase
        .from('groups')
        .select('*, group_members!inner(user_id)')
        .eq('group_members.user_id', viewerId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      const next = (data || []) as Group[];
      setGroups(next);
      void hydrateBalances(next, viewerId);
    } catch (error) {
      logger.error('groups', { code: 'FETCH_FAILED' });
    } finally {
      setLoadingGroups(false);
      setIsRefreshing(false);
    }
  }, [hydrateBalances, userId]);

  useFocusEffect(
    useCallback(() => {
      void fetchGroups();
    }, [fetchGroups])
  );

  useEffect(() => subscribeGroupList(() => {
    void fetchGroups('refresh');
  }), [fetchGroups]);

  const handleCreateGroup = async () => {
    const trimmedName = newGroupName.trim();
    if (!trimmedName) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert('Hold up', 'Please enter a group name.');
      return;
    }

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsCreating(true);

    try {
      if (!supabase) throw new Error('Supabase is not configured.');
      const { data: { session: active } } = await supabase.auth.getSession();
      const viewerId = active?.user?.id;
      if (!viewerId) throw new Error('Authentication required');

      const tempId = `temp-${Date.now()}`;
      const optimisticGroup: Group = {
        id: tempId,
        name: trimmedName,
        created_by: viewerId,
        created_at: new Date().toISOString(),
      };

      setGroups(prev => [optimisticGroup, ...prev]);
      setModalVisible(false);
      setNewGroupName('');

      const { data: newGroup, error: groupError } = await supabase
        .from('groups')
        .insert({ name: trimmedName, created_by: viewerId })
        .select()
        .single();

      if (groupError) throw groupError;

      const { error: memberError } = await supabase
        .from('group_members')
        .insert({ group_id: newGroup.id, user_id: viewerId });

      if (memberError) throw memberError;

      let nextGroups: Group[] = [];
      setGroups(prev => {
        nextGroups = prev.map(g => g.id === tempId ? newGroup : g);
        return nextGroups;
      });
      void hydrateBalances(nextGroups, viewerId);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      logger.error('groups', { code: 'CREATE_FAILED' });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Transaction Failed', 'Could not create the group securely.');
      void fetchGroups();
    } finally {
      setIsCreating(false);
    }
  };

  const openModal = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setModalVisible(true);
  };

  const closeModal = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setModalVisible(false);
    setNewGroupName('');
    setNameFocused(false);
  };

  const loadedSummaries = groups.flatMap((group) => {
    const summary = summaries[group.id];
    return summary ? [summary] : [];
  });
  const activeGroups = loadedSummaries.filter((summary) => summary.status.kind !== 'empty');
  const overallNetMinor = loadedSummaries.reduce((sum, summary) => sum + summary.status.userNetBalanceMinor, 0);
  const totalUnsplit = loadedSummaries.reduce((sum, summary) => sum + summary.status.unsplitActiveCount, 0);
  const hasAnyOpenBalances = loadedSummaries.some((summary) => summary.status.kind === 'balances_owed');

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>Groups</Text>
      </View>

      {loadingGroups && groups.length === 0 ? (
        <ActivityIndicator size="large" color={theme.colors.accent} style={styles.loader} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => {
                void fetchGroups('refresh');
              }}
              tintColor={theme.colors.accent}
            />
          }
        >
          {groups.length > 0 ? (
            loadingBalances ? (
              <Skeleton style={styles.bannerSkeleton} />
            ) : (
              <NetBanner
                activeCount={activeGroups.length}
                overallNetMinor={overallNetMinor}
                totalUnsplit={totalUnsplit}
                hasAnyOpenBalances={hasAnyOpenBalances}
              />
            )
          ) : null}
          {groups.length > 0 ? <Text style={styles.sectionHeading}>Your groups</Text> : null}
          <View style={styles.card}>
            {groups.length === 0 ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyBadge}>
                  <Ionicons name="people-outline" size={22} color={theme.colors.accent} />
                </View>
                <Text style={styles.emptyTitle}>No groups yet</Text>
                <Text style={styles.emptySubtitle}>Tap + to create a group for dinners or trips.</Text>
              </View>
            ) : (
              groups.map((item, index) => {
                const summary = summaries[item.id];
                const isSyncing = item.id.startsWith('temp-');
                const memberCount = summary?.memberCount ?? 0;
                const previews = summary?.memberPreviews ?? [];
                return (
                  <View key={item.id}>
                    {index > 0 ? <View style={styles.divider} /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={item.name}
                      onPress={() => {
                        if (isSyncing) {
                          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                          return;
                        }
                        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        router.push({ pathname: '/group/[id]', params: { id: item.id } });
                      }}
                      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, isSyncing && styles.rowSyncing]}
                    >
                      <View style={styles.iconBadge}>
                        <Ionicons name="people" size={18} color={theme.colors.accent} />
                      </View>
                      <View style={styles.copy}>
                        <View style={styles.nameRow}>
                          <Text style={styles.groupName} numberOfLines={1} ellipsizeMode="tail">{item.name}</Text>
                        </View>
                        {isSyncing ? (
                          <Text style={styles.syncing}>Syncing...</Text>
                        ) : !summary ? (
                          <Skeleton style={styles.memberSkeleton} />
                        ) : (
                          <View style={styles.subtitleRow}>
                            {previews.length > 0 ? (
                              <View style={styles.avatarStack}>
                                {previews.map((member, memberIndex) => (
                                  <View key={member.id} style={[styles.avatarCutout, memberIndex > 0 && styles.avatarOverlap]}>
                                    <AvatarBadge name={member.display_name} userId={member.id} size={18} />
                                  </View>
                                ))}
                              </View>
                            ) : null}
                            <Text style={styles.memberCount} numberOfLines={1} ellipsizeMode="tail">
                              {`${memberCount} ${memberCount === 1 ? 'member' : 'members'}`}
                            </Text>
                          </View>
                        )}
                      </View>
                      <View style={styles.trail}>
                        {isSyncing || loadingBalances || !summary ? (
                          <Skeleton style={styles.balanceSkeleton} />
                        ) : (
                          <BalancePill status={summary.status} />
                        )}
                        <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
                      </View>
                    </Pressable>
                  </View>
                );
              })
            )}
          </View>
        </ScrollView>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create group"
        onPress={openModal}
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
      >
        <Ionicons name="add" size={24} color={theme.colors.accentText} />
      </Pressable>

      <Modal visible={isModalVisible} animationType="fade" transparent onRequestClose={closeModal}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New Group</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={10}
                onPress={closeModal}
                style={({ pressed }) => [styles.closeButton, pressed && styles.closePressed]}
              >
                <Ionicons name="close" size={15} color={theme.colors.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.modalSubtitle}>Name the group for this dinner, trip, or house.</Text>
            <TextInput
              style={[styles.input, nameFocused && styles.inputFocused]}
              placeholder="e.g., Manchester Trip"
              placeholderTextColor={theme.colors.textMuted}
              value={newGroupName}
              onChangeText={setNewGroupName}
              onFocus={() => setNameFocused(true)}
              onBlur={() => setNameFocused(false)}
              autoFocus
              selectionColor={theme.colors.accent}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create Group"
              disabled={!nameReady || isCreating}
              onPress={() => {
                void handleCreateGroup();
              }}
              style={({ pressed }) => [
                styles.createButton,
                !nameReady && !isCreating && styles.createButtonDisabled,
                nameReady && !isCreating && pressed && styles.createButtonPressed,
              ]}
            >
              {isCreating ? (
                <ActivityIndicator color={theme.colors.accentText} />
              ) : (
                <Text style={[styles.createButtonText, !nameReady && styles.createButtonTextDisabled]}>Create Group</Text>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const EMPTY_GROUP_STATUS: GroupLedgerStatus = {
  kind: 'empty',
  receiptCount: 0,
  activeReceiptCount: 0,
  settledReceiptCount: 0,
  unsplitActiveCount: 0,
  transferCount: 0,
  userNetBalanceMinor: 0,
};

function NetBanner({
  activeCount,
  overallNetMinor,
  totalUnsplit,
  hasAnyOpenBalances,
}: {
  activeCount: number;
  overallNetMinor: number;
  totalUnsplit: number;
  hasAnyOpenBalances: boolean;
}) {
  if (activeCount === 0) {
    return (
      <View style={styles.banner}>
        <View style={styles.bannerLeft}>
          <View style={styles.neutralDot} />
          <Text style={styles.bannerCopy} numberOfLines={1}>No bills tracked yet</Text>
        </View>
      </View>
    );
  }

  if (overallNetMinor > 0) {
    return (
      <View style={styles.banner}>
        <Text style={styles.bannerCopy} numberOfLines={1}>Overall, you are owed</Text>
        <MoneyText amountMinor={overallNetMinor} size="md" color={theme.colors.positive} />
      </View>
    );
  }

  if (overallNetMinor < 0) {
    return (
      <View style={styles.banner}>
        <Text style={styles.bannerCopy} numberOfLines={1}>Overall, you owe</Text>
        <MoneyText amountMinor={Math.abs(overallNetMinor)} size="md" color={theme.colors.warning} />
      </View>
    );
  }

  if (totalUnsplit > 0) {
    return (
      <View style={styles.banner}>
        <View style={styles.bannerLeft}>
          <View style={styles.warningDot} />
          <Text style={styles.bannerCopy} numberOfLines={1}>
            {`${totalUnsplit} ${totalUnsplit === 1 ? 'bill' : 'bills'} waiting to be split`}
          </Text>
        </View>
      </View>
    );
  }

  if (hasAnyOpenBalances) {
    return (
      <View style={styles.banner}>
        <View style={styles.bannerLeft}>
          <View style={styles.clearDot} />
          <Text style={styles.bannerCopy} numberOfLines={1}>Your balances are clear</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.banner}>
      <View style={styles.bannerLeft}>
        <View style={styles.settledDot} />
        <Text style={styles.bannerCopy} numberOfLines={1}>
          {`All settled across ${activeCount} active ${activeCount === 1 ? 'group' : 'groups'}`}
        </Text>
      </View>
    </View>
  );
}

function BalancePill({ status }: { status: GroupLedgerStatus }) {
  switch (status.kind) {
    case 'empty':
      return (
        <View style={[styles.pill, styles.pillNeutral]}>
          <Text style={[styles.pillText, styles.pillTextNeutral]} numberOfLines={1}>No bills yet</Text>
        </View>
      );
    case 'needs_split':
      return (
        <View style={[styles.pill, styles.pillWarning]}>
          <Text style={[styles.pillText, styles.pillTextWarning]} numberOfLines={1}>
            {`${status.unsplitActiveCount} to split`}
          </Text>
        </View>
      );
    case 'balances_owed':
      if (status.userNetBalanceMinor > 0) {
        return (
          <View style={[styles.pill, styles.pillPositive]}>
            <Text style={[styles.pillText, styles.pillTextPositive]} numberOfLines={1}>
              {`Owed ${formatPence(status.userNetBalanceMinor)}`}
            </Text>
          </View>
        );
      }
      if (status.userNetBalanceMinor < 0) {
        return (
          <View style={[styles.pill, styles.pillWarning]}>
            <Text style={[styles.pillText, styles.pillTextWarning]} numberOfLines={1}>
              {`Owe ${formatPence(Math.abs(status.userNetBalanceMinor))}`}
            </Text>
          </View>
        );
      }
      return (
        <View style={[styles.pill, styles.pillNeutral]}>
          <Text style={[styles.pillText, styles.pillTextClear]} numberOfLines={1}>Balances open</Text>
        </View>
      );
    case 'settled':
      return (
        <View style={[styles.pill, styles.pillPositive]}>
          <Text style={[styles.pillText, styles.pillTextPositive]} numberOfLines={1}>Settled</Text>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.canvas },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  title: { ...theme.typography.screenTitle, color: theme.colors.textPrimary },
  loader: { marginTop: 48 },
  scrollContent: { paddingBottom: 120 },
  banner: {
    marginHorizontal: 16,
    marginBottom: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  bannerSkeleton: {
    marginHorizontal: 16,
    marginBottom: 20,
    height: 46,
    borderRadius: 14,
    backgroundColor: theme.colors.surfaceElevated,
  },
  bannerLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  settledDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.positive },
  warningDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.warning },
  clearDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.textSecondary },
  neutralDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.textMuted },
  bannerCopy: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '500', color: theme.colors.textSecondary },
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
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 66, backgroundColor: theme.colors.border },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14 },
  rowPressed: { backgroundColor: theme.colors.surfaceElevated },
  rowSyncing: { opacity: 0.6 },
  iconBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 10 },
  nameRow: { flexDirection: 'row' },
  groupName: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '600', color: theme.colors.textPrimary },
  subtitleRow: { marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 6 },
  avatarStack: { flexDirection: 'row', alignItems: 'center' },
  avatarCutout: { borderWidth: 1.5, borderColor: theme.colors.surface, borderRadius: theme.radius.full },
  avatarOverlap: { marginLeft: -5 },
  memberCount: { flex: 1, fontSize: 12, lineHeight: 16, color: theme.colors.textMuted },
  memberSkeleton: { width: 96, height: 14, borderRadius: 7, backgroundColor: theme.colors.surfaceElevated },
  syncing: { marginTop: 4, color: theme.colors.accent, fontSize: 12, fontWeight: '600' },
  trail: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  balanceSkeleton: { width: 62, height: 22, borderRadius: theme.radius.full, backgroundColor: theme.colors.surfaceElevated },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: theme.radius.full },
  pillNeutral: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  pillPositive: { backgroundColor: theme.colors.positiveSubtle },
  pillWarning: { backgroundColor: theme.colors.warningSubtle },
  pillText: { fontSize: 11, lineHeight: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pillTextNeutral: { color: theme.colors.textMuted },
  pillTextClear: { color: theme.colors.textSecondary },
  pillTextPositive: { color: theme.colors.positive },
  pillTextWarning: { color: theme.colors.warning },
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
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
    shadowColor: theme.colors.accent,
    shadowOpacity: 0.28,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabPressed: { backgroundColor: theme.colors.accentPressed },
  modalOverlay: {
    flex: 1,
    backgroundColor: theme.colors.scrim,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  modalCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    padding: 20,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  modalTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.4, color: theme.colors.textPrimary },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
  },
  closePressed: { backgroundColor: theme.colors.surfacePressed },
  modalSubtitle: { fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary, marginBottom: 20 },
  input: {
    height: 52,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.canvas,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    fontSize: 16,
    color: theme.colors.textPrimary,
  },
  inputFocused: { borderColor: theme.colors.accentBorder },
  createButton: {
    height: 52,
    borderRadius: theme.radius.md,
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  createButtonPressed: { backgroundColor: theme.colors.accentPressed },
  createButtonDisabled: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  createButtonText: { fontSize: 16, fontWeight: '700', color: theme.colors.accentText },
  createButtonTextDisabled: { fontWeight: '600', color: theme.colors.textMuted },
});
