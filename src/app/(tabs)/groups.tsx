import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountSettingsSheet } from '@/components/AccountSettingsSheet';
import { AmbientScreenBackground } from '@/components/AmbientScreenBackground';
import { AvatarBadge } from '@/components/AvatarBadge';
import { GlossyButton } from '@/components/GlossyButton';
import { GroupIconTile } from '@/components/CategoryIconTile';
import { MoneyText } from '@/components/MoneyText';
import { Skeleton } from '@/components/skeleton';
import { SmokedGlassCard } from '@/components/SmokedGlassCard';
import { VelorBrand } from '@/components/VelorBrand';
import { VelorHeader } from '@/components/VelorHeader';
import { luxury } from '@/constants/theme';
import { useReceiptLedgerRealtime } from '@/hooks/useReceiptLedgerRealtime';
import { resolveMemberIdentity } from '@/lib/memberName';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { groupService, subscribeGroupList, type GroupBalanceSummary } from '@/services/GroupService';
import { unregisterPushTokenAsync } from '@/services/NotificationService';
import { theme } from '@/theme/theme';
import { velor } from '@/theme/velorVisuals';
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
  const params = useLocalSearchParams<{ create?: string | string[] }>();
  const createFlag = Array.isArray(params.create) ? params.create[0] : params.create;
  const openedCreateRef = useRef(false);
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
  const [accountOpen, setAccountOpen] = useState(false);
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
    } catch {
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
    } catch {
      logger.error('groups', { code: 'FETCH_FAILED' });
    } finally {
      setLoadingGroups(false);
      setIsRefreshing(false);
    }
  }, [hydrateBalances, userId]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void (async () => {
        try {
          await fetchGroups('refresh');
        } catch (error) {
          if (active) logger.error('groups', { code: 'FETCH_FAILED', error });
        } finally {
          if (!active) return;
        }
      })();
      return () => {
        active = false;
      };
    }, [fetchGroups])
  );

  useReceiptLedgerRealtime(() => {
    void fetchGroups('refresh');
  });

  useEffect(() => subscribeGroupList(() => {
    void fetchGroups('refresh');
  }), [fetchGroups]);

  useEffect(() => {
    if (createFlag !== '1') {
      openedCreateRef.current = false;
      return;
    }
    if (openedCreateRef.current) return;
    openedCreateRef.current = true;
    setModalVisible(true);
    router.setParams({ create: '' });
  }, [createFlag, router]);

  const handleCreateGroup = async () => {
    const trimmedName = newGroupName.trim();
    if (!trimmedName) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
      Alert.alert('Hold up', 'Please enter a group name.');
      return;
    }

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
        .maybeSingle();

      if (groupError) throw groupError;
      if (!newGroup) throw new Error('Could not create the group.');

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
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch {
      logger.error('groups', { code: 'CREATE_FAILED' });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      Alert.alert('Transaction Failed', 'Could not create the group securely.');
      void fetchGroups();
    } finally {
      setIsCreating(false);
    }
  };

  const openModal = () => {
    setModalVisible(true);
  };

  const closeModal = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
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
  const identity = resolveMemberIdentity({
    metadata: session?.user.user_metadata,
    email: session?.user.email,
  });

  return (
    <AmbientScreenBackground>
    <SafeAreaView edges={['top']} style={styles.container}>
      <View style={styles.header}>
        <VelorHeader
          name={identity.avatarName}
          userId={userId ?? undefined}
          onPressAvatar={() => setAccountOpen(true)}
        />
        <View style={styles.titleRow}>
          <Text accessibilityRole="header" style={styles.title}>Groups</Text>
          <GlossyButton compact label="+ New" accessibilityLabel="New group" onPress={openModal} />
        </View>
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
          {groups.length === 0 ? (
            <View style={styles.emptyCard}>
              <VelorBrand variant="watermark" />
              <Text style={styles.emptyTitle}>No groups yet</Text>
              <Text style={styles.emptySubtitle}>Create a group to split itemised bills with friends.</Text>
              <GlossyButton compact label="+ New" accessibilityLabel="New group" onPress={openModal} style={styles.emptyCta} />
            </View>
          ) : (
            <View style={styles.list}>
              {groups.map((item) => {
                const summary = summaries[item.id];
                const isSyncing = item.id.startsWith('temp-');
                const memberCount = summary?.memberCount ?? 0;
                const previews = summary?.memberPreviews ?? [];
                return (
                  <SmokedGlassCard
                    key={item.id}
                    accessibilityLabel={item.name}
                    onPress={() => {
                      if (isSyncing) {
                        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
                        return;
                      }
                      router.push({ pathname: '/group/[id]', params: { id: item.id } });
                    }}
                    style={isSyncing ? styles.rowSyncing : undefined}
                    contentStyle={styles.groupCard}
                  >
                    <GroupIconTile id={item.id} name={item.name} />
                    <View style={styles.copy}>
                      <Text style={styles.groupName} numberOfLines={1} ellipsizeMode="tail">{item.name}</Text>
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
                                  <AvatarBadge name={member.display_name} userId={member.id} size={24} />
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
                      <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.28)" />
                    </View>
                  </SmokedGlassCard>
                );
              })}
            </View>
          )}
        </ScrollView>
      )}

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
            <GlossyButton
              label="Create Group"
              accessibilityLabel="Create Group"
              variant={nameReady ? 'iris' : 'glass'}
              loading={isCreating}
              disabled={!nameReady || isCreating}
              onPress={() => {
                void handleCreateGroup();
              }}
              style={styles.createButton}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <AccountSettingsSheet
        visible={accountOpen}
        userId={userId}
        displayName={identity.fullName ?? 'Account'}
        subtitle={session?.user.email ?? ''}
        onClose={() => setAccountOpen(false)}
        onLogout={() => {
          setAccountOpen(false);
          if (!supabase) return;
          void (async () => {
            if (userId) await unregisterPushTokenAsync(userId);
            await supabase.auth.signOut();
          })();
        }}
      />
    </SafeAreaView>
    </AmbientScreenBackground>
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

