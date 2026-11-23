import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupportedStorage } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';

import { isAppOwnedStorageKey, isLegacyAuthStorageKey } from '@/lib/storageKeys';
import { logger } from '@/utils/logger';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const CHUNK = 1800;

const secureOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

function isHttpUrl(value: string | undefined): value is string {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function chunkKey(key: string, index: number) {
  return `${key}.${index}`;
}

async function readSecure(key: string): Promise<string | null> {
  const head = await SecureStore.getItemAsync(key, secureOptions);
  if (head == null || !head.startsWith('chunk:')) return head;

  const count = Number(head.slice('chunk:'.length));
  if (!Number.isFinite(count) || count < 1) return null;

  let value = '';
  for (let index = 0; index < count; index += 1) {
    const part = await SecureStore.getItemAsync(chunkKey(key, index), secureOptions);
    if (part == null) return null;
    value += part;
  }
  return value;
}

async function chunkCount(key: string) {
  const head = await SecureStore.getItemAsync(key, secureOptions);
  if (!head?.startsWith('chunk:')) return 0;
  const count = Number(head.slice('chunk:'.length));
  return Number.isFinite(count) ? count : 0;
}

async function writeSecure(key: string, value: string) {
  const previous = await chunkCount(key);
  if (value.length <= CHUNK) {
    await SecureStore.setItemAsync(key, value, secureOptions);
  } else {
    const count = Math.ceil(value.length / CHUNK);
    await SecureStore.setItemAsync(key, `chunk:${count}`, secureOptions);
    for (let index = 0; index < count; index += 1) {
      await SecureStore.setItemAsync(
        chunkKey(key, index),
        value.slice(index * CHUNK, (index + 1) * CHUNK),
        secureOptions,
      );
    }
  }

  const nextCount = value.length <= CHUNK ? 0 : Math.ceil(value.length / CHUNK);
  for (let index = nextCount; index < previous; index += 1) {
    await SecureStore.deleteItemAsync(chunkKey(key, index), secureOptions);
  }
}

async function removeSecure(key: string) {
  const previous = await chunkCount(key);
  await SecureStore.deleteItemAsync(key, secureOptions);
  for (let index = 0; index < previous; index += 1) {
    await SecureStore.deleteItemAsync(chunkKey(key, index), secureOptions);
  }
}

let legacyMigration: Promise<void> | null = null;

function migrateLegacyAuthToken() {
  if (Platform.OS === 'web') return Promise.resolve();
  if (!legacyMigration) legacyMigration = migrateLegacyAuthTokenOnce();
  return legacyMigration;
}

async function migrateLegacyAuthTokenOnce() {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const parents = keys.filter((key) => isLegacyAuthStorageKey(key) && !/\.\d+$/.test(key));
    for (const key of parents) {
      const value = await AsyncStorage.getItem(key);
      if (value && !(await readSecure(key))) {
        await writeSecure(key, value);
      }
      await AsyncStorage.removeItem(key);
      const chunks = keys.filter((candidate) => candidate.startsWith(`${key}.`));
      if (chunks.length > 0) await AsyncStorage.multiRemove(chunks);
    }
  } catch {
    logger.error('auth storage migration', { code: 'MIGRATION_FAILED' });
    try {
      const keys = await AsyncStorage.getAllKeys();
      const doomed = keys.filter((key) => isLegacyAuthStorageKey(key));
      if (doomed.length > 0) await AsyncStorage.multiRemove(doomed);
    } catch {
      logger.error('auth storage migration', { code: 'PURGE_FAILED' });
    }
  }
}

const secureStore: SupportedStorage = {
  async getItem(key) {
    await migrateLegacyAuthToken();
    return readSecure(key);
  },
  async setItem(key, value) {
    await migrateLegacyAuthToken();
    await writeSecure(key, value);
  },
  async removeItem(key) {
    await migrateLegacyAuthToken();
    await removeSecure(key);
  },
};

const memory = new Map<string, string>();

const webStorage: SupportedStorage = {
  getItem(key) {
    if (typeof localStorage === 'undefined') return memory.get(key) ?? null;
    return localStorage.getItem(key);
  },
  setItem(key, value) {
    if (typeof localStorage === 'undefined') {
      memory.set(key, value);
      return;
    }
    localStorage.setItem(key, value);
  },
  removeItem(key) {
    if (typeof localStorage === 'undefined') {
      memory.delete(key);
      return;
    }
    localStorage.removeItem(key);
  },
};

export const supabase =
  isHttpUrl(supabaseUrl) && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          storage: Platform.OS === 'web' ? webStorage : secureStore,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      })
    : null;

export function authStorageKey() {
  if (!isHttpUrl(supabaseUrl)) return null;
  const ref = new URL(supabaseUrl).hostname.split('.')[0];
  return ref ? `sb-${ref}-auth-token` : null;
}

export async function purgeLocalAppData() {
  const key = authStorageKey();
  if (Platform.OS === 'web') {
    if (typeof localStorage !== 'undefined') {
      const doomed: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const name = localStorage.key(index);
        if (name && (isAppOwnedStorageKey(name) || (key != null && (name === key || name.startsWith(`${key}.`))))) {
          doomed.push(name);
        }
      }
      doomed.forEach((name) => localStorage.removeItem(name));
    }
    memory.clear();
    return;
  }

  if (key) await removeSecure(key);
  try {
    const keys = await AsyncStorage.getAllKeys();
    const doomed = keys.filter((candidate) => isAppOwnedStorageKey(candidate) || (key != null && (candidate === key || candidate.startsWith(`${key}.`))));
    if (doomed.length > 0) await AsyncStorage.multiRemove(doomed);
  } catch {
    logger.error('local data purge', { code: 'PURGE_FAILED' });
  }
}

if (supabase) {
  const client = supabase;
  if (AppState.currentState !== 'active') {
    client.auth.stopAutoRefresh();
  }
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      client.auth.startAutoRefresh();
    } else {
      client.auth.stopAutoRefresh();
    }
  });
}
