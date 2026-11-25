import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { VelorMark, VelorWordmark } from '@/components/VelorBrand';
import { luxury } from '@/constants/theme';
import {
  isBiometricAvailable,
  isBiometricLockEnabled,
  isBiometricPromptActive,
  isSessionLocked,
  lockSessionInMemory,
  subscribeSessionLock,
  unlockBiometricSession,
  clearBiometricAuth,
  type BiometricLabel,
} from '@/lib/biometricAuth';
import { supabase } from '@/lib/supabase';
import { unregisterPushTokenAsync } from '@/services/NotificationService';
import { pulseHaptic } from '@/lib/haptics';

const UNAVAILABLE = 'Biometric session unavailable. Sign in with your password to continue.';

type AppLockGateProps = {
  active: boolean;
  userId: string | null;
  children: ReactNode;
};

export function AppLockGate({ active, userId, children }: AppLockGateProps) {
  const [locked, setLocked] = useState(isSessionLocked);
  const gateKey = active ? (userId ?? 'session') : 'signed-out';
  const [seenKey, setSeenKey] = useState(gateKey);
  const [checked, setChecked] = useState(!active);

  if (seenKey !== gateKey) {
    setSeenKey(gateKey);
    setChecked(!active);
  }

  useEffect(() => subscribeSessionLock(setLocked), []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void isBiometricLockEnabled()
      .then((enabled) => {
        if (cancelled) return;
        if (enabled) lockSessionInMemory();
        setChecked(true);
      })
      .catch(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [active, userId]);

  useEffect(() => {
    if (!active) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'background' || isBiometricPromptActive()) return;
      void isBiometricLockEnabled().then((enabled) => {
        if (enabled) lockSessionInMemory();
      });
    });
    return () => subscription.remove();
  }, [active]);

  if (!active) return children;
  if (!checked) {
    return (
      <View style={styles.canvas}>
        <ActivityIndicator color="#F7F8FA" />
      </View>
    );
  }
  if (!locked) return children;
  return <VelorLockScreen userId={userId} />;
}

function VelorLockScreen({ userId }: { userId: string | null }) {
  const insets = useSafeAreaInsets();
  const [label, setLabel] = useState<BiometricLabel>('Face ID');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void isBiometricAvailable().then((hardware) => {
      if (!cancelled) setLabel(hardware.label);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function unlock() {
    if (busy) return;
    pulseHaptic();
    setBusy(true);
    setNotice(null);
    try {
      const result = await unlockBiometricSession();
      if (result === 'unavailable') setNotice(UNAVAILABLE);
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPassword() {
    if (busy) return;
    setBusy(true);
    try {
      await clearBiometricAuth();
      if (userId) await unregisterPushTokenAsync(userId);
      await supabase?.auth.signOut();
    } finally {
      setBusy(false);
    }
  }

  const unlockLabel = `Unlock with ${label}`;

  return (
    <View style={[styles.canvas, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 24) }]}>
      <View style={styles.center}>
        <View style={styles.monogram}>
          <VelorMark size="small" />
          <Text style={styles.dot}>·</Text>
          <VelorWordmark tracking="header" />
        </View>
        <Text style={styles.privacy}>Balance hidden</Text>
        <Text style={styles.mask}>£••••</Text>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={unlockLabel}
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={() => {
          void unlock();
        }}
        style={({ pressed }) => [styles.primary, pressed && !busy && styles.pressed, busy && styles.busy]}
      >
        {busy ? <ActivityIndicator color="#050609" /> : <Text style={styles.primaryLabel}>{unlockLabel}</Text>}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in with Password"
        disabled={busy}
        onPress={() => {
          void signInWithPassword();
        }}
        style={styles.secondary}
      >
        <Text style={styles.secondaryLabel}>Sign in with Password</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    flex: 1,
    backgroundColor: '#050609',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  center: {
    alignItems: 'center',
    marginBottom: 48,
  },
  monogram: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dot: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '500',
  },
  privacy: {
    marginTop: 28,
    color: luxury.textMuted,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  mask: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.86)',
    fontSize: 40,
    lineHeight: 48,
    fontWeight: '600',
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  notice: {
    marginTop: 18,
    color: luxury.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  primary: {
    alignSelf: 'stretch',
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#8B95FF',
  },
  pressed: { transform: [{ scale: 0.98 }] },
  busy: { opacity: 0.72 },
  primaryLabel: {
    color: '#050609',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  secondary: {
    marginTop: 8,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  secondaryLabel: {
    color: luxury.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
});
