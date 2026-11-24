import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';

import { luxury } from '@/constants/theme';
import { hapticSelection } from '@/utils/haptics';

function tabIconColor(color: unknown) {
  return typeof color === 'string' ? color : luxury.textMuted;
}

export default function TabLayout() {
  return (
    <Tabs
      screenListeners={{
        tabPress: () => {
          hapticSelection();
        },
      }}
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarStyle: {
          backgroundColor: '#06070B',
          borderTopColor: 'rgba(255,255,255,0.08)',
          borderTopWidth: 1,
          elevation: 0,
          shadowOpacity: 0,
          paddingTop: 6,
        },
        tabBarActiveTintColor: luxury.accentPrimary,
        tabBarInactiveTintColor: 'rgba(255,255,255,0.38)',
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
          tabBarIcon: ({ color }) => <Ionicons name="camera-outline" size={22} color={tabIconColor(color)} />,
        }}
      />
      <Tabs.Screen name="scanner" options={{ href: null }} />
      <Tabs.Screen name="split" options={{ href: null }} />
    </Tabs>
  );
}
