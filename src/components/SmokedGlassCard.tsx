import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { usePressSpring } from '@/lib/use-snap-scale';
import { glassFill, velor } from '@/theme/velorVisuals';
import { hapticImpactLight } from '@/utils/haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type SmokedGlassCardProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
  highlighted?: boolean;
  radius?: number;
  disabled?: boolean;
};

export function SmokedGlassCard({
  children,
  style,
  contentStyle,
  onPress,
  accessibilityLabel,
  highlighted = false,
  radius = 18,
  disabled = false,
}: SmokedGlassCardProps) {
  const press = usePressSpring(0.98);
  const shell = [
    styles.shell,
    { borderRadius: radius },
    highlighted ? styles.highlighted : null,
    style,
  ];

  const body = (
    <>
      <View pointerEvents="none" style={styles.hairline} />
      <View style={contentStyle}>{children}</View>
    </>
  );

  if (!onPress) {
    return (
      <LinearGradient colors={glassFill} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={shell}>
        {body}
      </LinearGradient>
    );
  }

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => {
        if (disabled) return;
        press.onPressIn();
        try {
          hapticImpactLight();
        } catch {
          // Simulators and devices without a haptic engine.
        }
      }}
      onPressOut={press.onPressOut}
      style={press.style}
    >
      <LinearGradient colors={glassFill} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={shell}>
        {body}
      </LinearGradient>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  shell: {
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: velor.rim,
  },
  highlighted: {
    borderColor: velor.iris,
  },
  hairline: {
    position: 'absolute',
    top: 0,
    left: 14,
    right: 14,
    height: 1,
    backgroundColor: velor.specular,
  },
});
