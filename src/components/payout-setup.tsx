import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { PayoutServiceError, payoutService, type PayoutMethodKind } from '@/services/PayoutService';
import { theme } from '@/theme/theme';
import {
  normalizeAccountNumber,
  normalizeSortCode,
  sanitizePaymentHandle,
} from '@/utils/paymentLinks';

type PayoutSetupProps = {
  visible: boolean;
  userId: string | null;
  onClose: () => void;
};

const METHODS: { id: PayoutMethodKind; label: string }[] = [
  { id: 'monzo', label: 'Monzo' },
  { id: 'revolut', label: 'Revolut' },
  { id: 'paypal', label: 'PayPal' },
  { id: 'bank', label: 'Bank' },
];

export function PayoutSetup({ visible, userId, onClose }: PayoutSetupProps) {
  const [preferred, setPreferred] = useState<PayoutMethodKind | null>(null);
  const [monzo, setMonzo] = useState('');
  const [revolut, setRevolut] = useState('');
  const [paypal, setPaypal] = useState('');
  const [accountName, setAccountName] = useState('');
  const [sortCode, setSortCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const openKey = visible && userId ? userId : null;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (loadedKey !== openKey) {
    setLoadedKey(openKey);
    setLoading(openKey !== null);
    setPreferred(null);
    setMonzo('');
    setRevolut('');
    setPaypal('');
    setAccountName('');
    setSortCode('');
    setAccountNumber('');
    setSaving(false);
    setMessage(null);
  }

  useEffect(() => {
    if (!openKey) return;
    let cancelled = false;
    void payoutService.getMyPayoutMethod()
      .then((method) => {
        if (cancelled || !method) return;
        setPreferred(method.preferredMethod);
        setMonzo(method.monzoHandle ?? '');
        setRevolut(method.revolutHandle ?? '');
        setPaypal(method.paypalHandle ?? '');
        setAccountName(method.bankAccountName ?? '');
        setSortCode(method.bankSortCode ? formatTypingSortCode(method.bankSortCode) : '');
        setAccountNumber(method.bankAccountNumber ?? '');
      })
      .catch(() => {
        if (!cancelled) setMessage('Could not load your payout details.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [openKey]);

  function clearDraft() {
    setPreferred(null);
    setMonzo('');
    setRevolut('');
    setPaypal('');
    setAccountName('');
    setSortCode('');
    setAccountNumber('');
    setSaving(false);
    setMessage(null);
  }

  const monzoHandle = sanitizePaymentHandle('monzo', monzo);
  const revolutHandle = sanitizePaymentHandle('revolut', revolut);
  const paypalHandle = sanitizePaymentHandle('paypal', paypal);
  const sortDigits = normalizeSortCode(sortCode);
  const accountDigits = normalizeAccountNumber(accountNumber);
  const name = accountName.trim();
  const bankReady = name.length >= 2 && name.length <= 70 && sortDigits !== null && accountDigits !== null;
  const bankStarted = name.length > 0 || sortCode.trim().length > 0 || accountNumber.trim().length > 0;
  const handlesInvalid = (monzo.trim().length > 0 && !monzoHandle)
    || (revolut.trim().length > 0 && !revolutHandle)
    || (paypal.trim().length > 0 && !paypalHandle);
  const saveBlocked = saving || loading || !userId || handlesInvalid || (bankStarted && !bankReady);

  function close() {
    if (saving) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }

  async function save() {
    if (!userId || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const nextPreferred = preferred
        ?? (monzoHandle ? 'monzo' : revolutHandle ? 'revolut' : paypalHandle ? 'paypal' : bankReady ? 'bank' : null);
      if (!monzoHandle && !revolutHandle && !paypalHandle && !bankReady) {
        await payoutService.deleteMyPayoutMethod();
      } else {
        await payoutService.upsertMyPayoutMethod({
          preferredMethod: nextPreferred,
          monzoHandle: monzo,
          revolutHandle: revolut,
          paypalHandle: paypal,
          bankAccountName: bankReady ? name : null,
          bankSortCode: bankReady ? sortDigits : null,
          bankAccountNumber: bankReady ? accountDigits : null,
        });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch (error) {
      const text = error instanceof PayoutServiceError ? error.message : 'Could not save payout details.';
      setMessage(text);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSaving(false);
    }
  }

  async function removeBankDetails() {
    if (saving) return;
    setAccountName('');
    setSortCode('');
    setAccountNumber('');
    if (preferred === 'bank') setPreferred(monzoHandle ? 'monzo' : revolutHandle ? 'revolut' : paypalHandle ? 'paypal' : null);
    setMessage('Bank details cleared. Save to update what other members can see.');
    void Haptics.selectionAsync();
  }

  async function clearAll() {
    if (!userId || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await payoutService.deleteMyPayoutMethod();
      clearDraft();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch (error) {
      const text = error instanceof PayoutServiceError ? error.message : 'Could not remove payout details.';
      setMessage(text);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss payout details" disabled={saving} onPress={close} style={StyleSheet.absoluteFill} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Payout details</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close payout details" disabled={saving} hitSlop={10} onPress={close} style={styles.close}>
              <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
            {loading ? <ActivityIndicator color={theme.colors.accent} /> : null}
            <Text style={styles.privacy}>Your payout details are only visible to people you share a group or split with.</Text>
            <Text style={styles.label}>Preferred method</Text>
            <View style={styles.chips}>
              {METHODS.map((method) => {
                const selected = preferred === method.id;
                return (
                  <Pressable
                    key={method.id}
                    accessibilityRole="button"
                    accessibilityLabel={method.label}
                    accessibilityState={{ selected }}
                    onPress={() => setPreferred(method.id)}
                    style={[styles.chip, selected ? styles.chipOn : styles.chipOff]}
                  >
                    <Text style={[styles.chipText, selected ? styles.chipTextOn : styles.chipTextOff]}>{method.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <HandleField
              label="Monzo.me"
              value={monzo}
              placeholder="yourname"
              error={monzo.trim().length > 0 && !monzoHandle ? 'Use 2–64 letters, numbers, dots, underscores, or hyphens.' : null}
              preview={monzoHandle ? `https://monzo.me/${monzoHandle}` : null}
              onChangeText={setMonzo}
            />
            <HandleField
              label="Revolut.me"
              value={revolut}
              placeholder="yourname"
              error={revolut.trim().length > 0 && !revolutHandle ? 'Use 2–64 letters, numbers, dots, underscores, or hyphens.' : null}
              preview={revolutHandle ? `https://revolut.me/${revolutHandle}` : null}
              onChangeText={setRevolut}
            />
            <HandleField
              label="PayPal.me"
              value={paypal}
              placeholder="yourname"
              error={paypal.trim().length > 0 && !paypalHandle ? 'PayPal handles are letters and numbers only.' : null}
              preview={paypalHandle ? `https://paypal.me/${paypalHandle}` : null}
              onChangeText={setPaypal}
            />

            <Text style={styles.label}>UK bank details</Text>
            <TextInput accessibilityLabel="Account name" autoCorrect={false} placeholder="Account name" placeholderTextColor={theme.colors.textMuted} value={accountName} onChangeText={setAccountName} style={styles.input} />
            {accountName.trim().length > 0 && (name.length < 2 || name.length > 70) ? <Text style={styles.error}>Account name must be 2 to 70 characters.</Text> : null}
            <TextInput
              accessibilityLabel="Sort code"
              keyboardType="number-pad"
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
              placeholder="Account number"
              placeholderTextColor={theme.colors.textMuted}
              value={accountNumber}
              onChangeText={(value) => setAccountNumber(value.replace(/\D/g, '').slice(0, 8))}
              style={styles.input}
            />
            {accountNumber.length > 0 && !accountDigits ? <Text style={styles.error}>Enter an 8-digit account number.</Text> : null}
            {bankStarted && !bankReady ? <Text style={styles.error}>Name, sort code, and account number must be saved together.</Text> : null}

            {message ? <Text style={styles.message}>{message}</Text> : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save payout details"
              disabled={saveBlocked}
              onPress={() => { void save(); }}
              style={({ pressed }) => [styles.save, pressed && !saving && styles.savePressed, saveBlocked && styles.disabled]}
            >
              {saving ? <ActivityIndicator color={theme.colors.accentText} /> : <Text style={styles.saveText}>Save</Text>}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Remove bank details" disabled={saving} onPress={() => { void removeBankDetails(); }} style={styles.quiet}>
              <Text style={styles.quietText}>Remove Bank Details</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Clear payout details" disabled={saving} onPress={() => { void clearAll(); }} style={styles.quiet}>
              <Text style={styles.dangerText}>Clear</Text>
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function HandleField({
  label,
  value,
  placeholder,
  error,
  preview,
  onChangeText,
}: {
  label: string;
  value: string;
  placeholder: string;
  error: string | null;
  preview: string | null;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textMuted}
        value={value}
        onChangeText={onChangeText}
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {preview ? <Text style={styles.preview}>{preview}</Text> : null}
    </View>
  );
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
    paddingBottom: 24,
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
  body: { paddingHorizontal: 20, paddingTop: 16, gap: 10 },
  privacy: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  label: { marginTop: 6, fontSize: 12, lineHeight: 16, fontWeight: '600', color: theme.colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { height: 34, paddingHorizontal: 12, borderRadius: theme.radius.full, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: theme.colors.accentSubtle, borderWidth: 1, borderColor: theme.colors.accentBorder },
  chipOff: { backgroundColor: theme.colors.surfaceElevated, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border },
  chipText: { fontSize: 13 },
  chipTextOn: { fontWeight: '600', color: theme.colors.accent },
  chipTextOff: { fontWeight: '500', color: theme.colors.textSecondary },
  field: { gap: 6 },
  input: {
    minHeight: 46,
    borderRadius: 14,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    color: theme.colors.textPrimary,
    fontSize: 15,
  },
  error: { fontSize: 12, lineHeight: 16, color: theme.colors.danger },
  preview: { fontSize: 12, lineHeight: 16, color: theme.colors.textSecondary },
  message: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  save: {
    marginTop: 8,
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
