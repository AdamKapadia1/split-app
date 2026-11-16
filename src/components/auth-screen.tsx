import { LinearGradient } from 'expo-linear-gradient';
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
import { Colors, Spacing } from '@/constants/theme';
import { mediumHaptic, tickHaptic } from '@/lib/haptics';
import { supabase } from '@/lib/supabase';

const ICE = '#38BDF8';
const NAVY = '#030712';

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
          <Text style={styles.kicker}>SPLIT</Text>
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
            placeholderTextColor={Colors.textSecondary}
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
            placeholderTextColor={Colors.textSecondary}
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
            <LinearGradient colors={['#7DD3FC', ICE]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.button}>
              {busy ? <ActivityIndicator color={NAVY} /> : <Text style={styles.buttonLabel}>{action}</Text>}
            </LinearGradient>
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
    color: ICE,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2.4,
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
    backgroundColor: 'rgba(30, 41, 59, 0.4)',
    borderWidth: 1,
    borderColor: 'rgba(51, 65, 85, 0.5)',
  },
  toggleItem: {
    flex: 1,
    minHeight: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleItemSelected: {
    backgroundColor: 'rgba(56, 189, 248, 0.16)',
    borderWidth: 1,
    borderColor: ICE,
  },
  toggleLabel: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  toggleLabelSelected: {
    color: ICE,
  },
  input: {
    minHeight: 56,
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    backgroundColor: 'rgba(30, 41, 59, 0.4)',
    borderWidth: 1,
    borderColor: 'rgba(51, 65, 85, 0.5)',
    color: Colors.text,
    fontSize: 16,
    letterSpacing: -0.2,
  },
  error: {
    color: '#FCA5A5',
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
    shadowColor: ICE,
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
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  buttonLabel: {
    color: NAVY,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
});
