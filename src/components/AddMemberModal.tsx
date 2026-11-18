import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { GroupServiceError, groupService, type GroupMemberProfile } from '@/services/GroupService';
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
    const message = `Hey! I added you to "${name}" to split our bills. Download the app and sign up with this number to join automatically.`;
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
        <BlurView intensity={50} tint="dark" style={StyleSheet.absoluteFill} />
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={dismiss} />

        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>Add Member</Text>
              <Text style={styles.subtitle}>Enter the phone number linked to their account.</Text>
            </View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close" onPress={dismiss} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close-circle" size={28} color="#64748B" />
            </TouchableOpacity>
          </View>

          <View style={[styles.phoneRow, (focused || countriesOpen) && styles.phoneRowFocused]}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Country code ${selected.name} ${selected.dialCode}`}
              accessibilityState={{ expanded: countriesOpen }}
              onPress={toggleCountries}
              style={styles.countryPill}
            >
              <Text style={styles.countryPillText}>
                {selected.flag} {selected.dialCode} ▾
              </Text>
            </TouchableOpacity>
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
              placeholderTextColor="#64748B"
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoComplete="tel"
              selectionColor="#38BDF8"
              style={styles.input}
            />
          </View>

          {countriesOpen ? (
            <ScrollView style={styles.countryMenu} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {SUPPORTED_COUNTRIES.map((option) => {
                const active = option.code === country;
                return (
                  <TouchableOpacity
                    key={option.code}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[styles.countryOption, active && styles.countryOptionActive]}
                    onPress={() => chooseCountry(option.code)}
                  >
                    <Text style={styles.countryOptionFlag}>{option.flag}</Text>
                    <Text style={[styles.countryOptionName, active && styles.countryOptionNameActive]}>{option.name}</Text>
                    <Text style={styles.countryOptionDial}>{option.dialCode}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          ) : null}

          {notFound ? (
            <Animated.View key="invite" entering={FadeIn.duration(180)} style={styles.inviteCallout}>
              <Text style={styles.inviteTitle}>{"They're not on the app yet"}</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Send Invite Link" onPress={() => void sendInvite()} style={styles.inviteButton}>
                <Ionicons name="share-outline" size={16} color="#7DD3FC" />
                <Text style={styles.inviteButtonText}>Send Invite Link</Text>
              </TouchableOpacity>
            </Animated.View>
          ) : null}

          {error ? (
            <Animated.View key={error} entering={FadeIn.duration(180)} style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </Animated.View>
          ) : null}

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Add to Group"
            disabled={!canSubmit}
            activeOpacity={0.9}
            onPress={() => {
              void handleSubmit();
            }}
            style={[styles.buttonWrap, !canSubmit && styles.buttonDisabled]}
          >
            <LinearGradient colors={['#7DD3FC', '#38BDF8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.button}>
              {isSubmitting ? <ActivityIndicator color="#030712" /> : <Text style={styles.buttonText}>Add to Group</Text>}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', padding: 16 },
  card: {
    backgroundColor: '#151F32',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.16)',
    padding: 24,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  headerCopy: { flex: 1 },
  title: { color: '#F8FAFC', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { marginTop: 6, color: '#94A3B8', fontSize: 15, lineHeight: 22 },
  phoneRow: {
    marginTop: 22,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0B1120',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.16)',
  },
  phoneRowFocused: { borderColor: '#38BDF8' },
  countryPill: { paddingLeft: 14, paddingRight: 10, paddingVertical: 16 },
  countryPillText: { color: '#F8FAFC', fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  dialDivider: { width: 1, alignSelf: 'stretch', marginVertical: 12, backgroundColor: 'rgba(148, 163, 184, 0.16)' },
  input: {
    flex: 1,
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    paddingHorizontal: 12,
    paddingVertical: 16,
  },
  countryMenu: {
    maxHeight: 176,
    marginTop: 8,
    backgroundColor: '#0B1120',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.16)',
  },
  countryOption: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  countryOptionActive: { backgroundColor: 'rgba(56, 189, 248, 0.12)' },
  countryOptionFlag: { fontSize: 16 },
  countryOptionName: { flex: 1, color: '#E2E8F0', fontSize: 15, fontWeight: '600' },
  countryOptionNameActive: { color: '#7DD3FC' },
  countryOptionDial: { color: '#94A3B8', fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  inviteCallout: {
    marginTop: 12,
    backgroundColor: 'rgba(56, 189, 248, 0.08)',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.2)',
    padding: 14,
    gap: 12,
  },
  inviteTitle: { color: '#E2E8F0', fontSize: 15, fontWeight: '700' },
  inviteButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.28)',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  inviteButtonText: { color: '#7DD3FC', fontSize: 14, fontWeight: '800' },
  errorBanner: {
    marginTop: 12,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  errorText: { color: '#F87171', fontSize: 14, fontWeight: '600' },
  buttonWrap: { marginTop: 22, borderRadius: 999 },
  buttonDisabled: { opacity: 0.45 },
  button: { minHeight: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#030712', fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
});
