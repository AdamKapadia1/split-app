import { NativeTabs } from 'expo-router/native-tabs';
import { Platform } from 'react-native';

import { Colors } from '@/constants/theme';

export default function TabLayout() {
  return (
    <NativeTabs
      backgroundColor="#030712"
      blurEffect="systemChromeMaterialDark"
      tintColor={Colors.accent}
      indicatorColor={Platform.OS === 'web' ? Colors.backgroundSelected : Colors.accent}
      iconColor={{
        default: Colors.textSecondary,
        selected: Colors.accent,
      }}
      labelStyle={{
        default: { color: Colors.textSecondary },
        selected: { color: Colors.accent },
      }}>
      <NativeTabs.Trigger name="index" contentStyle={{ backgroundColor: Colors.background }}>
        <NativeTabs.Trigger.Label>Groups</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person.2', selected: 'person.2.fill' }}
          md="group"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="scanner" contentStyle={{ backgroundColor: Colors.background }}>
        <NativeTabs.Trigger.Label>Scanner</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="qrcode.viewfinder" md="qr_code_scanner" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="split" contentStyle={{ backgroundColor: Colors.background }}>
        <NativeTabs.Trigger.Label>Split</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="arrow.left.arrow.right" md="call_split" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
