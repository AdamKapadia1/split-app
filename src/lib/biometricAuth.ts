import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type BiometricLabel = 'Face ID' | 'Touch ID' | 'Passcode';

export type BiometricUnlockResult = 'unlocked' | 'cancelled' | 'unavailable';

const LEGACY_PASSWORD_KEY = 'splitapp.biometric_password';
const LEGACY_EMAIL_KEY = 'splitapp.biometric_email';
const LEGACY_REFRESH_KEY = 'splitapp.biometric_refresh';
const LEGACY_PREF_KEY = 'splitapp.biometric_pref';
const LOCK_KEY = 'splitapp.biometric_lock';
const TOKEN_KEY = 'splitapp.biometric_session_token';

const plainOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const authenticatedOptions = {
  requireAuthentication: true,
  authenticationPrompt: 'Unlock Velor',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type LockListener = (locked: boolean) => void;

const listeners = new Set<LockListener>();
let memoryLocked = false;
let promptDepth = 0;
let legacyPurge: Promise<void> | null = null;

function notify(locked: boolean) {
  listeners.forEach((listener) => listener(locked));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '';
}

function isUserCancel(error: unknown) {
  return /cancel/i.test(errorMessage(error));
}

/** Expo Go rejects `requireAuthentication` before showing a prompt. Only then is a LocalAuthentication fallback safe. */
function needsExpoGoFallback(error: unknown) {
  return /NSFaceIDUsageDescription|Expo Go/i.test(errorMessage(error));
}

function createSessionToken() {
  return `velor.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.${Math.random().toString(36).slice(2)}`;
}

async function purgeLegacyPasswordKeys() {
  if (Platform.OS === 'web') return;
  if (!legacyPurge) {
    legacyPurge = Promise.all(
      [LEGACY_PASSWORD_KEY, LEGACY_EMAIL_KEY, LEGACY_REFRESH_KEY, LEGACY_PREF_KEY].map((key) => (
        SecureStore.deleteItemAsync(key, plainOptions).catch(() => undefined)
      )),
    ).then(() => undefined);
  }
  await legacyPurge;
}

export function isSessionLocked() {
  return memoryLocked;
}

export function isBiometricPromptActive() {
  return promptDepth > 0;
}

export function subscribeSessionLock(listener: LockListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Locks the UI gate. The Supabase session stays in place. */
export function lockSessionInMemory() {
  if (memoryLocked) return;
  memoryLocked = true;
  notify(true);
}

export function unlockSessionInMemory() {
  if (!memoryLocked) return;
  memoryLocked = false;
  notify(false);
}

export async function isBiometricAvailable(): Promise<{ available: boolean; label: BiometricLabel }> {
  if (Platform.OS === 'web') return { available: false, label: 'Passcode' };
  try {
    const [hardware, enrolled, types] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    return {
      available: hardware && enrolled,
      label: biometricLabel(types),
    };
  } catch {
    return { available: false, label: 'Passcode' };
  }
}

export async function isBiometricLockEnabled() {
  if (Platform.OS === 'web') return false;
  await purgeLegacyPasswordKeys();
  try {
    return (await SecureStore.getItemAsync(LOCK_KEY, plainOptions)) === 'on';
  } catch {
    return false;
  }
}

/**
 * Enables an OS-gated session lock for the active login.
 * The Keychain entry is a device token, never a password.
 */
export async function setBiometricLockEnabled(enabled: boolean) {
  if (!enabled) {
    await clearBiometricAuth();
    return;
  }
  if (Platform.OS === 'web') {
    throw new Error('Biometrics are unavailable on this device.');
  }
  await purgeLegacyPasswordKeys();
  const hardware = await isBiometricAvailable();
  if (!hardware.available) {
    throw new Error('Set up Face ID or Touch ID on this device, then try again.');
  }

  const token = createSessionToken();
  let gated = true;
  promptDepth += 1;
  try {
    try {
      await SecureStore.setItemAsync(TOKEN_KEY, token, authenticatedOptions);
    } catch (error) {
      if (isUserCancel(error)) {
        throw new Error('Biometric setup was cancelled.');
      }
      if (!needsExpoGoFallback(error)) {
        throw new Error('Biometrics are unavailable on this device.');
      }
      gated = false;
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Velor',
        fallbackLabel: 'Use Passcode',
        cancelLabel: 'Cancel',
      });
      if (!result.success) {
        throw new Error(result.error === 'user_cancel' ? 'Biometric setup was cancelled.' : 'Biometrics are unavailable on this device.');
      }
      await SecureStore.setItemAsync(TOKEN_KEY, token, plainOptions);
    }

    if (gated) {
      try {
        const stored = await SecureStore.getItemAsync(TOKEN_KEY, authenticatedOptions);
        if (!stored) {
          await SecureStore.deleteItemAsync(TOKEN_KEY, authenticatedOptions).catch(() => undefined);
          throw new Error('Biometrics are unavailable on this device.');
        }
      } catch (error) {
        await SecureStore.deleteItemAsync(TOKEN_KEY, authenticatedOptions).catch(() => undefined);
        await SecureStore.deleteItemAsync(TOKEN_KEY, plainOptions).catch(() => undefined);
        if (error instanceof Error && error.message === 'Biometrics are unavailable on this device.') throw error;
        if (isUserCancel(error)) throw new Error('Biometric setup was cancelled.');
        throw new Error('Biometrics are unavailable on this device.');
      }
    }

    await SecureStore.setItemAsync(LOCK_KEY, 'on', plainOptions);
    unlockSessionInMemory();
  } finally {
    promptDepth = Math.max(0, promptDepth - 1);
  }
}

