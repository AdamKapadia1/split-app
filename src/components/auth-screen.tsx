import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NightScreen } from '@/components/night-screen';
import { APP_NAME, APP_TAGLINE } from '@/constants/brand';
import { Colors, Spacing } from '@/constants/theme';
import { mediumHaptic, tickHaptic } from '@/lib/haptics';
import { supabase } from '@/lib/supabase';
import { theme } from '@/theme/theme';

type Mode = 'sign-in' | 'create';

export function AuthScreen() {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });
        if (signInError) {
          setError(signInError.message);
        }
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

  const title = mode === 'sign-in' ? 'Welcome back' : 'Create your account';
  const action = mode === 'sign-in' ? 'Sign In' : 'Create Account';

  return (
    <NightScreen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
        <View
          style={[
            styles.content,
            { paddingTop: insets.top + Spacing.five, paddingBottom: Math.max(insets.bottom, Spacing.four) },
          ]}>
          <Text style={styles.kicker}>{APP_NAME}</Text>
          <Text style={styles.tagline}>{APP_TAGLINE}</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>Sign in to host a split, or join one you were sent.</Text>

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
            placeholderTextColor={theme.colors.textMuted}
            selectionColor={theme.colors.accent}
            textContentType="emailAddress"
            value={email}
            onChangeText={setEmail}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel="Password"
            autoCapitalize="none"
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            autoCorrect={false}
            placeholder="Password"
            placeholderTextColor={theme.colors.textMuted}
            selectionColor={theme.colors.accent}
            secureTextEntry
            textContentType={mode === 'sign-in' ? 'password' : 'newPassword'}
            value={password}
            onChangeText={setPassword}
            style={styles.input}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={action}
            accessibilityState={{ disabled: busy, busy }}
            activeOpacity={0.85}
            disabled={busy}
            onPress={() => {
              void submit();
            }}
            style={[styles.buttonPress, busy && styles.buttonBusy]}>
            <View style={styles.button}>
              {busy ? <ActivityIndicator color={theme.colors.accentText} /> : <Text style={styles.buttonLabel}>{action}</Text>}
            </View>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </NightScreen>
  );
}

function Toggle({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.toggleItem, selected && styles.toggleItemSelected]}>
      <Text style={[styles.toggleLabel, selected && styles.toggleLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  kicker: {
    color: theme.colors.accent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2.4,
  },
  tagline: {
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: -0.1,
    marginTop: -8,
  },
  title: {
    color: Colors.text,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '700',
    letterSpacing: -0.8,
  },
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: -0.1,
    marginBottom: Spacing.two,
  },
  toggle: {
    flexDirection: 'row',
    gap: Spacing.two,
    padding: 4,
    borderRadius: 16,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  toggleItem: {
    flex: 1,
    minHeight: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleItemSelected: {
    backgroundColor: theme.colors.accentSubtle,
    borderWidth: 1,
    borderColor: theme.colors.accentBorder,
  },
  toggleLabel: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  toggleLabelSelected: {
    color: theme.colors.accent,
  },
  input: {
    minHeight: 56,
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    backgroundColor: theme.colors.canvas,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: Colors.text,
    fontSize: 16,
    letterSpacing: -0.2,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  notice: {
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  buttonPress: {
    marginTop: Spacing.two,
    borderRadius: 999,
    shadowColor: theme.colors.accent,
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  buttonBusy: {
    opacity: 0.7,
  },
  button: {
    minHeight: 56,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    backgroundColor: theme.colors.accent,
  },
  buttonLabel: {
    color: theme.colors.accentText,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
});
