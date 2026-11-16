import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

type NightScreenProps = {
  children: ReactNode;
};

export function NightScreen({ children }: NightScreenProps) {
  return (
    <View style={styles.fill}>
      <LinearGradient
        colors={['#030712', '#0A1024', '#16143A', '#0B132B']}
        locations={[0, 0.36, 0.68, 1]}
        start={{ x: 0.05, y: 0 }}
        end={{ x: 0.95, y: 1 }}
        style={styles.layer}
      />
      <AmbientMesh />
      <View style={styles.fill}>{children}</View>
    </View>
  );
}

function AmbientMesh() {
  return (
    <View pointerEvents="none" style={styles.layer}>
      <DriftOrb glow="rgba(56, 189, 248, 0.22)" size={180} x={-20} y={40} driftX={36} driftY={28} duration={16000} />
      <DriftOrb glow="rgba(99, 102, 241, 0.2)" size={220} x={40} y={520} driftX={-32} driftY={-20} duration={19000} />
      <DriftOrb glow="rgba(14, 165, 233, 0.16)" size={160} x={220} y={240} driftX={20} driftY={26} duration={14000} />
    </View>
  );
}

function DriftOrb({
  glow,
  size,
  x,
  y,
  driftX,
  driftY,
  duration,
}: {
  glow: string;
  size: number;
  x: number;
  y: number;
  driftX: number;
  driftY: number;
  duration: number;
}) {
  const shift = useSharedValue(0);

  useEffect(() => {
    shift.value = withRepeat(withTiming(1, { duration, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [duration, shift]);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: x + driftX * shift.value },
      { translateY: y + driftY * shift.value },
      { scale: 1 + 0.08 * shift.value },
    ],
  }));

  return (
    <Animated.View
      style={[
        styles.orb,
        style,
        {
          width: 2,
          height: 2,
          borderRadius: 1,
          backgroundColor: 'transparent',
          boxShadow: `0 0 ${size}px 0 ${glow}`,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  layer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  orb: {
    position: 'absolute',
  },
});
