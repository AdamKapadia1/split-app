import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountSettingsSheet } from '@/components/AccountSettingsSheet';
import { AvatarBadge } from '@/components/AvatarBadge';
import { Skeleton } from '@/components/skeleton';
import { VelorBrand } from '@/components/VelorBrand';
import { luxury } from '@/constants/theme';
import { resolveMemberIdentity } from '@/lib/memberName';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { groupService } from '@/services/GroupService';
import { fetchHomeFeed, type HomeFeedReceipt } from '@/services/HomeFeedService';
import { sendSettlementNudge, unregisterPushTokenAsync } from '@/services/NotificationService';
import { theme } from '@/theme/theme';
import { mapErrorToUserMessage, mapSettlementNudgeError } from '@/utils/errorMapper';
import { logger } from '@/utils/logger';
import { formatSmartDate } from '@/utils/formatSmartDate';
import { hapticImpactLight, hapticSelection, hapticSuccess, hapticWarning } from '@/utils/haptics';
import {
  computeHomeBalances,
  formatPenceParts,
  isReceiptBalanceSettled,
  type AttentionItem,
  type HomeBalanceReceipt,
  type HomeBalances,
} from '@/utils/homeBalances';
import { createTapId } from '@/utils/notifications';

const CARD = luxury.bgElevated;
const BORDER = luxury.borderSubtle;

const EMPTY_BALANCES: HomeBalances = {
  owedToYouPence: 0,
  youOwePence: 0,
  netPence: 0,
  status: 'settled',
  needsAttention: [],
};

function greetingFor(date: Date) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function poundsLabel(pence: number) {
  const parts = formatPenceParts(Math.abs(pence));
  return `£${parts.pounds}${parts.pence}`;
}

function merchantLabel(receipt: HomeFeedReceipt) {
  return receipt.merchantName?.trim() || receipt.restaurantName?.trim() || 'Receipt';
}

function relativeDate(iso: string) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const elapsed = Date.now() - then;
  if (elapsed < 60_000) return 'Just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return formatSmartDate(iso);
}

function toBalanceReceipt(receipt: HomeFeedReceipt): HomeBalanceReceipt {
  return {
    id: receipt.id,
    hostId: receipt.hostId,
    paidBy: receipt.paidBy,
    creditorName: receipt.creditorName,
    merchantName: merchantLabel(receipt),
    createdAt: receipt.createdAt,
    settled: receipt.settled,
    shares: receipt.shares,
  };
}

