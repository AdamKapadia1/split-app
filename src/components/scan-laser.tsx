import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { pulseHaptic } from '@/lib/haptics';

export function ScanLaser() {
  const span = useSharedValue(0);
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [progress]);

  useAnimatedReaction(
    () => Math.floor(progress.value * 4),
    (step, previous) => {
      if (previous !== null && step !== previous) {
        runOnJS(pulseHaptic)();
      }
    },
  );

  const beamStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: progress.value * Math.max(span.value - 2, 0) }],
  }));

  return (
    <View
      pointerEvents="none"
      style={styles.frame}
      onLayout={(event) => {
        span.value = event.nativeEvent.layout.height;
      }}>
      <Animated.View style={[styles.beam, beamStyle]}>
        <LinearGradient
          colors={['rgba(56,189,248,0)', 'rgba(56,189,248,0.45)', 'rgba(56,189,248,0)']}
          locations={[0, 0.5, 1]}
          style={styles.glow}
        />
        <View style={styles.core} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  beam: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
    left: 20,
    right: 20,
    height: 28,
  },
  core: {
    position: 'absolute',
    left: 12,
    right: 12,
    height: 2,
    borderRadius: 2,
    backgroundColor: '#E0F2FE',
    shadowColor: '#38BDF8',
    shadowOpacity: 1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
});
