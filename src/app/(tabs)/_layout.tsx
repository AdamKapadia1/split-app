import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import { Platform, StyleSheet, View } from 'react-native';

import { velor } from '@/theme/velorVisuals';
import { hapticSelection } from '@/utils/haptics';

function tabIconColor(color: unknown) {
  return typeof color === 'string' ? color : velor.inactive;
}

function TabBarBackdrop() {
  return (
    <View style={styles.backdrop}>
      {Platform.OS === 'ios' ? (
        <>
          <BlurView intensity={48} tint="dark" style={StyleSheet.absoluteFill} />
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.scrim]} />
        </>
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.fallback]} />
      )}
      <View style={styles.hairline} />
    </View>
  );
}

function ScanTabIcon({ focused }: { focused: boolean }) {
  return (
    <View style={[styles.scanPill, focused ? styles.scanPillActive : null]}>
      <Ionicons name="camera-outline" size={18} color={focused ? velor.ink : '#C5CDFF'} />
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenListeners={{
        tabPress: () => {
          try {
            hapticSelection();
          } catch {
            // Simulators and devices without a haptic engine.
          }
        },
      }}
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarBackground: () => <TabBarBackdrop />,
        tabBarStyle: {
          backgroundColor: 'transparent',
          borderTopWidth: 0,
          elevation: 0,
          shadowOpacity: 0,
          paddingTop: 6,
        },
        tabBarActiveTintColor: velor.iris,
        tabBarInactiveTintColor: velor.inactive,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          letterSpacing: 0.2,
          marginTop: 2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <Ionicons name="home-outline" size={22} color={tabIconColor(color)} />,
        }}
      />
      <Tabs.Screen
        name="groups"
        options={{
          title: 'Groups',
          tabBarIcon: ({ color }) => <Ionicons name="people-outline" size={22} color={tabIconColor(color)} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ color }) => <Ionicons name="receipt-outline" size={22} color={tabIconColor(color)} />,
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: 'Scan',
          tabBarIcon: ({ focused }) => <ScanTabIcon focused={focused} />,
        }}
      />
      <Tabs.Screen name="scanner" options={{ href: null }} />
      <Tabs.Screen name="split" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    overflow: 'hidden',
  },
  scrim: {
    backgroundColor: velor.tabScrim,
  },
  fallback: {
    backgroundColor: velor.tabFallback,
  },
  hairline: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(235, 240, 255, 0.12)',
  },
  scanPill: {
    minWidth: 44,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(124, 140, 255, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(142, 158, 255, 0.45)',
  },
  scanPillActive: {
    backgroundColor: 'rgba(124, 140, 255, 0.32)',
  },
});