function BannerShell({ children, waiting = false }: { children: ReactNode; waiting?: boolean }) {
  return (
    <SmokedGlassCard style={[styles.banner, waiting ? styles.bannerWaiting : null]} contentStyle={styles.bannerInner}>
      {children}
    </SmokedGlassCard>
  );
}

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
      <BannerShell>
        <View style={styles.bannerLeft}>
          <View style={styles.neutralDot} />
          <Text style={styles.bannerCopy} numberOfLines={1}>No bills tracked yet</Text>
        </View>
      </BannerShell>
    );
  }

  if (overallNetMinor > 0) {
    return (
      <BannerShell>
        <Text style={styles.bannerCopy} numberOfLines={1}>Overall, you are owed</Text>
        <MoneyText amountMinor={overallNetMinor} size="md" color={velor.mint} />
      </BannerShell>
    );
  }

  if (overallNetMinor < 0) {
    return (
      <BannerShell>
        <Text style={styles.bannerCopy} numberOfLines={1}>Overall, you owe</Text>
        <MoneyText amountMinor={Math.abs(overallNetMinor)} size="md" color={velor.amber} />
      </BannerShell>
    );
  }

  if (totalUnsplit > 0) {
    return (
      <BannerShell waiting>
        <View style={styles.bannerLeft}>
          <View style={styles.warningHalo}>
            <View style={styles.warningDot} />
          </View>
          <Text style={[styles.bannerCopy, styles.bannerWaitingText]} numberOfLines={1}>
            {`${totalUnsplit} ${totalUnsplit === 1 ? 'bill' : 'bills'} waiting to be split`}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={velor.amber} />
      </BannerShell>
    );
  }

  if (hasAnyOpenBalances) {
    return (
      <BannerShell>
        <View style={styles.bannerLeft}>
          <View style={[styles.settledDot, styles.dotGlow]} />
          <Text style={styles.bannerCopy} numberOfLines={1}>Your balances are clear</Text>
        </View>
      </BannerShell>
    );
  }

  return (
    <BannerShell>
      <View style={styles.bannerLeft}>
        <View style={[styles.settledDot, styles.dotGlow]} />
        <Text style={styles.bannerCopy} numberOfLines={1}>
          {`All settled across ${activeCount} active ${activeCount === 1 ? 'group' : 'groups'}`}
        </Text>
      </View>
    </BannerShell>
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
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 8 },
  titleRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.6, color: luxury.textPrimary },
  newShadow: {
    borderRadius: 999,
    shadowColor: '#8B95FF',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  newPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  newPillText: { fontSize: 14, lineHeight: 18, fontWeight: '700', color: '#050609' },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.92 },
  pressedTight: { transform: [{ scale: 0.96 }], opacity: 0.92 },
  loader: { marginTop: 48 },
  scrollContent: { paddingBottom: 32 },
  banner: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 20,
  },
  bannerInner: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  bannerWaiting: {
    borderColor: 'rgba(255, 181, 71, 0.34)',
  },
  bannerWaitingText: { color: '#FDE68A', fontWeight: '600' },
  warningHalo: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245,158,11,0.35)',
  },
  bannerSkeleton: {
    marginHorizontal: 16,
    marginBottom: 20,
    height: 46,
    borderRadius: 14,
    backgroundColor: theme.colors.surfaceElevated,
  },
  bannerLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  settledDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: velor.mint },
  dotGlow: {
    shadowColor: velor.mint,
    shadowOpacity: 0.8,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  warningDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: velor.amber },
  clearDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.textSecondary },
  neutralDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.textMuted },
  bannerCopy: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '500', color: theme.colors.textSecondary },
  sectionHeading: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: 'rgba(247, 248, 250, 0.42)',
    marginBottom: 10,
    marginLeft: 20,
  },
  list: { paddingHorizontal: 16, gap: 10 },
  groupCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  rowSyncing: { opacity: 0.6 },
  iconBadge: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#151929',
    borderWidth: 1,
    borderColor: 'rgba(139,149,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 10 },
  nameRow: { flexDirection: 'row' },
  groupName: { fontSize: 16, lineHeight: 21, fontWeight: '700', color: luxury.textPrimary },
  subtitleRow: { marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 6 },
  avatarStack: { flexDirection: 'row', alignItems: 'center' },
  avatarCutout: { borderWidth: 2, borderColor: luxury.bgElevated, borderRadius: 999 },
  avatarOverlap: { marginLeft: -6 },
  memberCount: { flex: 1, fontSize: 12, lineHeight: 16, color: 'rgba(247,248,250,0.52)' },
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
  pillPositive: {
    backgroundColor: 'rgba(46, 229, 157, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(46, 229, 157, 0.28)',
  },
  pillWarning: {
    backgroundColor: 'rgba(255, 181, 71, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 181, 71, 0.28)',
  },
  pillText: { fontSize: 11, lineHeight: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  pillTextNeutral: { color: theme.colors.textMuted },
  pillTextClear: { color: theme.colors.textSecondary },
  pillTextPositive: { color: velor.mintText },
  pillTextWarning: { color: velor.amber },
  emptyCard: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 32,
    paddingHorizontal: 24,
    borderRadius: 20,
    backgroundColor: '#131624',
    borderWidth: 1,
    borderColor: velor.rim,
    alignItems: 'center',
  },
  emptyCta: {
    marginTop: 18,
  },
  emptyCtaText: { fontSize: 14, fontWeight: '700', color: '#050609' },
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
  modalOverlay: {
    flex: 1,
    backgroundColor: theme.colors.scrim,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  modalCard: {
    backgroundColor: luxury.bgElevated,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: luxury.borderSubtle,
    borderTopColor: luxury.borderHighlight,
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
  inputFocused: { borderColor: luxury.borderFocus },
  createButton: {
    marginTop: 18,
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
