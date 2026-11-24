import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';
import { mapSettlementNudgeError } from '@/utils/errorMapper';
import { logger } from '@/utils/logger';
import {
  createNudgeIdempotencyKey,
  createTapId,
  isExpoPushToken,
  isReceiptUuid,
  NUDGE_COOLDOWN_MS,
} from '@/utils/notifications';

const NUDGE_TIMEOUT_MS = 20_000;
const CHANNEL_ID = 'settlement-nudges';

export type NotificationPreferences = {
  settlementNudgesEnabled: boolean;
  hideAmountsInNotifications: boolean;
};

export type NudgeSendResult = {
  sent: boolean;
  deliveredCount: number;
  reason: string | null;
  message: string;
};

type NudgePayload = {
  sent?: unknown;
  deliveredCount?: unknown;
  reason?: unknown;
  code?: unknown;
  nextAllowedAt?: unknown;
};

let cachedPushToken: string | null = null;

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

export async function configureAndroidNotificationChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Settlement nudges',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
  });
}

export async function registerForPushNotificationsAsync(userId: string) {
  const unavailable = pushUnavailableReason();
  if (unavailable) {
    logger.debug('notifications', { code: unavailable === 'simulator' ? 'SKIPPED_SIMULATOR' : unavailable === 'expo-go' ? 'SKIPPED_EXPO_GO' : 'SKIPPED_WEB' });
    return;
  }

  try {
    await configureAndroidNotificationChannel();
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status === 'undetermined') {
      const requested = await Notifications.requestPermissionsAsync();
      status = requested.status;
    }
    if (status !== 'granted') {
      logger.debug('notifications', { code: 'PERMISSION_NOT_GRANTED' });
      return;
    }

    const projectId = readProjectId();
    if (!projectId) {
      logger.debug('notifications', { code: 'MISSING_PROJECT_ID' });
      return;
    }

    const tokenResult = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenResult.data;
    if (!isExpoPushToken(token)) {
      logger.debug('notifications', { code: 'TOKEN_REJECTED' });
      return;
    }

    const client = requireClient();
    await requireSelf(client, userId);
    const platform = Platform.OS === 'ios' ? 'ios' : 'android';
    const { error } = await client.from('user_push_tokens').upsert(
      {
        user_id: userId,
        expo_push_token: token,
        platform,
        device_id: null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,expo_push_token' },
    );
    if (error) throw error;
    cachedPushToken = token;
  } catch (error) {
    logger.debug('notifications', { code: 'TOKEN_UNAVAILABLE', detail: error instanceof Error ? error.name : 'error' });
  }
}

export async function unregisterPushTokenAsync(userId: string) {
  const unavailable = pushUnavailableReason();
  if (unavailable === 'web') return;

  try {
    const client = requireClient();
    await requireSelf(client, userId);
    const token = cachedPushToken ?? await readGrantedToken();
    cachedPushToken = null;
    if (!token || !isExpoPushToken(token)) return;
    const { error } = await client.from('user_push_tokens').delete().eq('user_id', userId).eq('expo_push_token', token);
    if (error) throw error;
  } catch {
    logger.warn('notifications', { code: 'UNREGISTER_FAILED' });
  }
}

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  const client = requireClient();
  await requireSelf(client, userId);
  const { data, error } = await client
    .from('user_notification_preferences')
    .select('settlement_nudges_enabled, hide_amounts_in_notifications')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(mapSettlementNudgeError(error, 'Could not load notification settings.'));
  return {
    settlementNudgesEnabled: data?.settlement_nudges_enabled !== false,
    hideAmountsInNotifications: data?.hide_amounts_in_notifications === true,
  };
}

