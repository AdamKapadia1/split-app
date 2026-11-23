import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { AvatarBadge } from '@/components/AvatarBadge';
import { PayoutSetup } from '@/components/payout-setup';
import { purgeLocalAppData, supabase } from '@/lib/supabase';
import { payoutService, type PayoutMethod } from '@/services/PayoutService';
import { theme } from '@/theme/theme';
import { mapErrorToUserMessage } from '@/utils/errorMapper';
import { logger } from '@/utils/logger';
import { maskAccountNumber } from '@/utils/paymentLinks';

type InfoTopic = 'payments' | 'privacy';

const PAYMENTS_COPY = 'Midnight never holds your money and never starts a transfer. When you pay someone, the payment happens in your own banking app, directly between the two of you.';

const PRIVACY_COPY = 'Payout details you save are visible only to people who share a group or a split with you. Other people\'s bank details are not cached on this device. You can erase your login, profile, and saved payout details at any time. UK GDPR gives you that right to erasure.';

type AccountSettingsSheetProps = {
  visible: boolean;
  userId: string | null;
  displayName: string;
  subtitle: string;
  onClose: () => void;
  onLogout: () => void;
};

export function AccountSettingsSheet({
  visible,
  userId,
  displayName,
  subtitle,
  onClose,
  onLogout,
}: AccountSettingsSheetProps) {
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [payout, setPayout] = useState<PayoutMethod | null>(null);
  const [payoutLoading, setPayoutLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [info, setInfo] = useState<InfoTopic | null>(null);
  const watchKey = visible && userId ? userId : null;
  const [seenKey, setSeenKey] = useState<string | null>(null);
  if (seenKey !== watchKey) {
    setSeenKey(watchKey);
    setPayoutLoading(watchKey !== null);
    if (!watchKey) setPayout(null);
  }

  useEffect(() => {
    if (!watchKey) return;
    let cancelled = false;
    void payoutService.getMyPayoutMethod()
      .then((method) => {
        if (!cancelled) setPayout(method);
      })
      .catch(() => {
        if (!cancelled) setPayout(null);
      })
      .finally(() => {
        if (!cancelled) setPayoutLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [watchKey]);

  function close() {
    if (isDeleting) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPayoutOpen(false);
    setInfo(null);
    onClose();
  }

  function confirmLogout() {
    if (isDeleting) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert('Log out?', "You'll need to sign back in to view your groups and receipts.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: onLogout },
    ]);
  }

  function confirmDelete() {
    if (isDeleting) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      'Delete account?',
      'This permanently erases your login, profile, and saved payout details. Receipts you share stay available to the other people on them, without your bank details.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', style: 'destructive', onPress: confirmDeleteFinal },
      ],
    );
  }

  function confirmDeleteFinal() {
    Alert.alert('Permanently delete account?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Permanently Delete', style: 'destructive', onPress: () => { void runDelete(); } },
    ]);
  }

  async function runDelete() {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      if (!supabase) throw new Error('Supabase is not configured.');
      const { error } = await supabase.rpc('delete_my_account');
      if (error) throw error;
      await purgeLocalAppData();
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      setPayoutOpen(false);
      setInfo(null);
      onClose();
      router.replace('/sign-in');
    } catch (error) {
      logger.error('delete account', { code: 'DELETE_FAILED' });
      Alert.alert('Could not delete account', mapErrorToUserMessage(error));
      setIsDeleting(false);
    }
  }

  const payoutLabel = payoutStatus(payout);

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss account settings"
          onPress={close}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.card}>
          <View style={styles.header}>
            <AvatarBadge name={displayName} userId={userId ?? undefined} size={44} />
            <View style={styles.identity}>
              <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">{displayName}</Text>
              {subtitle ? <Text style={styles.subtitle} numberOfLines={1} ellipsizeMode="tail">{subtitle}</Text> : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close account settings"
              hitSlop={10}
              onPress={close}
              style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
            >
              <Ionicons name="close" size={15} color={theme.colors.textSecondary} />
            </Pressable>
          </View>

          <View style={styles.list}>
            {info ? (
              <View style={styles.info}>
                <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => setInfo(null)} style={({ pressed }) => [styles.infoBack, pressed && styles.rowPressed]}>
                  <Ionicons name="chevron-back" size={16} color={theme.colors.textSecondary} />
                  <Text style={styles.infoBackText}>Back</Text>
                </Pressable>
                <Text style={styles.infoTitle}>{info === 'payments' ? 'How payments work' : 'Privacy & data'}</Text>
                <Text style={styles.infoBody}>{info === 'payments' ? PAYMENTS_COPY : PRIVACY_COPY}</Text>
              </View>
            ) : (
              <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Payout details, ${payoutLoading ? 'loading' : payoutLabel}`}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setPayoutOpen(true);
              }}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowCopy}>
                <Text style={styles.rowLabel}>Payout details</Text>
                {payoutLoading ? (
                  <ActivityIndicator accessibilityLabel="Loading payout details" color={theme.colors.textMuted} size="small" style={styles.rowSpinner} />
                ) : (
                  <Text style={styles.rowStatus} numberOfLines={1}>{payoutLabel}</Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
            </Pressable>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Currency</Text>
              <Text style={styles.currencyValue}>GBP (£)</Text>
            </View>
            <View style={styles.divider} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="How payments work"
              disabled={isDeleting}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setInfo('payments');
              }}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Text style={styles.rowLabel}>How payments work</Text>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
            </Pressable>
            <View style={styles.divider} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Privacy and data"
              disabled={isDeleting}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setInfo('privacy');
              }}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Text style={styles.rowLabel}>Privacy & data</Text>
              <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
            </Pressable>
              </>
            )}
          </View>

          {info ? null : (
            <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log Out"
            disabled={isDeleting}
            onPress={confirmLogout}
            style={({ pressed }) => [styles.logout, (pressed || isDeleting) && styles.logoutPressed]}
          >
            <Ionicons name="log-out-outline" size={16} color={theme.colors.danger} />
            <Text style={styles.logoutText}>Log Out</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete Account"
            accessibilityState={{ disabled: isDeleting, busy: isDeleting }}
            disabled={isDeleting}
            onPress={confirmDelete}
            style={({ pressed }) => [styles.deleteAccount, pressed && styles.logoutPressed]}
          >
            {isDeleting ? (
              <ActivityIndicator color={theme.colors.danger} size="small" />
            ) : (
              <Text style={styles.deleteAccountText}>Delete Account</Text>
            )}
          </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
      <PayoutSetup
        visible={payoutOpen}
        userId={userId}
        onClose={() => setPayoutOpen(false)}
        onSaved={(method) => setPayout(method)}
      />
    </Modal>
  );
}

function payoutStatus(method: PayoutMethod | null) {
  if (method?.preferredMethod === 'monzo' && method.monzoHandle) return `Monzo · @${method.monzoHandle}`;
  if (method?.preferredMethod === 'revolut' && method.revolutHandle) return `Revolut · @${method.revolutHandle}`;
  if (method?.preferredMethod === 'paypal' && method.paypalHandle) return `PayPal · @${method.paypalHandle}`;
  if (method?.preferredMethod === 'bank' && method.bankAccountNumber && /^[0-9]{8}$/.test(method.bankAccountNumber)) {
    return `UK Bank · ${maskAccountNumber(method.bankAccountNumber)}`;
  }
  return 'Not set up yet';
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: theme.colors.scrim,
    justifyContent: 'center',
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    padding: 20,
    marginHorizontal: 16,
  },
  header: { flexDirection: 'row', alignItems: 'center' },
  identity: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 12 },
  name: { fontSize: 17, lineHeight: 22, fontWeight: '700', color: theme.colors.textPrimary },
  subtitle: { marginTop: 2, fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  close: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
  },
  closePressed: { backgroundColor: theme.colors.surfacePressed },
  list: {
    marginTop: 20,
    backgroundColor: theme.colors.surfaceElevated,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  row: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowPressed: { backgroundColor: theme.colors.surfacePressed },
  rowCopy: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { fontSize: 15, lineHeight: 20, color: theme.colors.textPrimary },
  rowStatus: { fontSize: 13, lineHeight: 18, color: theme.colors.textMuted },
  rowSpinner: { alignSelf: 'flex-start', marginTop: 4 },
  rowTrail: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, minWidth: 0 },
  rowValue: { flexShrink: 1, fontSize: 14, lineHeight: 18, color: theme.colors.textMuted },
  currencyValue: { fontSize: 14, lineHeight: 18, color: theme.colors.textMuted },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 14, backgroundColor: theme.colors.border },
  editor: { marginTop: 20, gap: 12 },
  editorLabel: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  input: {
    height: 48,
    borderRadius: 14,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    fontSize: 15,
    color: theme.colors.textPrimary,
  },
  saveButton: {
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  savePressed: { backgroundColor: theme.colors.accentPressed },
  saveText: { fontSize: 15, fontWeight: '700', color: theme.colors.accentText },
  cancelButton: { height: 36, alignItems: 'center', justifyContent: 'center' },
  cancelText: { fontSize: 14, fontWeight: '600', color: theme.colors.textSecondary },
  logout: {
    marginTop: 20,
    height: 48,
    borderRadius: 14,
    backgroundColor: theme.colors.dangerSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.dangerMutedBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  logoutPressed: { opacity: 0.75 },
  logoutText: { fontSize: 15, fontWeight: '600', color: theme.colors.danger },
  deleteAccount: {
    marginTop: 8,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteAccountText: { fontSize: 15, fontWeight: '600', color: theme.colors.danger },
  info: { paddingHorizontal: 14, paddingVertical: 14, gap: 8 },
  infoBack: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start' },
  infoBackText: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: theme.colors.textSecondary },
  infoTitle: { marginTop: 6, fontSize: 17, lineHeight: 22, fontWeight: '700', color: theme.colors.textPrimary },
  infoBody: { fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary },
});
