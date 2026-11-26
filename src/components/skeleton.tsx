import { useEffect, useState } from 'react';
import { Animated, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

type SkeletonProps = {
  style?: StyleProp<ViewStyle>;
};

/**
 * Dark-surface placeholder. Opacity pulses on the UI thread.
 * Callers own width and height through `style`.
 */
export function Skeleton({ style }: SkeletonProps) {
  const [opacity] = useState(() => new Animated.Value(0.45));

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 750,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.45,
          duration: 750,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => {
      pulse.stop();
    };
  }, [opacity]);

  return <Animated.View style={[styles.bone, style, { opacity }]} />;
}

const styles = StyleSheet.create({
  bone: {
    height: 14,
    borderRadius: 8,
    backgroundColor: '#27272E',
    overflow: 'hidden',
  },
});
