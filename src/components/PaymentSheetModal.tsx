import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { payoutService, type PayoutMethod } from '@/services/PayoutService';
import { theme } from '@/theme/theme';
import { formatPence } from '@/utils/money';
import {
  buildPaymentUrl,
  formatSortCode,
  getProviderLimitWarning,
  maskAccountNumber,
  sanitizePaymentHandle,
  sanitizeReference,
  type PaymentLinkProvider,
} from '@/utils/paymentLinks';

export type MarkPaidResult = 'paid' | 'already_settled' | 'unavailable';

type PaymentSheetModalProps = {
  visible: boolean;
  hostUserId: string | null;
  hostName: string;
  amountPence: number;
  reference: string;
  onClose: () => void;
  onMarkPaid: () => Promise<MarkPaidResult>;
};

type LinkOption = {
  provider: PaymentLinkProvider;
  handle: string;
};

const PROVIDER_LABEL: Record<PaymentLinkProvider, string> = {
  monzo: 'Monzo',
  revolut: 'Revolut',
  paypal: 'PayPal',
};

export function PaymentSheetModal({
  visible,
  hostUserId,
  hostName,
  amountPence,
  reference,
  onClose,
  onMarkPaid,
}: PaymentSheetModalProps) {
  const [method, setMethod] = useState<PayoutMethod | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestKey = visible && hostUserId ? hostUserId : null;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (loadedKey !== requestKey) {
    setLoadedKey(requestKey);
    setMethod(null);
    setLoading(requestKey !== null);
    setLoadFailed(false);
    setRevealed(false);
    setLinkError(null);
    setFailedUrl(null);
    setNotice(null);
  }

  useEffect(() => {
    if (!requestKey) return;
    let cancelled = false;
    void payoutService.getHostPayoutMethod(requestKey)
      .then((next) => {
        if (!cancelled) setMethod(next);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const safeReference = sanitizeReference(reference);
  const links = linkOptions(method);
  const bank = bankDetails(method);
  const amountLabel = formatPence(amountPence);
  const hasPayout = links.length > 0 || bank !== null;

  async function copyValue(field: string, value: string, sensitive: boolean) {
    try {
      await Clipboard.setStringAsync(value, sensitive ? { android: { isSensitive: true } } : undefined);
      setCopiedField(field);
      void Haptics.selectionAsync();
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        setCopiedField((current) => (current === field ? null : current));
      }, 1200);
    } catch {
      console.error('[PaymentSheet] copy failed');
    }
  }

  async function openProvider(option: LinkOption) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setLinkError(null);
    setFailedUrl(null);
    try {
      const url = buildPaymentUrl(option.provider, option.handle, amountPence, safeReference);
      await Linking.openURL(url);
    } catch {
      let url: string | null = null;
      try {
        url = buildPaymentUrl(option.provider, option.handle, amountPence, safeReference);
      } catch {
        url = null;
      }
      setFailedUrl(url);
      setLinkError(url ? 'Could not open the payment app.' : 'This payment link is not valid.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function markPaid() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setNotice(null);
    try {
      const result = await onMarkPaid();
      if (result === 'already_settled') {
        setNotice('This split is already settled.');
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setTimeout(() => onClose(), 700);
        return;
      }
      if (result === 'unavailable') {
        setNotice('Could not verify this balance. Nothing was marked paid.');
        submittingRef.current = false;
        setSubmitting(false);
        return;
      }
      onClose();
    } catch {
      setNotice('Could not mark this as paid. Try again.');
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function close() {
    if (submittingRef.current) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={close}>
      <View style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss payment" disabled={submitting} onPress={close} style={StyleSheet.absoluteFill} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.kicker}>Pay {hostName}</Text>
              <Text style={styles.amount}>{amountLabel}</Text>
              {safeReference ? <Text style={styles.reference} numberOfLines={1}>Reference · {safeReference}</Text> : null}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close payment" disabled={submitting} hitSlop={10} onPress={close} style={styles.close}>
              <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
            {loading ? <ActivityIndicator color={theme.colors.accent} style={styles.spinner} /> : null}
            {loadFailed ? <Text style={styles.warning}>Payout details could not be loaded. You can still mark this as paid.</Text> : null}

            {!loading && !hasPayout ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No payout details yet</Text>
                <Text style={styles.emptyBody}>Ask {hostName} to add payout details in Settings.</Text>
              </View>
            ) : null}

            {links.map((option) => {
              const warning = getProviderLimitWarning(option.provider, amountPence);
              return (
                <View key={option.provider} style={styles.block}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Pay via ${PROVIDER_LABEL[option.provider]} @${option.handle}`}
                    accessibilityState={{ disabled: submitting, busy: submitting }}
                    disabled={submitting}
                    onPress={() => {
                      void openProvider(option);
                    }}
                    style={({ pressed }) => [styles.payButton, pressed && !submitting && styles.payPressed, submitting && styles.disabled]}
                  >
                    <Text style={styles.payText}>Pay via {PROVIDER_LABEL[option.provider]} (@{option.handle})</Text>
                  </Pressable>
                  {warning ? <Text style={styles.warning}>{warning}</Text> : null}
                </View>
              );
            })}

            {linkError ? (
              <View style={styles.block}>
                <Text style={styles.warning}>{linkError}</Text>
                {failedUrl ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Copy payment link"
                    onPress={() => {
                      void copyValue('link', failedUrl, false);
                    }}
                    style={styles.copyButton}
                  >
                    <Text style={styles.copyText}>{copiedField === 'link' ? 'Copied' : 'Copy Payment Link'}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {bank ? (
              <View style={styles.bankCard}>
                <Text style={styles.bankTitle}>UK bank details</Text>
                <BankRow label="Account name" value={bank.name} copied={copiedField === 'name'} onCopy={() => { void copyValue('name', bank.name, true); }} />
                <BankRow label="Sort code" value={formatSortCode(bank.sortCode)} copied={copiedField === 'sort'} onCopy={() => { void copyValue('sort', formatSortCode(bank.sortCode), true); }} />
                <BankRow
                  label="Account number"
                  value={revealed ? bank.accountNumber : maskAccountNumber(bank.accountNumber)}
                  copied={copiedField === 'account'}
                  onCopy={() => { void copyValue('account', bank.accountNumber, true); }}
                  trailing={(
                    <Pressable accessibilityRole="button" accessibilityLabel={revealed ? 'Hide account number' : 'Reveal account number'} onPress={() => setRevealed((current) => !current)}>
                      <Text style={styles.reveal}>{revealed ? 'Hide' : 'Reveal'}</Text>
                    </Pressable>
                  )}
                />
                <BankRow label="Amount" value={amountLabel} copied={copiedField === 'amount'} onCopy={() => { void copyValue('amount', amountLabel, false); }} />
                {safeReference ? (
                  <BankRow label="Reference" value={safeReference} copied={copiedField === 'reference'} onCopy={() => { void copyValue('reference', safeReference, false); }} />
                ) : null}
              </View>
            ) : null}

            {notice ? <Text style={styles.notice}>{notice}</Text> : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="I've paid, mark as paid"
              accessibilityState={{ disabled: submitting, busy: submitting }}
              disabled={submitting}
              onPress={() => {
                void markPaid();
              }}
              style={({ pressed }) => [styles.markButton, pressed && !submitting && styles.markPressed, submitting && styles.disabled]}
            >
              {submitting ? <ActivityIndicator color={theme.colors.accent} /> : <Text style={styles.markText}>{"I've Paid — Mark as Paid"}</Text>}
            </Pressable>

            <Text style={styles.disclaimer}>{"Payments happen directly in your banking app. Always verify the recipient's name and amount before confirming."}</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function BankRow({
  label,
  value,
  copied,
  onCopy,
  trailing,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.bankRow}>
      <View style={styles.bankCopy}>
        <Text style={styles.bankLabel}>{label}</Text>
        <Text style={styles.bankValue} numberOfLines={1}>{value}</Text>
      </View>
      {trailing}
      <Pressable accessibilityRole="button" accessibilityLabel={`Copy ${label}`} onPress={onCopy} style={styles.copyChip}>
        <Text style={styles.copyChipText}>{copied ? 'Copied' : 'Copy'}</Text>
      </Pressable>
    </View>
  );
}

function linkOptions(method: PayoutMethod | null): LinkOption[] {
  if (!method) return [];
  const options: LinkOption[] = [];
  const add = (provider: PaymentLinkProvider, handle: string | null) => {
    if (!handle) return;
    const safe = sanitizePaymentHandle(provider, handle);
    if (safe) options.push({ provider, handle: safe });
  };
  add('monzo', method.monzoHandle);
  add('revolut', method.revolutHandle);
  add('paypal', method.paypalHandle);
  const preferred = method.preferredMethod;
  if (preferred && preferred !== 'bank') {
    options.sort((left, right) => Number(right.provider === preferred) - Number(left.provider === preferred));
  }
  return options;
}

function bankDetails(method: PayoutMethod | null) {
  if (!method?.bankAccountName || !method.bankSortCode || !method.bankAccountNumber) return null;
  if (!/^[0-9]{6}$/.test(method.bankSortCode) || !/^[0-9]{8}$/.test(method.bankAccountNumber)) return null;
  return {
    name: method.bankAccountName,
    sortCode: method.bankSortCode,
    accountNumber: method.bankAccountNumber,
  };
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.scrim },
  sheet: {
    maxHeight: '88%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: theme.colors.surface,
    paddingTop: 18,
    paddingBottom: 28,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 20, gap: 12 },
  headerCopy: { flex: 1, minWidth: 0 },
  kicker: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: theme.colors.textSecondary },
  amount: { marginTop: 2, fontSize: 32, lineHeight: 38, fontWeight: '700', color: theme.colors.textPrimary, fontVariant: ['tabular-nums'] },
  reference: { marginTop: 4, fontSize: 13, lineHeight: 18, color: theme.colors.textMuted },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
  },
  body: { paddingHorizontal: 20, paddingTop: 18, gap: 12 },
  spinner: { marginVertical: 12 },
  block: { gap: 8 },
  payButton: {
    minHeight: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    backgroundColor: theme.colors.accent,
  },
  payPressed: { backgroundColor: theme.colors.accentPressed },
  payText: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: theme.colors.accentText },
  warning: { fontSize: 13, lineHeight: 18, color: theme.colors.warning },
  copyButton: {
    alignSelf: 'flex-start',
    minHeight: 36,
    borderRadius: theme.radius.full,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
  },
  copyText: { fontSize: 13, fontWeight: '600', color: theme.colors.accent },
  empty: {
    borderRadius: 16,
    padding: 16,
    backgroundColor: theme.colors.surfaceElevated,
    gap: 4,
  },
  emptyTitle: { fontSize: 15, fontWeight: '600', color: theme.colors.textPrimary },
  emptyBody: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  bankCard: {
    borderRadius: 16,
    padding: 14,
    gap: 12,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  bankTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.textSecondary },
  bankRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bankCopy: { flex: 1, minWidth: 0 },
  bankLabel: { fontSize: 11, lineHeight: 14, color: theme.colors.textMuted },
  bankValue: { marginTop: 2, fontSize: 15, lineHeight: 20, fontWeight: '600', color: theme.colors.textPrimary, fontVariant: ['tabular-nums'] },
  reveal: { fontSize: 13, fontWeight: '600', color: theme.colors.accent },
  copyChip: { paddingHorizontal: 10, paddingVertical: 6 },
  copyChipText: { fontSize: 13, fontWeight: '600', color: theme.colors.accent },
  notice: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  markButton: {
    minHeight: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.accentBorder,
    backgroundColor: theme.colors.surface,
  },
  markPressed: { backgroundColor: theme.colors.surfaceElevated },
  markText: { fontSize: 15, fontWeight: '600', color: theme.colors.accent },
  disabled: { opacity: 0.55 },
  disclaimer: { fontSize: 12, lineHeight: 17, color: theme.colors.textMuted },
});