/** Reads the biometric token. The OS prompt comes from SecureStore, not a second LocalAuthentication call. */
export async function unlockBiometricSession(): Promise<BiometricUnlockResult> {
  if (Platform.OS === 'web') return 'unavailable';
  await purgeLegacyPasswordKeys();
  promptDepth += 1;
  try {
    try {
      const token = await SecureStore.getItemAsync(TOKEN_KEY, authenticatedOptions);
      if (!token) return 'unavailable';
      unlockSessionInMemory();
      return 'unlocked';
    } catch (error) {
      if (isUserCancel(error)) return 'cancelled';
      if (!needsExpoGoFallback(error)) return 'unavailable';
      try {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Unlock Velor',
          fallbackLabel: 'Use Passcode',
          cancelLabel: 'Cancel',
        });
        if (!result.success) {
          return result.error === 'user_cancel' || result.error === 'system_cancel' || result.error === 'app_cancel'
            ? 'cancelled'
            : 'unavailable';
        }
        const token = await SecureStore.getItemAsync(TOKEN_KEY, plainOptions);
        if (!token) return 'unavailable';
        unlockSessionInMemory();
        return 'unlocked';
      } catch {
        return 'unavailable';
      }
    }
  } finally {
    promptDepth = Math.max(0, promptDepth - 1);
  }
}

export async function clearBiometricAuth() {
  unlockSessionInMemory();
  if (Platform.OS === 'web') return;
  await purgeLegacyPasswordKeys();
  await Promise.all([
    SecureStore.deleteItemAsync(LOCK_KEY, plainOptions).catch(() => undefined),
    SecureStore.deleteItemAsync(TOKEN_KEY, authenticatedOptions).catch(() => undefined),
    SecureStore.deleteItemAsync(TOKEN_KEY, plainOptions).catch(() => undefined),
    SecureStore.deleteItemAsync(LEGACY_PASSWORD_KEY, plainOptions).catch(() => undefined),
    SecureStore.deleteItemAsync(LEGACY_EMAIL_KEY, plainOptions).catch(() => undefined),
    SecureStore.deleteItemAsync(LEGACY_REFRESH_KEY, plainOptions).catch(() => undefined),
  ]);
}

function biometricLabel(types: LocalAuthentication.AuthenticationType[]): BiometricLabel {
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'Face ID';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'Touch ID';
  return 'Passcode';
}
