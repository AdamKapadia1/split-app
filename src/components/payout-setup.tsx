import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { payoutService, type PayoutMethod, type PayoutMethodKind } from '@/services/PayoutService';
import { theme } from '@/theme/theme';
import { mapErrorToUserMessage } from '@/utils/errorMapper';
import {
  buildProfilePreviewUrl,
  formatSortCode,
  normalizeAccountNumber,
  normalizeSortCode,
  parsePastedPaymentLink,
  sanitizePaymentHandle,
  type PaymentLinkProvider,
} from '@/utils/paymentLinks';

type PayoutSetupProps = {
  visible: boolean;
  userId: string | null;
  onClose: () => void;
  onSaved: (method: PayoutMethod | null) => void;
};

type Baseline = {
  monzo: string;
  revolut: string;
  paypal: string;
  accountName: string;
  sortCode: string;
  accountNumber: string;
  preferred: PayoutMethodKind | null;
};

const METHODS: { id: PayoutMethodKind; label: string }[] = [
  { id: 'monzo', label: 'Monzo' },
  { id: 'revolut', label: 'Revolut' },
  { id: 'paypal', label: 'PayPal' },
  { id: 'bank', label: 'Bank' },
];

const HINTS: Record<PayoutMethodKind, string> = {
  monzo: 'Find yours in Monzo: Payments → Request → Share Monzo.me link',
  revolut: 'Find yours in Revolut: Profile → @Revtag',
  paypal: 'Letters and numbers only — find yours in PayPal Settings → PayPal.Me',
  bank: 'Sort code and account number for UK Faster Payments from any bank app. Guests on a share link see the full account number.',
};

const EMPTY_BASELINE: Baseline = {
  monzo: '',
  revolut: '',
  paypal: '',
  accountName: '',
  sortCode: '',
  accountNumber: '',
  preferred: null,
};

