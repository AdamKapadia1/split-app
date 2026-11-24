import * as Sentry from '@sentry/react-native';
import { DarkTheme, Stack, ThemeProvider, useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { NightScreen } from '@/components/night-screen';
import { PrivacyShield } from '@/components/PrivacyShield';
import { Colors } from '@/constants/theme';
import { theme } from '@/theme/theme';
import { useSupabaseSession } from '@/lib/use-session';
import { registerForPushNotificationsAsync } from '@/services/NotificationService';
import { logger } from '@/utils/logger';
import { receiptIdFromNotificationData } from '@/utils/notifications';
import { initSentry, setSentryUser } from '@/utils/sentry';

initSentry();

const AppTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: Colors.background,
    card: Colors.background,
    text: Colors.text,
    border: Colors.border,
    primary: Colors.accent,
    notification: Colors.accent,
  },
};

function RootLayout() {
  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={styles.root}>
        <ThemeProvider value={AppTheme}>
          <StatusBar style="light" />
          <RootNavigator />
        </ThemeProvider>
        <PrivacyShield />
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}

function RootNavigator() {
  const { session, ready } = useSupabaseSession();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    setSentryUser(userId);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void registerForPushNotificationsAsync(userId);
  }, [userId]);

  if (!ready) {
    return (
      <NightScreen>
        <View style={styles.loading}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      </NightScreen>
    );
  }

  return (
    <>
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: Colors.background },
      }}>
      <Stack.Protected guard={session !== null}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="receipt/[id]" />
        <Stack.Screen
          name="group/[id]"
          options={{
            headerShown: false,
            animation: 'slide_from_right',
          }}
        />
      </Stack.Protected>
      <Stack.Protected guard={session === null}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
    <SettlementNudgeLinks userId={userId} />
    </>
  );
}

function SettlementNudgeLinks({ userId }: { userId: string | null }) {
  const router = useRouter();
  const handled = useRef(new Set<string>());

  useEffect(() => {
    if (!userId || Platform.OS === 'web') return;
    let cancelled = false;

    function openFrom(response: Notifications.NotificationResponse | null) {
      if (!response) return;
      const key = response.notification.request.identifier;
      if (handled.current.has(key)) return;
      const receiptId = receiptIdFromNotificationData(response.notification.request.content.data);
      if (!receiptId) return;
      handled.current.add(key);
      router.push(`/receipt/${receiptId}`);
    }

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      openFrom(response);
    });

    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!cancelled) openFrom(response);
      })
      .catch(() => {
        logger.debug('notifications', { code: 'COLD_START_LINK_FAILED' });
      });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [router, userId]);

  return null;
}

export default Sentry.wrap(RootLayout);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.canvas },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
