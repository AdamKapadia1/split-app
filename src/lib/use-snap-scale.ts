import { useEffect, useRef } from 'react';
import { Pressable } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';

const SNAP = { damping: 14, stiffness: 380, mass: 0.45 };

export const SnapPressable = Animated.createAnimatedComponent(Pressable);

export function useSnapScale(signal: boolean | string | number = true) {
  const press = useSharedValue(1);
  const pop = useSharedValue(1);
  const seen = useRef(false);

  useEffect(() => {
    if (!seen.current) {
      seen.current = true;
      return;
    }

    if (signal === false) {
      return;
    }

    pop.value = withSequence(
      withTiming(1.045, { duration: 90, easing: Easing.out(Easing.quad) }),
      withSpring(1, SNAP),
    );
  }, [pop, signal]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: press.value * pop.value }],
  }));

  return {
    style,
    onPressIn: () => {
      press.value = withTiming(0.94, { duration: 70, easing: Easing.out(Easing.quad) });
    },
    onPressOut: () => {
      press.value = withSpring(1, SNAP);
    },
  };
}
