import { Pressable, StyleSheet, View } from 'react-native';

import { AvatarBadge } from '@/components/AvatarBadge';
import { VelorBrand } from '@/components/VelorBrand';
import { chrome, velor } from '@/theme/velorVisuals';
import { hapticImpactLight } from '@/utils/haptics';

type VelorHeaderProps = {
  name: string;
  userId?: string;
  onPressAvatar?: () => void;
};

export function VelorHeader({ name, userId, onPressAvatar }: VelorHeaderProps) {
  return (
    <View style={styles.row}>
      <VelorBrand variant="header" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open account settings"
        hitSlop={10}
        onPress={() => {
          try {
            hapticImpactLight();
          } catch {
            // Simulators and devices without a haptic engine.
          }
          onPressAvatar?.();
        }}
        style={styles.avatarRing}
      >
        <AvatarBadge name={name} userId={userId} size={chrome.avatar} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: chrome.rowHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  avatarRing: {
    width: chrome.rowHeight,
    height: chrome.rowHeight,
    borderRadius: chrome.rowHeight / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(235, 240, 255, 0.16)',
    backgroundColor: 'rgba(19, 22, 36, 0.72)',
  },
});

export const headerChrome = {
  paddingHorizontal: chrome.paddingHorizontal,
  paddingTop: chrome.paddingTop,
  paddingBottom: 8,
  titleGap: chrome.gapBelow,
  titleColor: velor.ink,
};
