import 'react-native-url-polyfill/auto';

import { createClient, type SupportedStorage } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

function isHttpUrl(value: string | undefined): value is string {
  return Boolean(value && /^https?:\/\//i.test(value));
}

const CHUNK = 1800;

function chunkKey(key: string, index: number) {
  return `${key}.${index}`;
}

async function chunkCount(key: string) {
  const head = await SecureStore.getItemAsync(key);
  if (!head?.startsWith('chunk:')) {
    return 0;
  }

  const count = Number(head.slice('chunk:'.length));
  return Number.isFinite(count) ? count : 0;
}

const secureStore: SupportedStorage = {
  async getItem(key) {
    const head = await SecureStore.getItemAsync(key);
    if (head == null || !head.startsWith('chunk:')) {
      return head;
    }

    const count = Number(head.slice('chunk:'.length));
    let value = '';
    for (let index = 0; index < count; index += 1) {
      const part = await SecureStore.getItemAsync(chunkKey(key, index));
      if (part == null) {
        return null;
      }
      value += part;
    }

    return value;
  },
  async setItem(key, value) {
    const previous = await chunkCount(key);
    if (value.length <= CHUNK) {
      await SecureStore.setItemAsync(key, value);
    } else {
      const count = Math.ceil(value.length / CHUNK);
      await SecureStore.setItemAsync(key, `chunk:${count}`);
      for (let index = 0; index < count; index += 1) {
        await SecureStore.setItemAsync(chunkKey(key, index), value.slice(index * CHUNK, (index + 1) * CHUNK));
      }
    }

    const nextCount = value.length <= CHUNK ? 0 : Math.ceil(value.length / CHUNK);
    for (let index = nextCount; index < previous; index += 1) {
      await SecureStore.deleteItemAsync(chunkKey(key, index));
    }
  },
  async removeItem(key) {
    const previous = await chunkCount(key);
    await SecureStore.deleteItemAsync(key);
    for (let index = 0; index < previous; index += 1) {
      await SecureStore.deleteItemAsync(chunkKey(key, index));
    }
  },
};

const memory = new Map<string, string>();

const webStorage: SupportedStorage = {
  getItem(key) {
    if (typeof localStorage === 'undefined') {
      return memory.get(key) ?? null;
    }

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
