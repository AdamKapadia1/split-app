import Head from 'expo-router/head';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { VelorBrand } from '@/components/VelorBrand';
import { APP_NAME, APP_TAGLINE } from '@/constants/brand';
import { luxury } from '@/constants/theme';
import { getWebBaseUrl } from '@/lib/url';
import {
  billShareService,
  shareBillUrl,
  type SharedBill,
  BillShareServiceError,
} from '@/services/BillShareService';
import { formatPence } from '@/utils/money';
import { reconcileSharedBill, splitEquallyDeterministic } from '@/utils/sharedSplitMath';
import {
  copyPlainText,
  isHttpsUrl,
  resolveUkPaymentRails,
  type UkPaymentRails,
} from '@/utils/ukPaymentRails';

const INVALID_COPY = 'This link is inactive or has been revoked.';

export default function SharedSplitScreen() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(params.token) ? params.token[0] ?? '' : params.token ?? '';
  const insets = useSafeAreaInsets();
  const usableToken = isShareToken(token);
  const [bill, setBill] = useState<SharedBill | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'invalid' | 'error'>(usableToken ? 'loading' : 'invalid');
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [joining, setJoining] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const busy = useRef(false);
  const revision = useRef(0);

  const remember = useCallback((id: string | null) => {
    setParticipantId(id);
    writeStoredParticipant(token, id);
  }, [token]);

  const fetchBill = useCallback(async () => {
    try {
      const next = await billShareService.fetchSharedBill(token);
      if (!next) return { status: 'invalid' as const, bill: null };
      return { status: 'ready' as const, bill: next };
    } catch (error) {
      if (error instanceof BillShareServiceError && (error.code === 'INVALID' || error.code === 'NOT_FOUND')) {
        return { status: 'invalid' as const, bill: null };
      }
      return { status: 'error' as const, bill: null };
    }
  }, [token]);

  const applyBill = useCallback((result: { status: 'ready' | 'invalid' | 'error'; bill: SharedBill | null }, silent: boolean) => {
    if (result.status === 'ready' && result.bill) {
      const next = result.bill;
      setBill(next);
      setPhase('ready');
      setParticipantId((current) => {
        const stored = current ?? readStoredParticipant(token);
        if (stored && next.participants.some((person) => person.id === stored)) return stored;
        return current && next.participants.some((person) => person.id === current) ? current : null;
      });
      return;
    }
    if (result.status === 'invalid') {
      setBill(null);
      setPhase('invalid');
      return;
    }
    if (!silent) setPhase('error');
  }, [token]);

  useEffect(() => {
    if (!usableToken) return;
    let cancelled = false;
    void fetchBill().then((result) => {
      if (!cancelled) applyBill(result, false);
    });
    return () => {
      cancelled = true;
    };
  }, [applyBill, fetchBill, usableToken]);

  useEffect(() => {
    if (phase !== 'ready') return;
    const timer = setInterval(() => {
      if (busy.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      const seen = revision.current;
      void fetchBill().then((result) => {
        if (seen !== revision.current || busy.current) return;
        applyBill(result, true);
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [applyBill, fetchBill, phase]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast(null);
      setCopiedKey(null);
    }, 1600);
    return () => clearTimeout(timer);
  }, [toast]);

  const person = bill?.participants.find((entry) => entry.id === participantId) ?? null;

  async function join() {
    const name = cleanGuestName(draftName);
    if (!name || joining) {
      setNotice('Enter a first name, up to 40 characters.');
      return;
    }
    busy.current = true;
    revision.current += 1;
    setJoining(true);
    setNotice(null);
    try {
      const next = await billShareService.mutateSharedBill(token, 'toggle_item_claim', { display_name: name });
      if (!next) {
        setPhase('invalid');
        return;
      }
      const created = next.participants.find((entry) => entry.isGuest && entry.displayName.toLowerCase() === name.toLowerCase());
      setBill(next);
      setPhase('ready');
      if (created) remember(created.id);
      setAdding(false);
      setDraftName('');
    } catch (error) {
      setNotice(error instanceof BillShareServiceError ? error.message : 'Could not add that name.');
    } finally {
      busy.current = false;
      setJoining(false);
    }
  }

  async function toggleItem(itemId: string) {
    if (!bill || busy.current) return;
    if (!participantId) {
      setNotice('Choose your name, or add it, before tapping an item.');
      setAdding(true);
      return;
    }
    const previous = bill;
    busy.current = true;
    revision.current += 1;
    setBusyItemId(itemId);
    setNotice(null);
    setBill(optimisticClaim(bill, participantId, itemId));
    try {
      const next = await billShareService.mutateSharedBill(token, 'toggle_item_claim', {
        item_id: itemId,
        participant_id: participantId,
      });
      if (!next) {
        setBill(previous);
        setPhase('invalid');
        return;
      }
      setBill(next);
    } catch (error) {
      setBill(previous);
      setNotice(error instanceof BillShareServiceError ? error.message : 'Could not update that item.');
    } finally {
      busy.current = false;
      setBusyItemId(null);
    }
  }

  async function setPaid(isPaid: boolean) {
    if (!bill || !participantId || busy.current) return;
    const previous = bill;
    busy.current = true;
    revision.current += 1;
    setPaying(true);
    setNotice(null);
    setBill({
      ...bill,
      participants: bill.participants.map((entry) => (
        entry.id === participantId
          ? { ...entry, isPaid, paidAt: isPaid ? new Date().toISOString() : null }
          : entry
      )),
    });
    try {
      const next = await billShareService.mutateSharedBill(token, 'set_paid_status', {
        participant_id: participantId,
        is_paid: isPaid,
      });
      if (!next) {
        setBill(previous);
        setPhase('invalid');
        return;
      }
      setBill(next);
    } catch (error) {
      setBill(previous);
      setNotice(error instanceof BillShareServiceError ? error.message : 'Could not update payment status.');
    } finally {
      busy.current = false;
      setPaying(false);
    }
  }

  async function copyText(value: string, key: string) {
    let copied = await copyPlainText(value);
    if (!copied) {
      try {
        await Clipboard.setStringAsync(value);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      setNotice('Could not copy that. Try again.');
      return;
    }
    setNotice(null);
    setCopiedKey(key);
    setToast('Copied');
  }

  async function openHttps(url: string) {
    if (!isHttpsUrl(url)) {
      setNotice('That payment link could not be opened.');
      return;
    }
    try {
      await Linking.openURL(url);
    } catch {
      setNotice('That payment link could not be opened.');
    }
  }

  const claimedCount = bill?.items.filter((item) => item.claimedBy.length > 0).length ?? 0;
  const owed = bill?.participants.reduce((sum, entry) => sum + entry.amountOwedPence, 0) ?? 0;
  const unclaimed = bill ? Math.max(0, bill.bill.totalPence - owed) : 0;
  const rails = person && bill
    ? resolveUkPaymentRails({
        monzoHandle: bill.owner.payoutDetails?.monzoHandle ?? null,
        revolutHandle: bill.owner.payoutDetails?.revolutHandle ?? null,
        paymentLink: bill.owner.payoutDetails?.paymentLink ?? null,
        bankAccountName: bill.owner.payoutDetails?.bankAccountName ?? null,
        bankSortCode: bill.owner.payoutDetails?.bankSortCode ?? null,
        bankAccountNumber: bill.owner.payoutDetails?.bankAccountNumber ?? null,
        amountPence: person.amountOwedPence,
        amountLabel: formatPence(person.amountOwedPence),
        referenceSource: token,
      })
    : null;
  const mutating = busyItemId !== null || paying || joining;

  return (
    <View style={styles.page}>
      {Platform.OS === 'web' ? (
        <Head>
          <title>{APP_NAME}</title>
          <meta name="theme-color" content={luxury.bgCanvas} />
          <meta name="description" content={APP_TAGLINE} />
          <meta property="og:title" content={APP_NAME} />
          <meta property="og:description" content={APP_TAGLINE} />
          <meta property="og:type" content="website" />
          <meta property="og:site_name" content={APP_NAME} />
          <meta property="og:url" content={usableToken ? shareBillUrl(token) : getWebBaseUrl()} />
        </Head>
      ) : null}
      <View style={[styles.column, { paddingTop: Math.max(insets.top, 12), paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.brandRow}>
          <VelorBrand variant="header" />
          <View style={styles.guestPill}>
            <Text style={styles.guestPillText}>No-account guest split</Text>
          </View>
        </View>

        {phase === 'loading' ? <Skeleton /> : null}
        {phase === 'invalid' ? (
          <View style={styles.messageCard}>
            <Text style={styles.messageTitle}>Link unavailable</Text>
            <Text style={styles.messageBody}>{INVALID_COPY}</Text>
          </View>
        ) : null}
        {phase === 'error' ? (
          <View style={styles.messageCard}>
            <Text style={styles.messageTitle}>Could not load this split</Text>
            <Text style={styles.messageBody}>Check the connection and try again.</Text>
            <Pressable accessibilityRole="button" onPress={() => { void fetchBill().then((result) => applyBill(result, false)); }} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {phase === 'ready' && bill ? (
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            <View style={styles.hero}>
              <Text style={styles.merchant}>{bill.bill.merchantName}</Text>
              <Text style={styles.date}>{formatUkDate(bill.bill.createdAt || bill.bill.billDate)}</Text>
              <Text style={styles.total}>{formatPence(bill.bill.totalPence)}</Text>
              <View style={[styles.trust, bill.bill.isReconciled ? styles.trustGood : styles.trustCheck]}>
                <Text style={[styles.trustText, bill.bill.isReconciled ? styles.trustTextGood : styles.trustTextCheck]}>
                  {bill.bill.isReconciled ? 'UK VAT-inclusive · Totals reconciled' : 'UK VAT-inclusive · Totals need a look'}
                </Text>
              </View>
              {bill.bill.vatPence > 0 ? <Text style={styles.meta}>Includes {formatPence(bill.bill.vatPence)} VAT</Text> : null}
              {bill.bill.serviceChargePence > 0 ? (
                <Text style={styles.meta}>Discretionary service {formatPence(bill.bill.serviceChargePence)}</Text>
              ) : null}
            </View>

            <Text style={styles.section}>Who are you?</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>
              {bill.participants.map((entry) => {
                const selected = entry.id === participantId;
                return (
                  <Pressable
                    key={entry.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      remember(entry.id);
                      setNotice(null);
                    }}
                    style={[styles.pill, selected && styles.pillOn]}
                  >
                    <Text style={[styles.pillText, selected && styles.pillTextOn]}>{entry.displayName}</Text>
                  </Pressable>
                );
              })}
              <Pressable accessibilityRole="button" onPress={() => setAdding(true)} style={styles.pill}>
                <Text style={styles.pillText}>+ I&apos;m not listed</Text>
              </Pressable>
            </ScrollView>
            {adding ? (
              <View style={styles.joinRow}>
                <TextInput
                  accessibilityLabel="First name"
                  autoCapitalize="words"
                  autoCorrect={false}
                  maxLength={40}
                  placeholder="First name"
                  placeholderTextColor="#71717A"
                  value={draftName}
                  onChangeText={setDraftName}
                  style={styles.joinInput}
                />
                <Pressable accessibilityRole="button" disabled={joining} onPress={() => { void join(); }} style={styles.joinButton}>
                  {joining ? <ActivityIndicator color="#09090B" /> : <Text style={styles.joinButtonText}>Join</Text>}
                </Pressable>
              </View>
            ) : null}

            <View style={styles.progressHeader}>
              <Text style={styles.progressLabel}>{claimedCount} of {bill.items.length} items claimed</Text>
              <Text style={styles.progressLabel}>{formatPence(unclaimed)} unclaimed</Text>
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${bill.items.length === 0 ? 0 : Math.round((claimedCount / bill.items.length) * 100)}%` }]} />
            </View>

            <View style={styles.list}>
              {bill.items.map((item) => {
                const mine = item.claimedBy.some((entry) => entry.id === participantId);
                const pieces = splitEquallyDeterministic(item.totalPricePence, item.claimedBy.map((entry) => entry.id));
                const minePiece = participantId ? pieces[participantId] : undefined;
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: mine, busy: busyItemId === item.id, disabled: mutating }}
                    disabled={mutating}
                    onPress={() => { void toggleItem(item.id); }}
                    style={[styles.item, mine && styles.itemMine, mutating && busyItemId !== item.id && styles.itemLocked]}
                  >
                    <View style={styles.itemTop}>
                      <View style={styles.itemNameRow}>
                        {item.quantity > 1 ? (
                          <View style={styles.qty}><Text style={styles.qtyText}>×{item.quantity}</Text></View>
                        ) : null}
                        <Text style={styles.itemName}>{item.name}</Text>
                      </View>
                      <Text style={styles.itemPrice}>{formatPence(item.totalPricePence)}</Text>
                    </View>
                    {item.claimedBy.length > 0 ? (
                      <View style={styles.avatars}>
                        {item.claimedBy.map((entry) => (
                          <View key={entry.id} style={styles.avatar}>
                            <Text style={styles.avatarText}>{initials(entry.displayName)}</Text>
                          </View>
                        ))}
                        {item.claimedBy.length > 1 ? (
                          <Text style={styles.splitNote}>
                            Split {item.claimedBy.length} ways{minePiece != null ? ` · ${formatPence(minePiece)} yours` : ''}
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.settle}>
              <Text style={styles.section}>Your share</Text>
              {person ? (
                <>
                  <Row label="Claimed items" value={formatPence(person.itemsSubtotalPence)} />
                  {bill.bill.serviceChargePence > 0 ? (
                    <Row
                      label={serviceLabel(bill.bill.serviceChargeRate, bill.bill.serviceChargePence)}
                      value={formatPence(shownService(person.itemsSubtotalPence, person.serviceChargePence, person.amountOwedPence))}
                    />
                  ) : null}
                  {shareRemainder(person.itemsSubtotalPence, person.serviceChargePence, person.amountOwedPence, bill.bill.serviceChargePence) > 0 ? (
                    <Row
                      label="Tip and rounding"
                      value={formatPence(shareRemainder(person.itemsSubtotalPence, person.serviceChargePence, person.amountOwedPence, bill.bill.serviceChargePence))}
                    />
                  ) : null}
                  <Row label="Your total to pay" value={formatPence(person.amountOwedPence)} strong />
                  {bill.bill.vatPence > 0 ? <Text style={styles.meta}>UK VAT included in item prices</Text> : null}
                  <PayoutBlock
                    rails={rails}
                    ownerName={bill.owner.displayName}
                    amountLabel={formatPence(person.amountOwedPence)}
                    copiedKey={copiedKey}
                    onOpen={(url) => { void openHttps(url); }}
                    onCopy={(value, key) => { void copyText(value, key); }}
                  />
                  {person.isPaid ? (
                    <View style={styles.paidCard}>
                      <Text style={styles.paidTitle}>Marked as Paid · Sent to {bill.owner.displayName}</Text>
                      <Pressable accessibilityRole="button" disabled={paying} onPress={() => { void setPaid(false); }}>
                        <Text style={styles.undo}>Undo</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      disabled={paying || person.amountOwedPence <= 0}
                      onPress={() => { void setPaid(true); }}
                      style={[styles.payButton, person.amountOwedPence <= 0 && styles.payButtonOff]}
                    >
                      {paying ? <ActivityIndicator color="#09090B" /> : (
                        <Text style={styles.payButtonText}>I&apos;ve Paid {formatPence(person.amountOwedPence)}</Text>
                      )}
                    </Pressable>
                  )}
                </>
              ) : (
                <Text style={styles.meta}>Select your name to see what you owe {bill.owner.displayName}.</Text>
              )}
              {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            </View>

            <View style={styles.footer}>
              <Text style={styles.footerText}>Splitting bills in York or with housemates? Scan UK receipts in seconds with Velor.</Text>
            </View>
          </ScrollView>
        ) : null}
        {toast ? (
          <View style={styles.toast}><Text style={styles.toastText}>{toast}</Text></View>
        ) : null}
      </View>
    </View>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, strong && styles.rowStrong]}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.rowStrong]}>{value}</Text>
    </View>
  );
}

function PayoutBlock({
  rails,
  ownerName,
  amountLabel,
  copiedKey,
  onOpen,
  onCopy,
}: {
  rails: UkPaymentRails | null;
  ownerName: string;
  amountLabel: string;
  copiedKey: string | null;
  onOpen: (url: string) => void;
  onCopy: (value: string, key: string) => void;
}) {
  if (!rails || (!rails.monzo && !rails.revolut && !rails.bank)) {
    return <Text style={styles.meta}>Pay {ownerName} however you already settle with them.</Text>;
  }
  return (
    <View style={styles.payout}>
      <Text style={styles.railLabel}>Pay {ownerName}</Text>
      {rails.monzo ? (
        <Pressable accessibilityRole="link" onPress={() => onOpen(rails.monzo!.url)} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Pay {amountLabel} with Monzo</Text>
        </Pressable>
      ) : null}
      {rails.revolut ? (
        <>
          <Pressable accessibilityRole="link" onPress={() => onOpen(rails.revolut!.url)} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Open Revolut</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => onCopy(rails.revolut!.copyText, 'revolut')} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{copiedKey === 'revolut' ? 'Copied' : 'Copy handle & amount'}</Text>
          </Pressable>
        </>
      ) : null}
      {rails.bank ? (
        <View style={styles.bankCard}>
          <Text style={styles.railLabel}>UK Faster Payments</Text>
          <Text style={styles.meta}>Any UK bank app. Barclays, HSBC, Lloyds, NatWest, Santander, Starling, Halifax.</Text>
          <CopyRow label="Recipient" value={rails.bank.recipient} copied={copiedKey === 'name'} onPress={() => onCopy(rails.bank!.recipient, 'name')} />
          <CopyRow label="Sort code" value={rails.bank.sortCodeDisplay} copied={copiedKey === 'sort'} onPress={() => onCopy(rails.bank!.sortCodeDigits, 'sort')} />
          <CopyRow label="Account number" value={rails.bank.accountNumber} copied={copiedKey === 'account'} onPress={() => onCopy(rails.bank!.accountNumber, 'account')} />
          <CopyRow label="Reference" value={rails.bank.reference} copied={copiedKey === 'ref'} onPress={() => onCopy(rails.bank!.reference, 'ref')} />
          <Text style={styles.bankLine}>Amount {amountLabel}</Text>
          <Pressable accessibilityRole="button" onPress={() => onCopy(rails.bank!.summary, 'all')} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{copiedKey === 'all' ? 'Copied' : 'Copy all bank details'}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function CopyRow({ label, value, copied, onPress }: { label: string; value: string; copied: boolean; onPress: () => void }) {
  return (
    <View style={styles.copyRow}>
      <View style={styles.copyText}>
        <Text style={styles.copyLabel}>{label}</Text>
        <Text style={styles.copyValue}>{value}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Copy ${label}`} onPress={onPress} style={styles.copyChip}>
        <Text style={styles.copyChipText}>{copied ? 'Copied' : 'Copy'}</Text>
      </Pressable>
    </View>
  );
}

function Skeleton() {
  return (
    <View style={styles.hero}>
      <View style={styles.boneWide} />
      <View style={styles.bone} />
      <View style={styles.boneTotal} />
      <ActivityIndicator color="#818CF8" style={styles.boneSpin} />
    </View>
  );
}

function optimisticClaim(bill: SharedBill, participantId: string, itemId: string): SharedBill {
  const person = bill.participants.find((entry) => entry.id === participantId);
  const items = bill.items.map((item) => {
    if (item.id !== itemId || !person) return item;
    const claimed = item.claimedBy.some((entry) => entry.id === participantId);
    return {
      ...item,
      claimedBy: claimed
        ? item.claimedBy.filter((entry) => entry.id !== participantId)
        : [...item.claimedBy, { id: person.id, displayName: person.displayName, userId: person.userId }],
    };
  });
  const math = reconcileSharedBill({
    items: items.map((item) => ({ id: item.id, pricePence: item.totalPricePence })),
    claims: items.flatMap((item) => item.claimedBy.map((entry) => ({ itemId: item.id, participantId: entry.id }))),
    participantIds: bill.participants.map((entry) => entry.id),
    totalPence: bill.bill.totalPence,
    serviceChargePence: bill.bill.serviceChargePence,
  });
  return {
    ...bill,
    items,
    participants: bill.participants.map((entry) => ({
      ...entry,
      itemsSubtotalPence: math.itemsSubtotal[entry.id] ?? 0,
      serviceChargePence: math.serviceCharge[entry.id] ?? 0,
      amountOwedPence: math.amountOwed[entry.id] ?? 0,
    })),
  };
}

function serviceLabel(rate: number | null, servicePence: number): string {
  if (servicePence <= 0) return 'Service charge';
  if (rate == null || !(rate > 0)) return 'Discretionary service';
  const percent = rate <= 1 ? rate * 100 : rate;
  const rounded = Math.round(percent * 10) / 10;
  if (!(rounded > 0) || rounded > 100) return 'Discretionary service';
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `Discretionary service (${text}%)`;
}

function shownService(itemsPence: number, servicePence: number, owedPence: number): number {
  return Math.min(Math.max(0, servicePence), Math.max(0, owedPence - itemsPence));
}

function shareRemainder(itemsPence: number, servicePence: number, owedPence: number, billServicePence: number): number {
  if (billServicePence <= 0) return Math.max(0, owedPence - itemsPence);
  return Math.max(0, owedPence - itemsPence - shownService(itemsPence, servicePence, owedPence));
}

function initials(name: string) {
  const letters = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

function formatUkDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function isShareToken(value: string) {
  return /^[A-Za-z0-9_-]{20,}$/.test(value);
}

function cleanGuestName(raw: string) {
  const clean = raw.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length < 1 || clean.length > 40 || clean.includes('@')) return null;
  return clean;
}

function storageKey(token: string) {
  return `velor.share.participant.${token}`;
}

function readStoredParticipant(token: string) {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(storageKey(token)) ?? window.sessionStorage.getItem(storageKey(token));
  } catch {
    return null;
  }
}

function writeStoredParticipant(token: string, id: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (!id) {
      window.localStorage.removeItem(storageKey(token));
      window.sessionStorage.removeItem(storageKey(token));
      return;
    }
    window.localStorage.setItem(storageKey(token), id);
    window.sessionStorage.setItem(storageKey(token), id);
  } catch {
    // Private browsing can reject storage. The choice still lasts for this view.
  }
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#050609', alignItems: 'center' },
  column: { flex: 1, width: '100%', maxWidth: 480 },
  brandRow: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  guestPill: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#0D0F15',
  },
  guestPillText: { color: '#A1A1AA', fontSize: 11, fontWeight: '600' },
  scroll: { paddingHorizontal: 16, paddingBottom: 28, gap: 12 },
  hero: {
    backgroundColor: '#0D0F15',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    padding: 18,
    gap: 6,
  },
  merchant: { color: '#FAFAFA', fontSize: 22, lineHeight: 28, fontWeight: '700' },
  date: { color: '#A1A1AA', fontSize: 13 },
  total: { color: '#FAFAFA', fontSize: 36, lineHeight: 42, fontWeight: '700', fontVariant: ['tabular-nums'], marginTop: 4 },
  trust: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, marginTop: 6 },
  trustGood: { backgroundColor: 'rgba(52, 211, 153, 0.12)' },
  trustCheck: { backgroundColor: 'rgba(129, 140, 248, 0.14)' },
  trustText: { fontSize: 12, fontWeight: '700' },
  trustTextGood: { color: '#34D399' },
  trustTextCheck: { color: '#A5B4FC' },
  meta: { color: '#A1A1AA', fontSize: 13, lineHeight: 18 },
  section: { color: '#FAFAFA', fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  pills: { gap: 8, paddingVertical: 4 },
  pill: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    backgroundColor: '#0D0F15',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  pillOn: { backgroundColor: '#818CF8', borderColor: '#818CF8' },
  pillText: { color: '#FAFAFA', fontSize: 14, fontWeight: '600' },
  pillTextOn: { color: '#09090B' },
  joinRow: { flexDirection: 'row', gap: 8 },
  joinInput: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    backgroundColor: '#090B10',
    color: '#FAFAFA',
    paddingHorizontal: 14,
    fontSize: 16,
  },
  joinButton: {
    minWidth: 76,
    borderRadius: 14,
    backgroundColor: '#818CF8',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  joinButtonText: { color: '#09090B', fontWeight: '700' },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  progressLabel: { color: '#A1A1AA', fontSize: 12, fontVariant: ['tabular-nums'] },
  track: { height: 3, borderRadius: 999, backgroundColor: '#1E2230', overflow: 'hidden' },
  fill: { height: 3, backgroundColor: '#818CF8' },
  list: {
    backgroundColor: '#0D0F15',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    overflow: 'hidden',
  },
  item: { paddingHorizontal: 14, paddingVertical: 14, gap: 8 },
  itemMine: { backgroundColor: 'rgba(129, 140, 248, 0.08)' },
  itemTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  itemNameRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  itemName: { flex: 1, color: '#FAFAFA', fontSize: 16, lineHeight: 21, fontWeight: '600' },
  itemPrice: { color: '#FAFAFA', fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  qty: { borderRadius: 999, backgroundColor: '#141722', paddingHorizontal: 7, paddingVertical: 3 },
  qtyText: { color: '#A1A1AA', fontSize: 12, fontWeight: '700' },
  avatars: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#1E2230',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#FAFAFA', fontSize: 10, fontWeight: '700' },
  splitNote: { color: '#A5B4FC', fontSize: 12, fontVariant: ['tabular-nums'] },
  settle: {
    backgroundColor: '#0D0F15',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    padding: 16,
    gap: 10,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { color: '#A1A1AA', fontSize: 14 },
  rowValue: { color: '#FAFAFA', fontSize: 14, fontVariant: ['tabular-nums'] },
  rowStrong: { color: '#FAFAFA', fontSize: 18, fontWeight: '700' },
  payout: { gap: 8 },
  railLabel: { color: '#FAFAFA', fontSize: 13, fontWeight: '700' },
  bankCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    backgroundColor: '#090B10',
    padding: 12,
    gap: 8,
  },
  bankLine: { color: '#FAFAFA', fontSize: 14, fontVariant: ['tabular-nums'] },
  copyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  copyText: { flex: 1, gap: 2 },
  copyLabel: { color: '#A1A1AA', fontSize: 12 },
  copyValue: { color: '#FAFAFA', fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  copyChip: {
    minHeight: 36,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copyChipText: { color: '#FAFAFA', fontSize: 13, fontWeight: '700' },
  itemLocked: { opacity: 0.72 },
  primaryButton: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: '#818CF8',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  primaryButtonText: { color: '#09090B', fontSize: 16, fontWeight: '700' },
  secondaryButton: {
    minHeight: 44,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  secondaryButtonText: { color: '#FAFAFA', fontSize: 14, fontWeight: '600' },
  payButton: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: '#FAFAFA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  payButtonOff: { opacity: 0.4 },
  payButtonText: { color: '#09090B', fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  paidCard: {
    borderRadius: 14,
    backgroundColor: 'rgba(52, 211, 153, 0.12)',
    padding: 14,
    gap: 6,
  },
  paidTitle: { color: '#34D399', fontSize: 15, fontWeight: '700' },
  undo: { color: '#A1A1AA', fontSize: 13, fontWeight: '600' },
  notice: { color: '#F87171', fontSize: 13, lineHeight: 18 },
  footer: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    padding: 16,
  },
  footerText: { color: '#71717A', fontSize: 13, lineHeight: 18 },
  messageCard: {
    margin: 16,
    backgroundColor: '#0D0F15',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1E2230',
    padding: 20,
    gap: 10,
  },
  messageTitle: { color: '#FAFAFA', fontSize: 22, fontWeight: '700' },
  messageBody: { color: '#A1A1AA', fontSize: 15, lineHeight: 21 },
  toast: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    backgroundColor: '#FAFAFA',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  toastText: { color: '#09090B', fontWeight: '700' },
  boneWide: { height: 18, width: '70%', borderRadius: 8, backgroundColor: '#1E2230' },
  bone: { height: 12, width: '40%', borderRadius: 8, backgroundColor: '#1E2230' },
  boneTotal: { height: 36, width: '46%', borderRadius: 10, backgroundColor: '#1E2230', marginTop: 8 },
  boneSpin: { marginTop: 16 },
});
