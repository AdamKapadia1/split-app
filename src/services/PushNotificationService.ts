import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';
import { receiptIdFromPaymentData } from '@/utils/hostPaidNotification';
import { isExpoPushToken } from '@/utils/notifications';
import { logger } from '@/utils/logger';
import { captureSanitizedException } from '@/utils/sentry';

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/**
 * Deletes this device token from the legacy `push_tokens` table before the
 * Supabase session is cleared. Build 13 no longer registers there (the
 * `claim_push_token` RPC is not deployed in production; device tokens live in
 * `user_push_tokens`, see NotificationService), but rows written by earlier
 * builds are still cleaned up on sign-out.
 */
export async function unregisterPushToken(): Promise<void> {
  if (Platform.OS === 'web') return;

  try {
    const client = supabase;
    if (!client) return;
    const { data, error: sessionError } = await client.auth.getSession();
    const userId = data.session?.user.id;
    if (sessionError || !userId) return;

    const token = await readGrantedToken();
    if (!token || !isExpoPushToken(token)) return;

    const { error } = await client.from('push_tokens').delete().eq('token', token).eq('user_id', userId);
    if (error) throw error;
  } catch (error) {
    reportFailure(error, 'PUSH_UNREGISTER_FAILED');
  }
}

/**
 * Opens /receipt/[id] from a payment alert. Any other route is ignored.
 * Returns the subscription remover.
 */
export function startPaymentNotificationRouting(): () => void {
  if (Platform.OS === 'web') return () => undefined;
  const handled = new Set<string>();

  function openFrom(response: Notifications.NotificationResponse | null) {
    if (!response) return;
    const key = response.notification.request.identifier;
    if (handled.has(key)) return;
    const receiptId = receiptIdFromPaymentData(response.notification.request.content.data);
    if (!receiptId) return;
    handled.add(key);
    void import('expo-router').then(({ router }) => {
      router.push({ pathname: '/receipt/[id]', params: { id: receiptId } });
    }).catch((error) => {
      reportFailure(error, 'PUSH_ROUTE_FAILED');
    });
  }

  const subscription = Notifications.addNotificationResponseReceivedListener(openFrom);
  void Notifications.getLastNotificationResponseAsync()
    .then(openFrom)
    .catch((error) => {
      reportFailure(error, 'PUSH_COLD_START_FAILED');
    });

  return () => subscription.remove();
}

function canRegisterPush(): boolean {
  if (Platform.OS === 'web') return false;
  if (!Device.isDevice) return false;
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient || Constants.appOwnership === 'expo') return false;
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

function readProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const fromExtra = extra?.eas?.projectId;
  const projectId = (typeof fromExtra === 'string' ? fromExtra : null) ?? Constants.easConfig?.projectId ?? null;
  return typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null;
}

async function readGrantedToken(): Promise<string | null> {
  if (!canRegisterPush()) return null;
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (permission.status !== 'granted') return null;
    const projectId = readProjectId();
    if (!projectId) return null;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    return isExpoPushToken(token) ? token : null;
  } catch {
    return null;
  }
}

function reportFailure(error: unknown, code: string) {
  logger.warn('push', { code });
  captureSanitizedException(error, { code });
}
