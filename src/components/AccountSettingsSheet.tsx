import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AvatarBadge } from '@/components/AvatarBadge';
import { groupService } from '@/services/GroupService';
import { theme } from '@/theme/theme';

type AccountSettingsSheetProps = {
  visible: boolean;
  userId: string | null;
  displayName: string;
  subtitle: string;
  paymentLink: string | null;
  onClose: () => void;
  onPaymentLinkChange: (paymentLink: string | null) => void;
  onLogout: () => void;
};

export function AccountSettingsSheet({
  visible,
  userId,
  displayName,
  subtitle,
  paymentLink,
  onClose,
  onPaymentLinkChange,
  onLogout,
}: AccountSettingsSheetProps) {
  const [editingLink, setEditingLink] = useState(false);
  const [draft, setDraft] = useState(paymentLink ?? '');
  const [saving, setSaving] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const nextKey = visible ? paymentLink ?? '' : null;
  if (openKey !== nextKey) {
    setOpenKey(nextKey);
    setEditingLink(false);
    setDraft(paymentLink ?? '');
    setSaving(false);
  }

  function close() {
    if (saving) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }

  function openEditor() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDraft(paymentLink ?? '');
    setEditingLink(true);
  }

  async function saveLink() {
    if (!userId || saving) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSaving(true);
    try {
      const next = draft.trim() || null;
      await groupService.updatePaymentLink(userId, next);
      onPaymentLinkChange(next);
      setEditingLink(false);
    } catch (error) {
      console.error('Error saving payout link:', error);
      Alert.alert('Could not save', 'Your payout link was not updated.');
    } finally {
      setSaving(false);
    }
  }

  function confirmLogout() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert('Log out?', "You'll need to sign back in to view your groups and receipts.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: onLogout },
    ]);
  }

  const linkLabel = paymentLink?.trim() ? paymentLink.trim() : 'Not set';

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss account settings"
          disabled={saving}
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
              disabled={saving}
              hitSlop={10}
              onPress={close}
              style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
            >
              <Ionicons name="close" size={15} color={theme.colors.textSecondary} />
            </Pressable>
          </View>

          {editingLink ? (
            <View style={styles.editor}>
              <Text style={styles.editorLabel}>Payout link</Text>
              <TextInput
                accessibilityLabel="Payout link"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://monzo.me/yourname"
                placeholderTextColor={theme.colors.textMuted}
                selectionColor={theme.colors.accent}
                value={draft}
                onChangeText={setDraft}
                style={styles.input}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Save payout link"
                disabled={saving || !userId}
                onPress={() => {
                  void saveLink();
                }}
                style={({ pressed }) => [styles.saveButton, pressed && !saving && styles.savePressed]}
              >
                {saving ? <ActivityIndicator color={theme.colors.accentText} /> : <Text style={styles.saveText}>Save link</Text>}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel payout link edit"
                disabled={saving}
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setEditingLink(false);
                }}
                style={styles.cancelButton}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.list}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Payout link"
                onPress={openEditor}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <Text style={styles.rowLabel}>Payout Link</Text>
                <View style={styles.rowTrail}>
                  <Text style={styles.rowValue} numberOfLines={1} ellipsizeMode="tail">{linkLabel}</Text>
                  <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
                </View>
              </Pressable>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Currency</Text>
                <Text style={styles.currencyValue}>GBP (£)</Text>
              </View>
            </View>
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log Out"
            disabled={saving}
            onPress={confirmLogout}
            style={({ pressed }) => [styles.logout, pressed && styles.logoutPressed]}
          >
            <Ionicons name="log-out-outline" size={16} color={theme.colors.danger} />
            <Text style={styles.logoutText}>Log Out</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
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
  rowLabel: { fontSize: 15, lineHeight: 20, color: theme.colors.textPrimary },
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
});
