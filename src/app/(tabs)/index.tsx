import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountSettingsSheet } from '@/components/AccountSettingsSheet';
import { AvatarBadge } from '@/components/AvatarBadge';
import { Skeleton } from '@/components/skeleton';
import { supabase } from '@/lib/supabase';
import { useSupabaseSession } from '@/lib/use-session';
import { groupService } from '@/services/GroupService';
import { fetchHomeFeed, type HomeFeedReceipt } from '@/services/HomeFeedService';
import { sendSettlementNudge, unregisterPushTokenAsync } from '@/services/NotificationService';
import { payoutService, type PayoutMethod } from '@/services/PayoutService';
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

const EMERALD = '#10B981';
const AMBER = '#F59E0B';
const CARD = '#141417';
const BORDER = 'rgba(255, 255, 255, 0.08)';
const SETTLED = '#71717A';
const POUNDS = '#FAFAFA';
const PENCE = '#A1A1AA';

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

function firstName(name: string | null | undefined) {
  const token = name?.trim().split(/\s+/).filter(Boolean)[0] ?? '';
  if (!token || token === 'Account') return 'Home';
  return token;
}

function sessionName(metadata: unknown, email: string | null | undefined) {
  const record = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : null;
  const fullName = typeof record?.full_name === 'string' ? record.full_name.trim() : '';
  const name = typeof record?.name === 'string' ? record.name.trim() : '';
  if (fullName) return fullName;
  if (name) return name;
  const local = email?.split('@')[0]?.trim();
  return local || '';
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

function hasPayoutHandle(method: PayoutMethod | null) {
  return Boolean(method?.monzoHandle || method?.revolutHandle);
}

export default function HomeScreen() {
  const router = useRouter();
  const { session } = useSupabaseSession();
  const userId = session?.user.id ?? null;
  const [feed, setFeed] = useState<HomeFeedReceipt[] | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [hasHandle, setHasHandle] = useState(true);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [openPayout, setOpenPayout] = useState(false);
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
      const [profile, payoutResult] = await Promise.all([
        groupService.getAccountProfile(userId).catch(() => null),
        payoutService.getMyPayoutMethod()
          .then((method) => ({ ok: true as const, method }))
          .catch(() => ({ ok: false as const, method: null })),
      ]);
      setFeed(receipts);
      hasLoadedRef.current = true;
      setDisplayName(profile?.displayName || sessionName(session?.user.user_metadata, session?.user.email));
      setHasHandle(payoutResult.ok ? hasPayoutHandle(payoutResult.method) : true);
      setError(null);
    } catch (caught) {
      setError(mapErrorToUserMessage(caught, 'Could not load your balances.'));
    } finally {
      setIsInitialLoading(false);
      setIsRefreshing(false);
    }
  }, [session?.user.email, session?.user.user_metadata, userId]);

  useFocusEffect(useCallback(() => {
    void load(hasLoadedRef.current ? 'silent' : 'load');
  }, [load]));

  const balances = feed
    ? computeHomeBalances(feed.map(toBalanceReceipt), userId)
    : EMPTY_BALANCES;
  const recent = feed?.slice(0, 3) ?? [];
  const name = firstName(displayName);
  const showBanner = feed !== null && !hasHandle && !bannerDismissed;

  const openAccount = (payout: boolean) => {
    hapticImpactLight();
    setOpenPayout(payout);
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
        <View style={styles.headerCopy}>
          <Text style={styles.greeting}>{greetingFor(new Date())}</Text>
          <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>{name}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open account settings"
          hitSlop={10}
          onPress={() => openAccount(false)}
        >
          <AvatarBadge name={displayName || name} userId={userId ?? undefined} size={40} />
        </Pressable>
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
              {showBanner ? (
                <View style={styles.banner}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Set up payout details"
                    onPress={() => openAccount(true)}
                    style={styles.bannerMain}
                  >
                    <View style={styles.bannerIcon}>
                      <Ionicons name="card-outline" size={18} color={theme.colors.accent} />
                    </View>
                    <View style={styles.bannerCopy}>
                      <Text style={styles.bannerTitle}>Set up payout details</Text>
                      <Text style={styles.bannerBody}>Add your Monzo or Revolut handle so friends can pay you in one tap</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss payout setup"
                    hitSlop={8}
                    onPress={() => {
                      hapticSelection();
                      setBannerDismissed(true);
                    }}
                    style={styles.bannerDismiss}
                  >
                    <Ionicons name="close" size={14} color={theme.colors.textSecondary} />
                  </Pressable>
                </View>
              ) : null}

              <View style={styles.actions}>
                <QuickAction
                  label="Scan Bill"
                  icon="scan-outline"
                  tint={theme.colors.accent}
                  onPress={() => router.push('/scan')}
                />
                <QuickAction
                  label="New Group"
                  icon="people-outline"
                  tint={theme.colors.textPrimary}
                  onPress={() => router.push({ pathname: '/groups', params: { create: '1' } })}
                />
                <QuickAction
                  label="History"
                  icon="receipt-outline"
                  tint={theme.colors.textPrimary}
                  onPress={() => router.push('/history')}
                />
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

              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionLabel}>Recent activity</Text>
                  {recent.length > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="See all history"
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
                    <Text style={styles.emptyTitle}>No bills split yet</Text>
                    <Text style={styles.emptyBody}>Scan a receipt to split items with friends in seconds.</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Scan your first bill"
                      onPress={() => {
                        hapticImpactLight();
                        router.push('/scan');
                      }}
                      style={styles.primaryButton}
                    >
                      <Text style={styles.primaryButtonText}>Scan your first bill</Text>
                    </Pressable>
                  </View>
                ) : (
                  recent.map((receipt) => (
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
                      <View style={styles.activityCopy}>
                        <Text style={styles.activityTitle} numberOfLines={1}>{merchantLabel(receipt)}</Text>
                        <View style={styles.activityMetaRow}>
                          <Text style={styles.activityMeta} numberOfLines={1}>
                            {formatSmartDate(receipt.createdAt)}
                            {' · '}
                            {receipt.groupName?.trim() || 'Personal'}
                          </Text>
                          <BalanceStatusPill settled={isReceiptBalanceSettled(toBalanceReceipt(receipt))} />
                        </View>
                      </View>
                      <Text style={styles.activityAmount}>{poundsLabel(receipt.totalMinor)}</Text>
                    </Pressable>
                  ))
                )}
              </View>
            </>
          ) : null}
        </ScrollView>
      )}

      <AccountSettingsSheet
        visible={accountOpen}
        openPayout={openPayout}
        userId={userId}
        displayName={displayName || name}
        subtitle={session?.user.email ?? ''}
        onClose={() => {
          setAccountOpen(false);
          setOpenPayout(false);
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
  const statusColor = balances.status === 'owed' ? EMERALD : balances.status === 'owes' ? AMBER : SETTLED;
  const statusLabel = balances.status === 'owed' ? "YOU'RE OWED" : balances.status === 'owes' ? 'YOU OWE' : 'ALL SETTLED UP';

  return (
    <View style={styles.hero}>
      <Text style={[styles.heroStatus, { color: statusColor }]}>{statusLabel}</Text>
      <Text
        accessibilityLabel={poundsLabel(balances.netPence)}
        style={styles.heroAmount}
      >
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
    </View>
  );
}

function QuickAction({
  label,
  icon,
  tint,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        hapticImpactLight();
        onPress();
      }}
      style={styles.action}
    >
      {({ pressed }) => (
        <>
          <View style={[styles.actionCircle, label === 'Scan Bill' && styles.actionCirclePrimary, pressed && styles.cardPressed]}>
            <Ionicons name={icon} size={22} color={tint} />
          </View>
          <Text style={styles.actionLabel}>{label}</Text>
        </>
      )}
    </Pressable>
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
              <ActivityIndicator color={POUNDS} size="small" />
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
      <View style={styles.actions}>
        <Skeleton style={styles.skelCircle} />
        <Skeleton style={styles.skelCircle} />
        <Skeleton style={styles.skelCircle} />
      </View>
      <Skeleton style={styles.skelRow} />
      <Skeleton style={styles.skelRow} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.canvas },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  greeting: {
    ...theme.typography.sectionLabel,
    color: theme.colors.textMuted,
    marginBottom: 2,
  },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.6, color: theme.colors.textPrimary },
  scroll: { paddingBottom: 28 },
  hero: {
    marginHorizontal: 16,
    backgroundColor: CARD,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 8,
  },
  heroStatus: {
    ...theme.typography.sectionLabel,
    marginBottom: 8,
  },
  heroAmount: { fontVariant: ['tabular-nums'] },
  heroPounds: {
    fontSize: 42,
    lineHeight: 48,
    fontWeight: '700',
    letterSpacing: -1.4,
    color: POUNDS,
    fontVariant: ['tabular-nums'],
  },
  heroPence: {
    fontSize: 28,
    lineHeight: 48,
    fontWeight: '600',
    letterSpacing: -0.6,
    color: PENCE,
    fontVariant: ['tabular-nums'],
  },
  heroSplit: {
    marginTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  heroPill: { flex: 1, paddingVertical: 14, gap: 4 },
  heroPillLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroDivider: { width: StyleSheet.hairlineWidth, backgroundColor: BORDER, marginVertical: 12 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotOwed: { backgroundColor: EMERALD },
  dotOwe: { backgroundColor: AMBER },
  heroPillCaption: { fontSize: 12, lineHeight: 16, fontWeight: '500', color: theme.colors.textSecondary },
  heroPillAmount: { fontSize: 16, lineHeight: 21, fontWeight: '700', fontVariant: ['tabular-nums'] },
  amountOwed: { color: EMERALD },
  amountOwe: { color: AMBER },
  banner: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: CARD,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: BORDER,
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
  },
  bannerMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  bannerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accentSubtle,
  },
  bannerCopy: { flex: 1, minWidth: 0 },
  bannerTitle: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: theme.colors.textPrimary },
  bannerBody: { marginTop: 2, fontSize: 12, lineHeight: 16, color: theme.colors.textSecondary },
  bannerDismiss: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: {
    marginTop: 22,
    paddingHorizontal: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  action: { flex: 1, alignItems: 'center' },
  actionCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1C1C21',
    borderWidth: 1,
    borderColor: BORDER,
  },
  actionCirclePrimary: {
    backgroundColor: 'rgba(129, 140, 248, 0.16)',
    borderColor: 'rgba(16, 185, 129, 0.35)',
  },
  actionLabel: {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
  section: { marginTop: 28, paddingHorizontal: 16 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    paddingHorizontal: 2,
    gap: 8,
  },
  sectionLabel: { ...theme.typography.sectionLabel, color: theme.colors.textMuted },
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
  seeAllText: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: theme.colors.accent },
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
  attentionAmount: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: POUNDS, fontVariant: ['tabular-nums'] },
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
    backgroundColor: CARD,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardPressed: { backgroundColor: '#1C1C21' },
  activityCopy: { flex: 1, minWidth: 0 },
  activityTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: theme.colors.textPrimary },
  activityMetaRow: { marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
  activityMeta: { flexShrink: 1, fontSize: 12, lineHeight: 16, color: theme.colors.textSecondary },
  statusPill: { borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  statusSettled: { backgroundColor: 'rgba(16, 185, 129, 0.16)' },
  statusOpen: { backgroundColor: 'rgba(245, 158, 11, 0.16)' },
  statusText: { fontSize: 10, lineHeight: 14, fontWeight: '700', letterSpacing: 0.2 },
  statusSettledText: { color: '#10B981' },
  statusOpenText: { color: '#F59E0B' },
  activityAmount: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: POUNDS, fontVariant: ['tabular-nums'] },
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
  skelHero: { height: 168, borderRadius: 22, marginBottom: 22, backgroundColor: '#1C1C21' },
  skelCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#1C1C21' },
  skelRow: { height: 72, borderRadius: 16, marginTop: 10, backgroundColor: '#1C1C21' },
});