export default function HomeScreen() {
  const router = useRouter();
  const { session } = useSupabaseSession();
  const userId = session?.user.id ?? null;
  const [feed, setFeed] = useState<HomeFeedReceipt[] | null>(null);
  const [profileFullName, setProfileFullName] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nudgingId, setNudgingId] = useState<string | null>(null);
  const [nudgedIds, setNudgedIds] = useState<ReadonlySet<string>>(new Set());
  const hasLoadedRef = useRef(false);

  const load = useCallback(async (kind: 'load' | 'refresh' | 'silent') => {
    if (!userId) {
      setIsInitialLoading(false);
      return;
    }
    if (kind === 'load' && !hasLoadedRef.current) setIsInitialLoading(true);
    if (kind === 'refresh') setIsRefreshing(true);
    try {
      const receipts = await fetchHomeFeed();
      const profile = await groupService.getAccountProfile(userId).catch(() => null);
      setFeed(receipts);
      hasLoadedRef.current = true;
      setProfileFullName(profile?.fullName ?? null);
      setError(null);
    } catch (caught) {
      setError(mapErrorToUserMessage(caught, 'Could not load your balances.'));
    } finally {
      setIsInitialLoading(false);
      setIsRefreshing(false);
    }
  }, [userId]);

  useFocusEffect(useCallback(() => {
    void load(hasLoadedRef.current ? 'silent' : 'load');
  }, [load]));

  const balances = feed
    ? computeHomeBalances(feed.map(toBalanceReceipt), userId)
    : EMPTY_BALANCES;
  const recent = feed?.slice(0, 3) ?? [];
  const identity = resolveMemberIdentity({
    metadata: session?.user.user_metadata,
    profileFullName,
    email: session?.user.email,
  });
  const greetingTitle = identity.greetingName ?? 'Welcome back';
  const settingsName = identity.fullName ?? 'Account';

  const openAccount = () => {
    hapticImpactLight();
    setAccountOpen(true);
  };

  const sendNudge = async (item: AttentionItem) => {
    if (nudgingId || item.isOnCooldown || nudgedIds.has(item.id)) return;
    setNudgingId(item.id);
    try {
      const result = await sendSettlementNudge(item.receiptId, item.counterpartyId, createTapId());
      if (result.sent || result.reason === 'NUDGE_COOLDOWN') {
        setNudgedIds((current) => new Set(current).add(item.id));
      }
      if (result.sent) {
        hapticSuccess();
        return;
      }
      hapticWarning();
      Alert.alert('Reminder not sent', result.message || 'Could not send that reminder. Please try again.');
    } catch (caught) {
      const code = caught && typeof caught === 'object' && 'code' in caught ? String(caught.code) : '';
      if (code === 'NUDGE_COOLDOWN') {
        setNudgedIds((current) => new Set(current).add(item.id));
      }
      logger.error('home', { code: code || 'NUDGE_FAILED' });
      hapticWarning();
      Alert.alert('Reminder not sent', mapSettlementNudgeError(caught));
    } finally {
      setNudgingId(null);
    }
  };

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <View style={styles.header}>
        <View style={styles.topRow}>
          <VelorBrand variant="header" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open account settings"
            hitSlop={10}
            onPress={openAccount}
            style={styles.avatarRing}
          >
            <AvatarBadge name={identity.avatarName} userId={userId ?? undefined} size={40} />
          </Pressable>
        </View>
        <Text style={styles.greeting}>{greetingFor(new Date())}</Text>
        <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>{greetingTitle}</Text>
      </View>

      {isInitialLoading && feed === null ? (
        <HomeSkeleton />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={(
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => {
                void load('refresh');
              }}
              tintColor="#FFFFFF"
            />
          )}
        >
          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry"
                onPress={() => {
                  void load(feed === null ? 'load' : 'refresh');
                }}
                style={styles.retry}
              >
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : null}

          {feed !== null ? (
            <>
              <HeroCard balances={balances} />
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionLabel}>Recent splits</Text>
                  {recent.length > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="See all splits"
                      onPress={() => {
                        hapticSelection();
                        router.push('/history');
                      }}
                      style={styles.seeAll}
                    >
                      <Text style={styles.seeAllText}>See all →</Text>
                    </Pressable>
                  ) : null}
                </View>
                {recent.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <View style={styles.emptyIcon}>
                      <Ionicons name="receipt-outline" size={22} color={theme.colors.textSecondary} />
                    </View>
                    <Text style={styles.emptyTitle}>No splits yet</Text>
                    <Text style={styles.emptyBody}>Scan a bill to itemise it with the people you were with. Settled and open splits will show up here.</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Scan a bill"
                      onPress={() => {
                        hapticImpactLight();
                        router.push('/scan');
                      }}
                      style={styles.primaryButton}
                    >
                      <Text style={styles.primaryButtonText}>Scan a bill</Text>
                    </Pressable>
                  </View>
                ) : (
                  recent.map((receipt) => {
                    const settled = isReceiptBalanceSettled(toBalanceReceipt(receipt));
                    return (
                      <Pressable
                        key={receipt.id}
                        accessibilityRole="button"
                        accessibilityLabel={merchantLabel(receipt)}
                        onPress={() => {
                          hapticImpactLight();
                          router.push({ pathname: '/receipt/[id]', params: { id: receipt.id } });
                        }}
                        style={({ pressed }) => [styles.activityCard, pressed && styles.cardPressed]}
                      >
                        <View style={styles.activityIcon}>
                          <Ionicons name="receipt-outline" size={18} color={luxury.textPrimary} />
                        </View>
                        <View style={styles.activityCopy}>
                          <Text style={styles.activityTitle} numberOfLines={1}>{merchantLabel(receipt)}</Text>
                          <View style={styles.activityMetaRow}>
                            <Text style={styles.activityMeta} numberOfLines={1}>
                              {formatSmartDate(receipt.createdAt)}
                              {' · '}
                              {receipt.groupName?.trim() || 'Shared split'}
                            </Text>
                            <BalanceStatusPill settled={settled} />
                          </View>
                        </View>
                        <Text style={styles.activityAmount}>{poundsLabel(receipt.totalMinor)}</Text>
                        <Ionicons name="chevron-forward" size={16} color={luxury.textMuted} />
                      </Pressable>
                    );
                  })
                )}
              </View>

              {balances.needsAttention.length > 0 ? (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionLabel}>Needs attention</Text>
                    <View style={styles.countBadge}>
                      <Text style={styles.countText}>{String(balances.needsAttention.length)}</Text>
                    </View>
                  </View>
                  {balances.needsAttention.map((item) => (
                    <AttentionRow
                      key={item.id}
                      item={item}
                      busy={nudgingId === item.id}
                      nudged={item.isOnCooldown || nudgedIds.has(item.id)}
                      disabled={nudgingId !== null}
                      onNudge={() => {
                        void sendNudge(item);
                      }}
                      onPay={() => {
                        hapticImpactLight();
                        router.push({ pathname: '/receipt/[id]', params: { id: item.receiptId, action: 'pay' } });
                      }}
                    />
                  ))}
                </View>
              ) : null}

            </>
          ) : null}
        </ScrollView>
      )}

      <AccountSettingsSheet
        visible={accountOpen}
        userId={userId}
        displayName={settingsName}
        subtitle={session?.user.email ?? ''}
        onClose={() => {
          setAccountOpen(false);
          void load('silent');
        }}
        onLogout={() => {
          setAccountOpen(false);
          if (!supabase) return;
          if (userId) void unregisterPushTokenAsync(userId);
          void supabase.auth.signOut();
        }}
      />
    </SafeAreaView>
  );
}

