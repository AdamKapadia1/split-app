import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { VelorBrand } from '@/components/VelorBrand';
import { APP_NAME } from '@/constants/brand';
import { luxury } from '@/constants/theme';
import {
  authenticateWithBiometrics,
  clearBiometricSession,
  getBiometricPreference,
  hasBiometricSession,
  isBiometricAvailable,
  readBiometricSession,
  saveBiometricSession,
  setBiometricPreference,
  type BiometricLabel,
} from '@/lib/biometricAuth';
import { mediumHaptic, pulseHaptic, tickHaptic } from '@/lib/haptics';
import { supabase } from '@/lib/supabase';

type Mode = 'sign-in' | 'create';
type Field = 'email' | 'password' | null;

export function AuthScreen() {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focused, setFocused] = useState<Field>(null);
  const [biometricLabel, setBiometricLabel] = useState<BiometricLabel | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hardware = await isBiometricAvailable();
      if (!hardware.available || cancelled) return;
      const ready = await hasBiometricSession();
      if (!cancelled && ready) setBiometricLabel(hardware.label);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function choose(next: Mode) {
    if (next === mode || busy) {
      return;
    }

    tickHaptic();
    setMode(next);
    setError(null);
    setNotice(null);
  }

  async function submit() {
    mediumHaptic();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Enter your email and password.');
      setNotice(null);
      return;
    }

    if (!supabase) {
      setError('Add your Supabase URL and anon key, then restart Expo.');
      setNotice(null);
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      if (mode === 'sign-in') {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });
        if (signInError) {
          setError(signInError.message);
          return;
        }
        const refreshToken = data.session?.refresh_token;
        const signedInEmail = data.session?.user.email ?? trimmedEmail;
        if (refreshToken) void rememberBiometricSession(refreshToken, signedInEmail);
        return;
      }

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
      });
      if (signUpError) {
        setError(signUpError.message);
        return;
      }
      if (!data.session) {
        setNotice('Check your email to confirm your account.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function signInWithBiometric() {
    if (!supabase || busy) return;
    pulseHaptic();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const unlocked = await authenticateWithBiometrics();
      if (!unlocked) return;
      const stored = await readBiometricSession();
      if (!stored) {
        setBiometricLabel(null);
        setNotice('Session expired. Please sign in with your password once to re-enable Face ID.');
        return;
      }
      const { data, error: refreshError } = await supabase.auth.refreshSession({ refresh_token: stored.refreshToken });
      const nextToken = data.session?.refresh_token;
      if (refreshError || !nextToken) {
        await clearBiometricSession();
        setBiometricLabel(null);
        setNotice('Session expired. Please sign in with your password once to re-enable Face ID.');
        return;
      }
      await saveBiometricSession(nextToken, data.session?.user.email ?? stored.email);
    } catch {
      setNotice('Session expired. Please sign in with your password once to re-enable Face ID.');
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'sign-in' ? 'Welcome back' : 'Create your account';
  const subtitle = mode === 'sign-in'
    ? 'Sign in to host a split, or join one you were sent.'
    : 'Open an account to itemise a bill and settle it.';
  const action = mode === 'sign-in' ? 'Sign In' : 'Create Account';

  return (
    <View style={styles.canvas}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(139,149,255,0.14)', 'rgba(139,149,255,0.05)', 'rgba(5,6,9,0)']}
        locations={[0, 0.42, 1]}
        style={styles.glow}
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.scroll,
            { paddingTop: insets.top + 28, paddingBottom: Math.max(insets.bottom, 16) + 56 },
          ]}
        >
          <BrandEntrance>
            <VelorBrand variant="hero" />
          </BrandEntrance>

          <View style={styles.card}>
            <View style={styles.cardRim} />
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.subtitle}>{subtitle}</Text>

            <View style={styles.toggle}>
              <Toggle label="Sign In" selected={mode === 'sign-in'} onPress={() => choose('sign-in')} />
              <Toggle label="Create Account" selected={mode === 'create'} onPress={() => choose('create')} />
            </View>

            <TextInput
              accessibilityLabel="Email"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="Email"
              placeholderTextColor={luxury.textMuted}
              selectionColor={luxury.accentPrimary}
              textContentType="emailAddress"
              value={email}
              onChangeText={setEmail}
              onFocus={() => setFocused('email')}
              onBlur={() => setFocused((current) => (current === 'email' ? null : current))}
              style={[styles.input, focused === 'email' && styles.inputFocused]}
            />
            <TextInput
              accessibilityLabel="Password"
              autoCapitalize="none"
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              autoCorrect={false}
              placeholder="Password"
              placeholderTextColor={luxury.textMuted}
              selectionColor={luxury.accentPrimary}
              secureTextEntry
              textContentType={mode === 'sign-in' ? 'password' : 'newPassword'}
              value={password}
              onChangeText={setPassword}
              onFocus={() => setFocused('password')}
              onBlur={() => setFocused((current) => (current === 'password' ? null : current))}
              style={[styles.input, focused === 'password' && styles.inputFocused]}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={action}
              accessibilityState={{ disabled: busy, busy }}
              disabled={busy}
              onPressIn={() => {
                if (!busy) pulseHaptic();
              }}
              onPress={() => {
                void submit();
              }}
              style={({ pressed }) => [styles.ctaShadow, pressed && !busy && styles.ctaPressed, busy && styles.ctaBusy]}
            >
              <LinearGradient
                colors={['#9AA3FF', '#7C86FF']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.cta}
              >
                {busy ? <ActivityIndicator color="#050609" /> : <Text style={styles.ctaLabel}>{action}</Text>}
              </LinearGradient>
            </Pressable>
            {mode === 'sign-in' && biometricLabel ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Sign in with ${biometricLabel}`}
                accessibilityState={{ disabled: busy, busy }}
                disabled={busy}
                onPress={() => {
                  void signInWithBiometric();
                }}
                style={({ pressed }) => [styles.bioButton, pressed && !busy && styles.ctaPressed, busy && styles.ctaBusy]}
              >
                <Ionicons name={biometricLabel === 'Touch ID' ? 'finger-print' : 'scan-outline'} size={18} color="#F7F8FA" />
                <Text style={styles.bioLabel}>{`Sign in with ${biometricLabel}`}</Text>
              </Pressable>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <View pointerEvents="none" style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Ionicons name="lock-closed" size={11} color={luxury.textMuted} />
        <Text style={styles.footerText}>{`Encrypted UK settlements · Powered by ${APP_NAME}`}</Text>
      </View>
    </View>
  );
}

async function rememberBiometricSession(refreshToken: string, email: string) {
  const hardware = await isBiometricAvailable();
  if (!hardware.available) return;
  const preference = await getBiometricPreference();
  if (preference === 'off') return;
  if (preference === 'on') {
    await saveBiometricSession(refreshToken, email);
    return;
  }
  Alert.alert(
    `Sign in with ${hardware.label}?`,
    `${APP_NAME} can unlock on this device with ${hardware.label}. You can turn this off in account settings.`,
    [
      { text: 'Not now', style: 'cancel', onPress: () => { void setBiometricPreference('off'); } },
      { text: 'Enable', onPress: () => { void saveBiometricSession(refreshToken, email); } },
    ],
  );
}

function BrandEntrance({ children }: { children: ReactNode }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(1, { duration: 450, easing: Easing.out(Easing.cubic) });
  }, [progress]);

  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 10 }],
  }));

  return <Animated.View style={style}>{children}</Animated.View>;
}

function Toggle({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.toggleItem, selected && styles.toggleItemSelected]}
    >
      <Text style={[styles.toggleLabel, selected && styles.toggleLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  canvas: {
    flex: 1,
    backgroundColor: luxury.bgCanvas,
  },
  fill: { flex: 1 },
  glow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '46%',
  },
  scroll: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    paddingHorizontal: 20,
  },
  card: {
    marginTop: 36,
    backgroundColor: luxury.bgElevated,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    padding: 20,
    overflow: 'hidden',
    gap: 12,
  },
  cardRim: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  title: {
    marginTop: 4,
    color: luxury.textPrimary,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  subtitle: {
    marginTop: -4,
    color: luxury.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  toggle: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 4,
    padding: 4,
    borderRadius: 16,
    backgroundColor: '#06070B',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  toggleItem: {
    flex: 1,
    minHeight: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  toggleItemSelected: {
    backgroundColor: '#181C2B',
    borderColor: 'rgba(255,255,255,0.08)',
    borderTopColor: 'rgba(255,255,255,0.16)',
  },
  toggleLabel: {
    color: luxury.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  toggleLabelSelected: {
    color: luxury.textPrimary,
  },
  input: {
    height: 52,
    borderRadius: 14,
    paddingHorizontal: 16,
    backgroundColor: '#07080D',
    borderWidth: 1,
    borderColor: luxury.borderSubtle,
    color: luxury.textPrimary,
    fontSize: 16,
  },
  inputFocused: {
    borderColor: luxury.borderFocus,
  },
  error: {
    color: '#F87171',
    fontSize: 14,
    lineHeight: 20,
  },
  notice: {
    color: luxury.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  ctaShadow: {
    marginTop: 4,
    borderRadius: 16,
    shadowColor: '#8B95FF',
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  ctaPressed: {
    transform: [{ scale: 0.98 }],
  },
  ctaBusy: { opacity: 0.72 },
  cta: {
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaLabel: {
    color: '#050609',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  bioButton: {
    height: 50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(139,149,255,0.35)',
    backgroundColor: '#141724',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  bioLabel: {
    color: '#F7F8FA',
    fontSize: 15,
    fontWeight: '600',
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingTop: 10,
  },
  footerText: {
    fontSize: 11,
    lineHeight: 14,
    color: luxury.textMuted,
  },
});
