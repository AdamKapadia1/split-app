import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { APP_NAME } from '@/constants/brand';
import { GroupServiceError, groupService, type GroupMemberProfile } from '@/services/GroupService';
import { theme } from '@/theme/theme';
import { formatPhoneAsYouType, SUPPORTED_COUNTRIES, toE164 } from '@/utils/phone';

type AddMemberModalProps = {
  visible: boolean;
  groupId: string;
  groupName: string;
  onMemberAdded: (member: GroupMemberProfile) => void;
  onClose: () => void;
};

const ERROR_COPY: Partial<Record<GroupServiceError['code'], string>> = {
  INVALID_PHONE: 'Enter a valid phone number.',
  ALREADY_MEMBER: 'Already in this group.',
  PERMISSION_DENIED: 'You do not have permission to add members.',
  NETWORK_ERROR: 'Could not add this member. Try again.',
};

export function AddMemberModal({ visible, groupId, groupName, onMemberAdded, onClose }: AddMemberModalProps) {
  const [country, setCountry] = useState<CountryCode>('GB');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [invitePhone, setInvitePhone] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [focused, setFocused] = useState(false);
  const [countriesOpen, setCountriesOpen] = useState(false);
  const submittingRef = useRef(false);
  const selected = SUPPORTED_COUNTRIES.find((option) => option.code === country) ?? SUPPORTED_COUNTRIES[0];
  const canSubmit = phone.replace(/\D/g, '').length > 0 && !isSubmitting;

  useEffect(() => {
    if (!visible) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [visible]);

  function reset() {
    setCountry('GB');
    setPhone('');
    setError(null);
    setNotFound(false);
    setInvitePhone(null);
    setFocused(false);
    setCountriesOpen(false);
  }

  function dismiss() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    reset();
    onClose();
  }

  function toggleCountries() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCountriesOpen((open) => !open);
  }

  function chooseCountry(next: CountryCode) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCountry(next);
    setCountriesOpen(false);
    setPhone((current) => formatPhoneAsYouType(current, next));
  }

  function onChangePhone(value: string) {
    if (error) setError(null);
    if (notFound) setNotFound(false);
    if (invitePhone) setInvitePhone(null);

    const trimmed = value.trim();
    if (trimmed.startsWith('+')) {
      const parsed = parsePhoneNumberFromString(trimmed);
      if (parsed && (parsed.isValid() || parsed.isPossible())) {
        const exact = parsed.country ? SUPPORTED_COUNTRIES.find((option) => option.code === parsed.country) : undefined;
        const byDial = SUPPORTED_COUNTRIES.find((option) => option.dialCode === `+${parsed.countryCallingCode}`);
        const match = exact ?? byDial;
        if (match) {
          setCountry(match.code);
          setPhone(parsed.formatNational());
          return;
        }
      }
    }

    setPhone(formatPhoneAsYouType(value, country));
  }

  async function handleSubmit() {
    if (submittingRef.current || phone.replace(/\D/g, '').length === 0) return;

    submittingRef.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsSubmitting(true);
    setError(null);
    setNotFound(false);
    setCountriesOpen(false);

    try {
      const member = await groupService.addMemberByPhone(groupId, phone, country);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onMemberAdded(member);
      reset();
      onClose();
    } catch (caught) {
      const code = caught instanceof GroupServiceError ? caught.code : 'NETWORK_ERROR';
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      if (code === 'NOT_FOUND') {
        setInvitePhone(toE164(phone, country));
        setNotFound(true);
        return;
      }
      setError(ERROR_COPY[code] ?? ERROR_COPY.NETWORK_ERROR ?? 'Could not add this member. Try again.');
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  async function sendInvite() {
    if (submittingRef.current) return;

    submittingRef.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const name = groupName.trim() || 'my group';
    const message = `You're invited to "${name}" on ${APP_NAME}. Sign up with this number to join.`;
    const e164Phone = invitePhone ?? toE164(phone, country);

    try {
      if (e164Phone) {
        try {
          await groupService.createPendingInvite(groupId, e164Phone);
        } catch {
          // The text should still open if the invite cannot be saved.
        }
      }

      const separator = Platform.OS === 'ios' ? '&' : '?';
      const smsUrl = e164Phone ? `sms:${e164Phone}${separator}body=${encodeURIComponent(message)}` : null;
      let composerOpened = false;
      if (smsUrl) {
        try {
          if (await Linking.canOpenURL(smsUrl)) {
            await Linking.openURL(smsUrl);
            composerOpened = true;
          }
        } catch {
          composerOpened = false;
        }
      }

      if (!composerOpened) {
        await Share.share({ message });
      }

      reset();
      onClose();
    } catch {
      setNotFound(false);
      setError('Could not open the share sheet.');
    } finally {
      submittingRef.current = false;
    }
  }

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent onRequestClose={dismiss}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" style={StyleSheet.absoluteFill} onPress={dismiss} />

        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Add Member</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={10}
              onPress={dismiss}
              style={({ pressed }) => [styles.closeButton, pressed && styles.closePressed]}
            >
              <Ionicons name="close" size={15} color={theme.colors.textSecondary} />
            </Pressable>
          </View>
          <Text style={styles.subtitle}>Enter the phone number linked to their account.</Text>

          <View style={[styles.phoneRow, (focused || countriesOpen) && styles.phoneRowFocused]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Country code ${selected.name} ${selected.dialCode}`}
              accessibilityState={{ expanded: countriesOpen }}
              onPress={toggleCountries}
              style={styles.countryPill}
            >
              <Text style={styles.countryPillText}>
                {selected.flag} {selected.dialCode} ▾
              </Text>
            </Pressable>
            <View style={styles.dialDivider} />
            <TextInput
              value={phone}
              onChangeText={onChangePhone}
              onFocus={() => {
                setFocused(true);
                setCountriesOpen(false);
              }}
              onBlur={() => setFocused(false)}
              placeholder="7700 900123"
              placeholderTextColor={theme.colors.textMuted}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoComplete="tel"
              selectionColor={theme.colors.accent}
              style={styles.input}
            />
          </View>

          {countriesOpen ? (
            <ScrollView style={styles.countryMenu} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {SUPPORTED_COUNTRIES.map((option) => {
                const active = option.code === country;
                return (
                  <Pressable
                    key={option.code}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[styles.countryOption, active && styles.countryOptionActive]}
                    onPress={() => chooseCountry(option.code)}
                  >
                    <Text style={styles.countryOptionFlag}>{option.flag}</Text>
                    <Text style={[styles.countryOptionName, active && styles.countryOptionNameActive]}>{option.name}</Text>
                    <Text style={styles.countryOptionDial}>{option.dialCode}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}

          {notFound ? (
            <Animated.View key="invite" entering={FadeIn.duration(180)} style={styles.inviteCallout}>
              <Text style={styles.inviteTitle}>{"They're not on the app yet"}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Send Invite Link" onPress={() => void sendInvite()} style={styles.inviteButton}>
                <Ionicons name="share-outline" size={16} color={theme.colors.accent} />
                <Text style={styles.inviteButtonText}>Send Invite Link</Text>
              </Pressable>
            </Animated.View>
          ) : null}

          {error ? (
            <Animated.View key={error} entering={FadeIn.duration(180)} style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </Animated.View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add to Group"
            disabled={!canSubmit}
            onPress={() => {
              void handleSubmit();
            }}
            style={({ pressed }) => [
              styles.button,
              !canSubmit && !isSubmitting && styles.buttonDisabled,
              canSubmit && pressed && styles.buttonPressed,
            ]}
          >
            {isSubmitting ? (
              <ActivityIndicator color={theme.colors.accentText} />
            ) : (
              <Text style={[styles.buttonText, !canSubmit && styles.buttonTextDisabled]}>Add to Group</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    backgroundColor: theme.colors.scrim,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    padding: 20,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { fontSize: 20, fontWeight: '700', letterSpacing: -0.4, color: theme.colors.textPrimary },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
  },
  closePressed: { backgroundColor: theme.colors.surfacePressed },
  subtitle: { fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary, marginBottom: 20 },
  phoneRow: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    backgroundColor: theme.colors.canvas,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  phoneRowFocused: { borderColor: theme.colors.accentBorder },
  countryPill: { paddingRight: 2 },
  countryPillText: { color: theme.colors.textPrimary, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  dialDivider: {
    width: StyleSheet.hairlineWidth,
    height: 22,
    marginHorizontal: 12,
    backgroundColor: theme.colors.borderStrong,
  },
  input: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    paddingVertical: 0,
  },
  countryMenu: {
    maxHeight: 176,
    marginTop: 8,
    backgroundColor: theme.colors.canvas,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  countryOption: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  countryOptionActive: { backgroundColor: theme.colors.accentSubtle },
  countryOptionFlag: { fontSize: 16 },
  countryOptionName: { flex: 1, color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' },
  countryOptionNameActive: { color: theme.colors.accent },
  countryOptionDial: { color: theme.colors.textSecondary, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  inviteCallout: {
    marginTop: 12,
    backgroundColor: theme.colors.accentSubtle,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.accentBorder,
    padding: 14,
    gap: 12,
  },
  inviteTitle: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' },
  inviteButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.accentBorder,
    backgroundColor: theme.colors.surfaceElevated,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  inviteButtonText: { color: theme.colors.accent, fontSize: 14, fontWeight: '600' },
  errorBanner: {
    marginTop: 12,
    backgroundColor: theme.colors.dangerBorder,
    borderRadius: theme.radius.full,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  errorText: { color: theme.colors.danger, fontSize: 14, fontWeight: '600' },
  button: {
    height: 52,
    borderRadius: theme.radius.md,
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  buttonPressed: { backgroundColor: theme.colors.accentPressed },
  buttonDisabled: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  buttonText: { color: theme.colors.accentText, fontSize: 16, fontWeight: '700' },
  buttonTextDisabled: { color: theme.colors.textMuted, fontWeight: '600' },
});