function HeroCard({ balances }: { balances: HomeBalances }) {
  const parts = formatPenceParts(Math.abs(balances.netPence));
  const settled = balances.status === 'settled';
  const statusLabel = balances.status === 'owed' ? "YOU'RE OWED" : balances.status === 'owes' ? 'YOU OWE' : 'ALL SETTLED UP';

  return (
    <LinearGradient
      colors={['#171A26', '#0D0F16', '#090A0F']}
      locations={[0, 0.55, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.hero}
    >
      <View style={styles.heroTop}>
        <View style={[styles.heroStatus, settled ? styles.heroStatusSettled : styles.heroStatusOpen]}>
          <View style={[styles.statusDot, { backgroundColor: settled ? luxury.positive : luxury.warning }]} />
          <Text style={[styles.heroStatusText, { color: settled ? luxury.positive : luxury.warning }]}>{statusLabel}</Text>
        </View>
        <VelorBrand variant="watermark" />
      </View>
      <Text accessibilityLabel={poundsLabel(balances.netPence)} style={styles.heroAmount}>
        <Text style={styles.heroPounds}>{`£${parts.pounds}`}</Text>
        <Text style={styles.heroPence}>{parts.pence}</Text>
      </Text>
      <View style={styles.heroSplit}>
        <View style={styles.heroPill}>
          <View style={styles.heroPillLabel}>
            <View style={[styles.dot, styles.dotOwed]} />
            <Text style={styles.heroPillCaption}>Owed to you</Text>
          </View>
          <Text style={[styles.heroPillAmount, styles.amountOwed]}>{poundsLabel(balances.owedToYouPence)}</Text>
        </View>
        <View style={styles.heroDivider} />
        <View style={styles.heroPill}>
          <View style={styles.heroPillLabel}>
            <View style={[styles.dot, styles.dotOwe]} />
            <Text style={styles.heroPillCaption}>You owe</Text>
          </View>
          <Text style={[styles.heroPillAmount, styles.amountOwe]}>{poundsLabel(balances.youOwePence)}</Text>
        </View>
      </View>
    </LinearGradient>
  );
}

function AttentionRow({
  item,
  busy,
  nudged,
  disabled,
  onNudge,
  onPay,
}: {
  item: AttentionItem;
  busy: boolean;
  nudged: boolean;
  disabled: boolean;
  onNudge: () => void;
  onPay: () => void;
}) {
  const title = item.type === 'nudge' ? `${item.counterpartyName} owes you` : `You owe ${item.counterpartyName}`;
  const when = relativeDate(item.createdAt);
  return (
    <View style={styles.attentionCard}>
      <AvatarBadge name={item.counterpartyName} userId={item.counterpartyId} size={40} />
      <View style={styles.attentionCopy}>
        <Text style={styles.attentionTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.attentionMeta} numberOfLines={1}>
          {item.merchantName}{when ? ` · ${when}` : ''}
        </Text>
      </View>
      <View style={styles.attentionTrail}>
        <Text style={styles.attentionAmount}>{poundsLabel(item.amountPence)}</Text>
        {item.type === 'nudge' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={nudged ? 'Nudged' : `Nudge ${item.counterpartyName}`}
            accessibilityState={{ disabled: nudged || disabled, busy }}
            disabled={nudged || disabled}
            onPress={onNudge}
            style={[styles.actionPill, nudged && styles.actionPillDone]}
          >
            {busy ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={[styles.actionPillText, nudged && styles.actionPillTextDone]}>{nudged ? 'Nudged' : 'Nudge'}</Text>
            )}
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Pay ${item.counterpartyName}`}
            onPress={onPay}
            style={styles.actionPill}
          >
            <Text style={styles.actionPillText}>Pay</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function BalanceStatusPill({ settled }: { settled: boolean }) {
  return (
    <View style={[styles.statusPill, settled ? styles.statusSettled : styles.statusOpen]}>
      <View style={[styles.statusDot, { backgroundColor: settled ? luxury.positive : luxury.warning }]} />
      <Text style={[styles.statusText, settled ? styles.statusSettledText : styles.statusOpenText]}>
        {settled ? 'Settled' : 'Unsettled'}
      </Text>
    </View>
  );
}

function HomeSkeleton() {
  return (
    <View accessibilityLabel="Loading home" accessibilityRole="progressbar" style={styles.skeleton}>
      <Skeleton style={styles.skelGreeting} />
      <Skeleton style={styles.skelTitle} />
      <Skeleton style={styles.skelHero} />
      <Skeleton style={styles.skelRow} />
      <Skeleton style={styles.skelRow} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: luxury.bgCanvas },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 8,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  avatarRing: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: luxury.borderHighlight,
  },
  greeting: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: luxury.textMuted,
    marginBottom: 4,
  },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.5, color: luxury.textPrimary },
  scroll: { paddingBottom: 28 },
  hero: {
    marginHorizontal: 16,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.11)',
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 4,
    overflow: 'hidden',
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  heroStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  heroStatusSettled: { backgroundColor: luxury.positiveSoft },
  heroStatusOpen: { backgroundColor: luxury.warningSoft },
  heroStatusText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  heroAmount: {
    marginTop: 18,
    fontSize: 44,
    lineHeight: 50,
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  heroPounds: {
    fontSize: 44,
    lineHeight: 50,
    fontWeight: '700',
    letterSpacing: -1,
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
  },
  heroPence: {
    fontSize: 44,
    lineHeight: 50,
    fontWeight: '500',
    letterSpacing: -1,
    color: 'rgba(255,255,255,0.38)',
    fontVariant: ['tabular-nums'],
  },
  heroSplit: {
    marginTop: 18,
    borderTopWidth: 1,
    borderTopColor: luxury.borderSubtle,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  heroPill: { flex: 1, paddingVertical: 14, gap: 4 },
  heroPillLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroDivider: { width: 1, backgroundColor: luxury.borderSubtle, marginVertical: 12 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOwed: { backgroundColor: luxury.positive },
  dotOwe: { backgroundColor: luxury.warning },
  heroPillCaption: { fontSize: 12, lineHeight: 16, fontWeight: '500', color: luxury.textSecondary },
  heroPillAmount: { fontSize: 17, lineHeight: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  amountOwed: { color: luxury.positive },
  amountOwe: { color: luxury.warning },
  section: { marginTop: 36, paddingHorizontal: 16 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    paddingHorizontal: 2,
    gap: 8,
  },
  sectionLabel: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: luxury.textMuted,
  },
  countBadge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1C1C21',
    borderWidth: 1,
    borderColor: BORDER,
  },
  countText: { fontSize: 11, lineHeight: 14, fontWeight: '700', color: theme.colors.textPrimary, fontVariant: ['tabular-nums'] },
  seeAll: { marginLeft: 'auto' },
  seeAllText: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: luxury.accentPrimary },
  attentionCard: {
    backgroundColor: CARD,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  attentionCopy: { flex: 1, minWidth: 0 },
  attentionTitle: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: theme.colors.textPrimary },
  attentionMeta: { marginTop: 2, fontSize: 12, lineHeight: 16, color: theme.colors.textSecondary },
  attentionTrail: { alignItems: 'flex-end', gap: 6 },
  attentionAmount: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  actionPill: {
    minWidth: 72,
    minHeight: 30,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  actionPillDone: { backgroundColor: '#1C1C21', borderWidth: 1, borderColor: BORDER },
  actionPillText: { fontSize: 12, lineHeight: 16, fontWeight: '700', color: theme.colors.accentText },
  actionPillTextDone: { color: theme.colors.textMuted },
  activityCard: {
    backgroundColor: luxury.bgElevated,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: luxury.borderSubtle,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardPressed: { backgroundColor: luxury.bgElevatedHigh },
  activityIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#151822',
    borderWidth: 1,
    borderColor: luxury.borderSubtle,
  },
  activityCopy: { flex: 1, minWidth: 0 },
  activityTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: luxury.textPrimary },
  activityMetaRow: { marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
  activityMeta: { flexShrink: 1, fontSize: 12, lineHeight: 16, color: luxury.textSecondary },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusSettled: { backgroundColor: luxury.positiveSoft },
  statusOpen: { backgroundColor: luxury.warningSoft },
  statusText: { fontSize: 10, lineHeight: 14, fontWeight: '700', letterSpacing: 0.2 },
  statusSettledText: { color: luxury.positive },
  statusOpenText: { color: luxury.warning },
  activityAmount: { fontSize: 16, lineHeight: 20, fontWeight: '700', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  emptyCard: {
    backgroundColor: CARD,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: 20,
    paddingVertical: 28,
    alignItems: 'center',
  },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1C1C21',
  },
  emptyTitle: { marginTop: 12, fontSize: 16, lineHeight: 22, fontWeight: '600', color: theme.colors.textPrimary },
  emptyBody: { marginTop: 4, fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary, textAlign: 'center' },
  primaryButton: {
    alignSelf: 'stretch',
    marginTop: 18,
    minHeight: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  primaryButtonText: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: theme.colors.accentText },
  errorBanner: {
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.dangerBorder,
    backgroundColor: theme.colors.dangerSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  errorText: { flex: 1, fontSize: 13, lineHeight: 18, color: theme.colors.textPrimary },
  retry: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: CARD,
  },
  retryText: { fontSize: 13, lineHeight: 16, fontWeight: '700', color: theme.colors.textPrimary },
  skeleton: { paddingHorizontal: 16, paddingTop: 8 },
  skelGreeting: { width: 120, height: 12, marginBottom: 10, backgroundColor: '#1C1C21' },
  skelTitle: { width: 160, height: 28, marginBottom: 18, backgroundColor: '#1C1C21' },
  skelHero: { height: 168, borderRadius: 22, marginBottom: 28, backgroundColor: '#1C1C21' },
  skelRow: { height: 72, borderRadius: 16, marginTop: 10, backgroundColor: '#1C1C21' },
});
