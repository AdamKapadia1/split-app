import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type BiometricLabel = 'Face ID' | 'Touch ID' | 'Passcode';

const REFRESH_KEY = 'splitapp.biometric_refresh';
const EMAIL_KEY = 'splitapp.biometric_email';
const PASSWORD_KEY = 'splitapp.biometric_password';
const PREF_KEY = 'splitapp.biometric_pref';

const secureOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

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

export async function saveBiometricSession(email: string, password: string) {
  if (Platform.OS === 'web') return;
  const address = email.trim();
  if (!address || password.length === 0) return;
  await SecureStore.deleteItemAsync(REFRESH_KEY, secureOptions).catch(() => undefined);
  await SecureStore.setItemAsync(EMAIL_KEY, address, secureOptions);
  await SecureStore.setItemAsync(PASSWORD_KEY, password, secureOptions);
  await SecureStore.setItemAsync(PREF_KEY, 'on', secureOptions);
}

export async function clearBiometricSession() {
  if (Platform.OS === 'web') return;
  await SecureStore.deleteItemAsync(REFRESH_KEY, secureOptions).catch(() => undefined);
  await SecureStore.deleteItemAsync(EMAIL_KEY, secureOptions).catch(() => undefined);
  await SecureStore.deleteItemAsync(PASSWORD_KEY, secureOptions).catch(() => undefined);
}

export async function hasBiometricSession() {
  if (Platform.OS === 'web') return false;
  try {
    const email = await SecureStore.getItemAsync(EMAIL_KEY, secureOptions);
    const password = await SecureStore.getItemAsync(PASSWORD_KEY, secureOptions);
    return Boolean(email && password);
  } catch {
    return false;
  }
}

export async function readBiometricSession(): Promise<{ email: string; password: string } | null> {
  if (Platform.OS === 'web') return null;
  try {
    const email = await SecureStore.getItemAsync(EMAIL_KEY, secureOptions);
    const password = await SecureStore.getItemAsync(PASSWORD_KEY, secureOptions);
    if (!email || !password) return null;
    return { email, password };
  } catch {
    return null;
  }
}

/** `null` means the member has not chosen yet. */
export async function getBiometricPreference(): Promise<'on' | 'off' | null> {
  if (Platform.OS === 'web') return null;
  try {
    const value = await SecureStore.getItemAsync(PREF_KEY, secureOptions);
    if (value === 'on' || value === 'off') return value;
    return null;
  } catch {
    return null;
  }
}

export async function setBiometricPreference(value: 'on' | 'off') {
  if (Platform.OS === 'web') return;
  await SecureStore.setItemAsync(PREF_KEY, value, secureOptions);
}

export async function authenticateWithBiometrics() {
  if (Platform.OS === 'web') return false;
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Sign in to Velor',
      fallbackLabel: 'Use Passcode',
      cancelLabel: 'Cancel',
    });
    return result.success;
  } catch {
    return false;
  }
}

function biometricLabel(types: LocalAuthentication.AuthenticationType[]): BiometricLabel {
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'Face ID';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'Touch ID';
  return 'Passcode';
}
