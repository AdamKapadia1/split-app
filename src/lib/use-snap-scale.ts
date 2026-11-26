import { useEffect, useRef } from 'react';
import { Pressable } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';

const SNAP = { damping: 14, stiffness: 380, mass: 0.45 };
const FIRM = { damping: 34, stiffness: 520, mass: 0.55 };

export const SnapPressable = Animated.createAnimatedComponent(Pressable);

export function useSnapScale(signal: boolean | string | number = true, firm = false) {
  const press = useSharedValue(1);
  const pop = useSharedValue(1);
  const seen = useRef(false);

  useEffect(() => {
    if (!seen.current) {
      seen.current = true;
      return;
    }

    if (firm || signal === false) {
      return;
    }

    pop.value = withSequence(
      withTiming(1.045, { duration: 90, easing: Easing.out(Easing.quad) }),
      withSpring(1, SNAP),
    );
  }, [firm, pop, signal]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: press.value * pop.value }],
  }));

  return {
    style,
    onPressIn: () => {
      press.value = withTiming(firm ? 0.975 : 0.94, {
        duration: firm ? 90 : 70,
        easing: Easing.out(Easing.quad),
      });
    },
    onPressOut: () => {
      press.value = withSpring(1, firm ? FIRM : SNAP);
    },
  };
}

export function usePressSpring(scaleTo: number) {
  const press = useSharedValue(1);
  const pop = useSharedValue(1);
  const seen = useRef(false);

  useEffect(() => {
    if (!seen.current) {
      seen.current = true;
      return;
    }
    pop.value = withSpring(1, SNAP);
  }, [pop, scaleTo]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: press.value * pop.value }],
  }));

  return {
    style,
    onPressIn: () => {
      press.value = withSpring(scaleTo, { damping: 18, stiffness: 420, mass: 0.4 });
    },
    onPressOut: () => {
      press.value = withSpring(1, { damping: 16, stiffness: 320, mass: 0.45 });
    },
  };
}

export function useHoldScale(held: boolean) {
  const press = useSharedValue(1);

  useEffect(() => {
    press.value = withSpring(held ? 0.96 : 1, { damping: 15, stiffness: 340, mass: 0.55 });
  }, [held, press]);

  return useAnimatedStyle(() => ({
    transform: [{ scale: press.value }],
  }));
}
