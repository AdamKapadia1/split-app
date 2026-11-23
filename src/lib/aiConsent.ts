import * as SecureStore from 'expo-secure-store';
import { Alert, Platform } from 'react-native';

import { AI_SCAN_CONSENT_KEY } from '@/lib/storageKeys';

const secureOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function hasAiScanConsent() {
  try {
    if (Platform.OS === 'web') {
      return typeof localStorage !== 'undefined' && localStorage.getItem(AI_SCAN_CONSENT_KEY) === 'granted';
    }
    return (await SecureStore.getItemAsync(AI_SCAN_CONSENT_KEY, secureOptions)) === 'granted';
  } catch {
    return false;
  }
}

export async function grantAiScanConsent() {
  if (Platform.OS === 'web') {
    if (typeof localStorage !== 'undefined') localStorage.setItem(AI_SCAN_CONSENT_KEY, 'granted');
    return;
  }
  await SecureStore.setItemAsync(AI_SCAN_CONSENT_KEY, 'granted', secureOptions);
}

export function requestAiScanConsent(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Send this receipt to be read?',
      'Midnight sends the receipt photo to Anthropic so it can read the merchant and line items. Only the photo is sent, and only for that scan. Bank details are not part of the scan.',
      [
        { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
        {
          text: 'Continue',
          onPress: () => {
            void grantAiScanConsent().then(() => resolve(true)).catch(() => resolve(false));
          },
        },
      ],
    );
  });
}

export async function ensureAiScanConsent() {
  if (await hasAiScanConsent()) return true;
  return requestAiScanConsent();
}
