import * as Sentry from '@sentry/react-native';
import { DarkTheme, Stack, ThemeProvider, useRouter } from 'expo-router';
import * as Font from 'expo-font';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { AppLockGate } from '@/components/AppLockGate';
import { PrivacyShield } from '@/components/PrivacyShield';
import { Colors } from '@/constants/theme';
import { theme } from '@/theme/theme';
import { useSupabaseSession } from '@/lib/use-session';
import { registerForPushNotificationsAsync } from '@/services/NotificationService';
import { registerPushToken, startPaymentNotificationRouting } from '@/services/PushNotificationService';
import { logger } from '@/utils/logger';
import { receiptIdFromNotificationData } from '@/utils/notifications';
import { initSentry, setSentryUser } from '@/utils/sentry';

initSentry();

SplashScreen.setOptions({ duration: 300, fade: true });
SplashScreen.preventAutoHideAsync().catch(() => undefined);

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
  const [fontsReady, setFontsReady] = useState(false);
  const [lockReady, setLockReady] = useState(false);
  const splashHidden = useRef(false);
  const markLockReady = useCallback(() => {
    setLockReady(true);
  }, []);
  const appReady = fontsReady && ready && lockReady;

  useEffect(() => {
    let cancelled = false;
    async function loadFonts() {
      try {
        await Font.loadAsync({});
      } catch {
        // A failed face must not pin the splash; system fonts remain usable.
      } finally {
        if (!cancelled) setFontsReady(true);
      }
    }
    void loadFonts();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!appReady || splashHidden.current) return;
    splashHidden.current = true;
    SplashScreen.hideAsync().catch(() => undefined);
  }, [appReady]);

  useEffect(() => {
    setSentryUser(userId);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const stopRouting = startPaymentNotificationRouting();
    void (async () => {
      await registerForPushNotificationsAsync(userId);
      if (!cancelled) await registerPushToken(userId);
    })();
    return () => {
      cancelled = true;
      stopRouting();
    };
  }, [userId]);

  if (!ready) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color="#8B95FF" />
      </View>
    );
  }

  return (
    <AppLockGate active={session !== null} userId={userId} onReady={markLockReady}>
      {appReady ? (
        <>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: Colors.background },
            }}>
            <Stack.Screen name="s/[token]" />
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
      ) : (
        <View style={styles.boot}>
          <ActivityIndicator color="#8B95FF" />
        </View>
      )}
    </AppLockGate>
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
  boot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#050609',
  },
});