export function PayoutSetup({ visible, userId, onClose, onSaved }: PayoutSetupProps) {
  const insets = useSafeAreaInsets();
  const [active, setActive] = useState<PayoutMethodKind>('monzo');
  const [preferred, setPreferred] = useState<PayoutMethodKind | null>(null);
  const [monzo, setMonzo] = useState('');
  const [revolut, setRevolut] = useState('');
  const [paypal, setPaypal] = useState('');
  const [accountName, setAccountName] = useState('');
  const [sortCode, setSortCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [baseline, setBaseline] = useState<Baseline>(EMPTY_BASELINE);
  const [savedFlags, setSavedFlags] = useState({ monzo: false, revolut: false, paypal: false, bank: false });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [testedHandle, setTestedHandle] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const openKey = visible && userId ? userId : null;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (loadedKey !== openKey) {
    setLoadedKey(openKey);
    setLoading(openKey !== null);
    setActive('monzo');
    setPreferred(null);
    setMonzo('');
    setRevolut('');
    setPaypal('');
    setAccountName('');
    setSortCode('');
    setAccountNumber('');
    setBaseline(EMPTY_BASELINE);
    setSavedFlags({ monzo: false, revolut: false, paypal: false, bank: false });
    setSaving(false);
    setSaveError(null);
    setPasteNote(null);
    setTestedHandle(null);
    setTestError(null);
  }

  useEffect(() => {
    if (!openKey) return;
    let cancelled = false;
    void payoutService.getMyPayoutMethod()
      .then((method) => {
        if (cancelled) return;
        const next = baselineFrom(method);
        setBaseline(next);
        setPreferred(next.preferred);
        setActive(next.preferred ?? 'monzo');
        setMonzo(next.monzo);
        setRevolut(next.revolut);
        setPaypal(next.paypal);
        setAccountName(next.accountName);
        setSortCode(next.sortCode);
        setAccountNumber(next.accountNumber);
        setSavedFlags({
          monzo: next.monzo.length > 0,
          revolut: next.revolut.length > 0,
          paypal: next.paypal.length > 0,
          bank: next.accountName.length > 0,
        });
      })
      .catch(() => {
        if (!cancelled) setSaveError('Could not load your payout details.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openKey]);

  const monzoHandle = sanitizePaymentHandle('monzo', monzo);
  const revolutHandle = sanitizePaymentHandle('revolut', revolut);
  const paypalHandle = sanitizePaymentHandle('paypal', paypal);
  const sortDigits = normalizeSortCode(sortCode);
  const accountDigits = normalizeAccountNumber(accountNumber);
  const name = accountName.trim();
  const bankReady = name.length >= 2 && name.length <= 70 && sortDigits !== null && accountDigits !== null;
  const bankStarted = name.length > 0 || sortCode.length > 0 || accountNumber.length > 0;
  const configured = configuredMethods({ monzoHandle, revolutHandle, paypalHandle, bankReady });
  if (configured.length === 1 && preferred !== configured[0]) {
    setPreferred(configured[0]);
  } else if (preferred && !configured.includes(preferred)) {
    setPreferred(configured[0] ?? null);
  }

  const effectivePreferred = configured.length === 1 ? configured[0] : preferred;
  const current: Baseline = { monzo, revolut, paypal, accountName, sortCode, accountNumber, preferred: effectivePreferred ?? null };
  const isDirty = !sameBaseline(current, baseline);
  const activeHandle = active === 'monzo' ? monzoHandle : active === 'revolut' ? revolutHandle : active === 'paypal' ? paypalHandle : null;
  const activeReady = active === 'bank' ? bankReady : Boolean(activeHandle);
  const activeInvalid = active === 'bank'
    ? bankStarted && !bankReady
    : (active === 'monzo' ? monzo : active === 'revolut' ? revolut : paypal).trim().length > 0 && !activeHandle;
  const saveBlocked = saving || loading || !userId || activeInvalid || (bankStarted && !bankReady) || !isDirty;

  function applyHandle(provider: PaymentLinkProvider, value: string) {
    if (provider === 'monzo') setMonzo(value);
    if (provider === 'revolut') setRevolut(value);
    if (provider === 'paypal') setPaypal(value);
    setTestedHandle(null);
    setTestError(null);
  }

  function requestClose() {
    if (saving) return;
    if (!isDirty) {
      onClose();
      return;
    }
    Alert.alert('Discard unsaved changes?', undefined, [
      { text: 'Keep Editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
  }

  async function save() {
    if (!userId || saving || activeInvalid || (bankStarted && !bankReady)) return;
    setSaving(true);
    setSaveError(null);
    const payload = {
      preferredMethod: effectivePreferred ?? null,
      monzoHandle: monzo,
      revolutHandle: revolut,
      paypalHandle: paypal,
      bankAccountName: bankReady ? name : null,
      bankSortCode: bankReady ? sortDigits : null,
      bankAccountNumber: bankReady ? accountDigits : null,
    };
    try {
      const nothingSaved = !monzoHandle && !revolutHandle && !paypalHandle && !bankReady;
      const saved = nothingSaved ? null : await payoutService.upsertMyPayoutMethod(payload);
      if (nothingSaved) await payoutService.deleteMyPayoutMethod();
      onSaved(saved);
      try {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {
        // Haptics are optional.
      }
      onClose();
    } catch (error) {
      setSaveError(mapErrorToUserMessage(error, 'Could not save payout details.'));
    } finally {
      setSaving(false);
    }
  }

  function confirmRemove() {
    if (saving || !savedFlags[active]) return;
    const label = METHODS.find((method) => method.id === active)?.label ?? 'method';
    Alert.alert(`Remove ${label} details?`, 'People you split with will no longer see them.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void removeActive();
        },
      },
    ]);
  }

  async function removeActive() {
    if (!userId || saving) return;
    const nextMonzo = active === 'monzo' ? '' : monzo;
    const nextRevolut = active === 'revolut' ? '' : revolut;
    const nextPaypal = active === 'paypal' ? '' : paypal;
    const clearBank = active === 'bank';
    const nextName = clearBank ? '' : accountName;
    const nextSort = clearBank ? '' : sortCode;
    const nextAccount = clearBank ? '' : accountNumber;
    const nextMonzoHandle = sanitizePaymentHandle('monzo', nextMonzo);
    const nextRevolutHandle = sanitizePaymentHandle('revolut', nextRevolut);
    const nextPaypalHandle = sanitizePaymentHandle('paypal', nextPaypal);
    const nextSortDigits = normalizeSortCode(nextSort);
    const nextAccountDigits = normalizeAccountNumber(nextAccount);
    const nextNameTrim = nextName.trim();
    const nextBankReady = nextNameTrim.length >= 2 && nextNameTrim.length <= 70 && nextSortDigits !== null && nextAccountDigits !== null;
    const remaining = configuredMethods({
      monzoHandle: nextMonzoHandle,
      revolutHandle: nextRevolutHandle,
      paypalHandle: nextPaypalHandle,
      bankReady: nextBankReady,
    });
    const nextPreferred = remaining.length === 1
      ? remaining[0]
      : effectivePreferred && remaining.includes(effectivePreferred)
        ? effectivePreferred
        : null;

    setSaving(true);
    setSaveError(null);
    try {
      const saved = remaining.length === 0
        ? null
        : await payoutService.upsertMyPayoutMethod({
          preferredMethod: nextPreferred ?? null,
          monzoHandle: nextMonzo,
          revolutHandle: nextRevolut,
          paypalHandle: nextPaypal,
          bankAccountName: nextBankReady ? nextNameTrim : null,
          bankSortCode: nextBankReady ? nextSortDigits : null,
          bankAccountNumber: nextBankReady ? nextAccountDigits : null,
        });
      if (remaining.length === 0) await payoutService.deleteMyPayoutMethod();
      const nextBaseline: Baseline = {
        monzo: nextMonzoHandle ?? '',
        revolut: nextRevolutHandle ?? '',
        paypal: nextPaypalHandle ?? '',
        accountName: nextBankReady ? nextNameTrim : '',
        sortCode: nextBankReady && nextSortDigits ? formatTypingSortCode(nextSortDigits) : '',
        accountNumber: nextBankReady && nextAccountDigits ? nextAccountDigits : '',
        preferred: nextPreferred ?? null,
      };
      setMonzo(nextBaseline.monzo);
      setRevolut(nextBaseline.revolut);
      setPaypal(nextBaseline.paypal);
      setAccountName(nextBaseline.accountName);
      setSortCode(nextBaseline.sortCode);
      setAccountNumber(nextBaseline.accountNumber);
      setPreferred(nextBaseline.preferred);
      setBaseline(nextBaseline);
      setSavedFlags({
        monzo: nextBaseline.monzo.length > 0,
        revolut: nextBaseline.revolut.length > 0,
        paypal: nextBaseline.paypal.length > 0,
        bank: nextBaseline.accountName.length > 0,
      });
      setTestedHandle(null);
      onSaved(saved);
    } catch (error) {
      setSaveError(mapErrorToUserMessage(error, 'Could not remove these details.'));
    } finally {
      setSaving(false);
    }
  }

  async function pasteLink() {
    if (saving || active === 'bank') return;
    setPasteNote(null);
    let text = '';
    try {
      text = await Clipboard.getStringAsync();
    } catch {
      setPasteNote('No Monzo, Revolut, or PayPal link found in clipboard');
      return;
    }
    const parsed = parsePastedPaymentLink(text);
    if (!parsed) {
      setPasteNote('No Monzo, Revolut, or PayPal link found in clipboard');
      return;
    }
    setActive(parsed.provider);
    applyHandle(parsed.provider, parsed.handle);
    setPasteNote('Link detected');
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // Haptics are optional.
    }
  }

  async function testLink() {
    if (saving || !activeHandle || active === 'bank') return;
    setTestError(null);
    try {
      const url = buildProfilePreviewUrl(active, activeHandle);
      await Linking.openURL(url);
      setTestedHandle(activeHandle);
    } catch {
      setTestError('Could not open that link.');
    }
  }

  const previewUrl = activeHandle && active !== 'bank' ? `https://${active}.me/${activeHandle}` : null;
  const linkOpened = Boolean(activeHandle && testedHandle === activeHandle);

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={requestClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss payout details" disabled={saving} onPress={requestClose} style={StyleSheet.absoluteFill} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>Payout details</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close payout details" disabled={saving} hitSlop={10} onPress={requestClose} style={styles.close}>
              <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.body, { paddingBottom: Math.max(insets.bottom, 24) + 12 }]}>
            {loading ? <ActivityIndicator accessibilityLabel="Loading payout details" color={theme.colors.accent} /> : null}
            <Text style={styles.privacy}>Your payout details are only visible to people you share a group or split with.</Text>
            <View style={styles.chips}>
              {METHODS.map((method) => {
                const selected = active === method.id;
                return (
                  <Pressable
                    key={method.id}
                    accessibilityRole="tab"
                    accessibilityLabel={method.label}
                    accessibilityState={{ selected }}
                    onPress={() => {
                      setActive(method.id);
                      setPasteNote(null);
                      setTestError(null);
                    }}
                    style={[styles.chip, selected ? styles.chipOn : styles.chipOff]}
                  >
                    {savedFlags[method.id] ? <View style={styles.savedDot} /> : null}
                    <Text style={[styles.chipText, selected ? styles.chipTextOn : styles.chipTextOff]}>{method.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {active !== 'bank' ? (
              <View style={styles.field}>
                <View style={styles.prefixRow}>
                  <Text style={styles.prefix}>{active}.me/</Text>
                  <TextInput
                    accessibilityLabel={`${METHODS.find((method) => method.id === active)?.label} handle`}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    textContentType="none"
                    returnKeyType="done"
                    placeholder="yourname"
                    placeholderTextColor={theme.colors.textMuted}
                    value={active === 'monzo' ? monzo : active === 'revolut' ? revolut : paypal}
                    onChangeText={(value) => applyHandle(active, value)}
                    style={styles.prefixInput}
                  />
                </View>
                <Text style={styles.hint}>{HINTS[active]}</Text>
                {activeInvalid ? <Text style={styles.error}>{active === 'paypal' ? 'PayPal handles are letters and numbers only.' : 'Use 2–64 letters, numbers, dots, underscores, or hyphens.'}</Text> : null}
                <Pressable accessibilityRole="button" accessibilityLabel="Paste link" disabled={saving} onPress={() => { void pasteLink(); }} style={styles.quiet}>
                  <Text style={styles.quietText}>Paste link</Text>
                </Pressable>
                {pasteNote ? <Text style={styles.note}>{pasteNote}</Text> : null}
                {previewUrl ? (
                  <View style={styles.previewCard}>
                    <Text style={styles.previewUrl} numberOfLines={1}>{previewUrl}</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Test link"
                      disabled={saving}
                      onPress={() => { void testLink(); }}
                      style={[styles.testButton, saving && styles.disabled]}
                    >
                      <Text style={styles.testText}>Test link ↗</Text>
                    </Pressable>
                  </View>
                ) : null}
                {linkOpened ? <Text style={styles.confirmed}>{"Link opened — confirm it's your account before saving"}</Text> : null}
                {testError ? <Text style={styles.error}>{testError}</Text> : null}
              </View>
            ) : (
              <View style={styles.field}>
                <Text style={styles.hint}>{HINTS.bank}</Text>
                <TextInput
                  accessibilityLabel="Account name"
                  autoCapitalize="words"
                  autoCorrect={false}
                  maxLength={70}
                  placeholder="Account name"
                  placeholderTextColor={theme.colors.textMuted}
                  value={accountName}
                  onChangeText={setAccountName}
                  style={styles.input}
                />
                {accountName.trim().length > 0 && (name.length < 2 || name.length > 70) ? <Text style={styles.error}>Account name must be 2 to 70 characters.</Text> : null}
                <TextInput
                  accessibilityLabel="Sort code"
                  keyboardType="number-pad"
                  maxLength={8}
                  placeholder="Sort code"
                  placeholderTextColor={theme.colors.textMuted}
                  value={sortCode}
                  onChangeText={(value) => setSortCode(formatTypingSortCode(value))}
                  style={styles.input}
                />
                {sortCode.length > 0 && !sortDigits ? <Text style={styles.error}>Enter a 6-digit sort code.</Text> : null}
                <TextInput
                  accessibilityLabel="Account number"
                  keyboardType="number-pad"
                  maxLength={8}
                  placeholder="Account number"
                  placeholderTextColor={theme.colors.textMuted}
                  value={accountNumber}
                  onChangeText={(value) => setAccountNumber(value.replace(/\D/g, '').slice(0, 8))}
                  style={styles.input}
                />
                {accountNumber.length > 0 && !accountDigits ? <Text style={styles.error}>Enter an 8-digit account number.</Text> : null}
                {bankStarted && !bankReady ? <Text style={styles.error}>Name, sort code, and account number must be saved together.</Text> : null}
                {bankReady && sortDigits && accountDigits ? (
                  <View style={styles.friendCard}>
                    <Text style={styles.friendTitle}>Friend preview</Text>
                    <Text style={styles.friendLine}>{name}</Text>
                    <Text style={styles.friendLine}>{formatSortCode(sortDigits)}</Text>
                    <Text style={styles.friendLine}>{accountDigits}</Text>
                  </View>
                ) : null}
              </View>
            )}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={effectivePreferred === active ? 'Preferred method' : 'Set as preferred'}
              accessibilityState={{ selected: effectivePreferred === active, disabled: saving || configured.length === 1 || !activeReady }}
              disabled={saving || configured.length === 1 || !activeReady}
              onPress={() => setPreferred(effectivePreferred === active ? null : active)}
              style={[styles.prefer, effectivePreferred === active && styles.preferOn, (saving || !activeReady) && styles.disabled]}
            >
              <Text style={[styles.preferText, effectivePreferred === active && styles.preferTextOn]}>
                {effectivePreferred === active ? 'Preferred' : 'Set as preferred'}
              </Text>
            </Pressable>

            {saveError ? (
              <View style={styles.errorBanner}>
                <Text style={styles.error}>{saveError}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Retry save" disabled={saving} onPress={() => { void save(); }}>
                  <Text style={styles.retry}>Retry</Text>
                </Pressable>
              </View>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save payout details"
              accessibilityState={{ disabled: saveBlocked, busy: saving }}
              disabled={saveBlocked}
              onPress={() => { void save(); }}
              style={({ pressed }) => [styles.save, pressed && !saving && styles.savePressed, saveBlocked && styles.disabled]}
            >
              {saving ? <ActivityIndicator color={theme.colors.accentText} /> : <Text style={styles.saveText}>Save</Text>}
            </Pressable>
            {savedFlags[active] ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${METHODS.find((method) => method.id === active)?.label ?? 'method'} details`}
                accessibilityState={{ disabled: saving }}
                disabled={saving}
                onPress={confirmRemove}
                style={[styles.quiet, saving && styles.disabled]}
              >
                <Text style={styles.dangerText}>Remove {METHODS.find((method) => method.id === active)?.label} details</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function configuredMethods(input: {
  monzoHandle: string | null;
  revolutHandle: string | null;
  paypalHandle: string | null;
  bankReady: boolean;
}): PayoutMethodKind[] {
  const methods: PayoutMethodKind[] = [];
  if (input.monzoHandle) methods.push('monzo');
  if (input.revolutHandle) methods.push('revolut');
  if (input.paypalHandle) methods.push('paypal');
  if (input.bankReady) methods.push('bank');
  return methods;
}

function baselineFrom(method: PayoutMethod | null): Baseline {
  if (!method) return EMPTY_BASELINE;
  const bankReady = Boolean(method.bankAccountName && method.bankSortCode && method.bankAccountNumber);
  const configured = configuredMethods({
    monzoHandle: method.monzoHandle,
    revolutHandle: method.revolutHandle,
    paypalHandle: method.paypalHandle,
    bankReady,
  });
  const preferred = configured.length === 1 ? configured[0] : method.preferredMethod;
  return {
    monzo: method.monzoHandle ?? '',
    revolut: method.revolutHandle ?? '',
    paypal: method.paypalHandle ?? '',
    accountName: method.bankAccountName ?? '',
    sortCode: method.bankSortCode ? formatTypingSortCode(method.bankSortCode) : '',
    accountNumber: method.bankAccountNumber ?? '',
    preferred: preferred ?? null,
  };
}

function sameBaseline(left: Baseline, right: Baseline) {
  return left.monzo === right.monzo
    && left.revolut === right.revolut
    && left.paypal === right.paypal
    && left.accountName === right.accountName
    && left.sortCode === right.sortCode
    && left.accountNumber === right.accountNumber
    && left.preferred === right.preferred;
}

function formatTypingSortCode(raw: string) {
  const digits = raw.replace(/\D/g, '').slice(0, 6);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.scrim },
  sheet: {
    maxHeight: '92%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: theme.colors.surface,
    paddingTop: 18,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '700', color: theme.colors.textPrimary },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
  },
  body: { paddingHorizontal: 20, paddingTop: 16, gap: 12 },
  privacy: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  chipOn: { backgroundColor: theme.colors.accentSubtle, borderWidth: 1, borderColor: theme.colors.accentBorder },
  chipOff: { backgroundColor: theme.colors.surfaceElevated, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
  chipText: { fontSize: 13 },
  chipTextOn: { fontWeight: '600', color: theme.colors.accent },
  chipTextOff: { fontWeight: '500', color: theme.colors.textSecondary },
  savedDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.positive },
  field: { gap: 8 },
  hint: { fontSize: 13, lineHeight: 18, color: theme.colors.textMuted },
  prefixRow: {
    minHeight: 48,
    borderRadius: 14,
    paddingLeft: 14,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  prefix: { fontSize: 15, color: theme.colors.textMuted },
  prefixInput: { flex: 1, minHeight: 48, paddingHorizontal: 4, fontSize: 15, color: theme.colors.textPrimary },
  input: {
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    color: theme.colors.textPrimary,
    fontSize: 15,
  },
  error: { fontSize: 13, lineHeight: 18, color: theme.colors.danger },
  note: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  confirmed: { fontSize: 13, lineHeight: 18, color: theme.colors.positive },
  previewCard: {
    borderRadius: 14,
    padding: 12,
    gap: 8,
    backgroundColor: theme.colors.surfaceElevated,
  },
  previewUrl: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  testButton: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  testText: { fontSize: 14, fontWeight: '600', color: theme.colors.accent },
  friendCard: {
    borderRadius: 14,
    padding: 12,
    gap: 4,
    backgroundColor: theme.colors.surfaceElevated,
  },
  friendTitle: { fontSize: 12, fontWeight: '700', color: theme.colors.textMuted },
  friendLine: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: theme.colors.textPrimary, fontVariant: ['tabular-nums'] },
  prefer: {
    minHeight: 40,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  preferOn: { borderColor: theme.colors.positive, backgroundColor: theme.colors.positiveSubtle },
  preferText: { fontSize: 14, fontWeight: '600', color: theme.colors.textSecondary },
  preferTextOn: { color: theme.colors.positive },
  errorBanner: {
    borderRadius: 14,
    padding: 12,
    gap: 8,
    backgroundColor: theme.colors.dangerSubtle,
  },
  retry: { fontSize: 14, fontWeight: '700', color: theme.colors.accent },
  save: {
    minHeight: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  savePressed: { backgroundColor: theme.colors.accentPressed },
  saveText: { fontSize: 15, fontWeight: '700', color: theme.colors.accentText },
  quiet: { minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  quietText: { fontSize: 14, fontWeight: '600', color: theme.colors.textSecondary },
  dangerText: { fontSize: 14, fontWeight: '600', color: theme.colors.danger },
  disabled: { opacity: 0.55 },
});