export async function updateNotificationPreferences(userId: string, prefs: NotificationPreferences) {
  const client = requireClient();
  await requireSelf(client, userId);
  const { error } = await client.from('user_notification_preferences').upsert(
    {
      user_id: userId,
      settlement_nudges_enabled: prefs.settlementNudgesEnabled,
      hide_amounts_in_notifications: prefs.hideAmountsInNotifications,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(mapSettlementNudgeError(error, 'Could not save notification settings.'));
}

export async function listRecentNudgedRecipients(receiptId: string): Promise<string[]> {
  if (!isReceiptUuid(receiptId)) return [];
  const client = requireClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  const userId = sessionData.session?.user.id;
  if (!userId) return [];
  const boundary = new Date(Date.now() - NUDGE_COOLDOWN_MS).toISOString();
  const { data, error } = await client
    .from('settlement_nudges')
    .select('recipient_id')
    .eq('sender_id', userId)
    .eq('receipt_id', receiptId)
    .eq('delivery_status', 'sent')
    .gt('created_at', boundary);
  if (error) throw error;
  return (data ?? []).flatMap((row) => (typeof row.recipient_id === 'string' && isReceiptUuid(row.recipient_id) ? [row.recipient_id] : []));
}

export async function sendSettlementNudge(receiptId: string, recipientId: string, tapId = createTapId()): Promise<NudgeSendResult> {
  if (!isReceiptUuid(receiptId) || !isReceiptUuid(recipientId)) {
    throw nudgeError('INVALID_PAYLOAD', 'Could not send that reminder. Please try again.');
  }
  const idempotencyKey = createNudgeIdempotencyKey(receiptId, recipientId, tapId);
  const client = requireClient();
  const { data, error, response } = await client.functions.invoke<NudgePayload>('send-settlement-nudge', {
    body: { receiptId, recipientId, idempotencyKey },
    timeout: NUDGE_TIMEOUT_MS,
  });

  if (error) {
    const body = await readInvokeBody(error, response);
    const code = typeof body?.code === 'string' ? body.code : typeof body?.reason === 'string' ? body.reason : 'REQUEST_FAILED';
    throw nudgeError(code, mapSettlementNudgeError({ code }));
  }

  const reason = typeof data?.reason === 'string' ? data.reason : null;
  const deliveredCount = typeof data?.deliveredCount === 'number' && Number.isFinite(data.deliveredCount)
    ? Math.max(0, Math.trunc(data.deliveredCount))
    : 0;
  const sent = data?.sent === true || (data?.sent !== false && deliveredCount > 0);
  return {
    sent,
    deliveredCount,
    reason,
    message: reason ? mapSettlementNudgeError({ code: reason }) : '',
  };
}

function nudgeError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.name = 'NotificationServiceError';
  error.code = code;
  return error;
}

function requireClient() {
  if (!supabase) throw nudgeError('NOT_CONFIGURED', 'Reminders are temporarily unavailable. Please try again later.');
  return supabase;
}

async function requireSelf(client: NonNullable<typeof supabase>, userId: string) {
  const { data, error } = await client.auth.getSession();
  if (error || data.session?.user.id !== userId) {
    throw nudgeError('NOT_AUTHORIZED', 'Please sign in again.');
  }
}

function pushUnavailableReason(): 'web' | 'expo-go' | 'simulator' | null {
  if (Platform.OS === 'web') return 'web';
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient || Constants.appOwnership === 'expo') return 'expo-go';
  if (!Device.isDevice) return 'simulator';
  return null;
}

function readProjectId() {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const fromExtra = extra?.eas?.projectId;
  if (typeof fromExtra === 'string' && fromExtra.trim()) return fromExtra.trim();
  const fromEas = Constants.easConfig?.projectId;
  return typeof fromEas === 'string' && fromEas.trim() ? fromEas.trim() : null;
}

async function readGrantedToken() {
  if (pushUnavailableReason()) return null;
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

async function readInvokeBody(error: unknown, response: Response | undefined): Promise<NudgePayload | null> {
  if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) return { code: 'TIMEOUT' };
  const httpResponse = response ?? (error instanceof FunctionsHttpError && error.context instanceof Response ? error.context : undefined);
  if (!httpResponse) return null;
  const payload = await httpResponse.clone().json().catch(() => null);
  return payload && typeof payload === 'object' ? payload as NudgePayload : null;
}
