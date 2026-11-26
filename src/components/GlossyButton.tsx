import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { usePressSpring } from '@/lib/use-snap-scale';
import { glassFill, irisFill, irisLift, velor } from '@/theme/velorVisuals';
import { hapticImpactLight } from '@/utils/haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type GlossyButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: 'iris' | 'glass';
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  dimWhenDisabled?: boolean;
  compact?: boolean;
  labelColor?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

export function GlossyButton({
  label,
  onPress,
  variant = 'iris',
  icon,
  loading = false,
  disabled = false,
  dimWhenDisabled = true,
  compact = false,
  labelColor,
  accessibilityLabel,
  style,
}: GlossyButtonProps) {
  const press = usePressSpring(0.975);
  const iris = variant === 'iris';
  const ink = labelColor ?? (iris ? velor.irisInk : velor.ink);
  const blocked = disabled || loading;

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: blocked, busy: loading }}
      disabled={blocked}
      onPress={onPress}
      onPressIn={() => {
        if (blocked) return;
        press.onPressIn();
        try {
          hapticImpactLight();
        } catch {
          // Simulators and devices without a haptic engine.
        }
      }}
      onPressOut={press.onPressOut}
      style={[
        iris ? styles.irisLift : null,
        press.style,
        dimWhenDisabled && disabled ? styles.dimmed : null,
        style,
      ]}
    >
      <LinearGradient
        colors={iris ? irisFill : glassFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={[styles.fill, compact ? styles.compact : styles.regular, !iris && styles.glassRim]}
      >
        {iris ? <View pointerEvents="none" style={styles.bevel} /> : <View pointerEvents="none" style={styles.glassHairline} />}
        {loading ? (
          <ActivityIndicator color={ink} />
        ) : (
          <View style={styles.row}>
            {icon ? <Ionicons name={icon} size={compact ? 15 : 18} color={ink} /> : null}
            <Text style={[styles.label, compact && styles.compactLabel, { color: ink }]} numberOfLines={2}>
              {label}
            </Text>
          </View>
        )}
      </LinearGradient>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  irisLift,
  dimmed: { opacity: 0.45 },
  fill: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  regular: {
    minHeight: 52,
    paddingHorizontal: 16,
    borderRadius: 16,
  },
  compact: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  glassRim: {
    borderWidth: 1,
    borderColor: velor.rim,
  },
  bevel: {
    position: 'absolute',
    top: 0,
    left: 12,
    right: 12,
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.34)',
  },
  glassHairline: {
    position: 'absolute',
    top: 0,
    left: 12,
    right: 12,
    height: 1,
    backgroundColor: velor.specular,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  label: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  compactLabel: {
    fontSize: 14,
    lineHeight: 18,
  },
});
