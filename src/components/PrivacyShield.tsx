import { useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';

import { theme } from '@/theme/theme';

export function PrivacyShield() {
  const [covered, setCovered] = useState(AppState.currentState === 'inactive' || AppState.currentState === 'background');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setCovered(state === 'inactive' || state === 'background');
    });
    return () => subscription.remove();
  }, []);

  if (!covered) return null;

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.shield}>
      <Text style={styles.mark}>Midnight</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  shield: {
    ...StyleSheet.absoluteFill,
    zIndex: 1000,
    elevation: 1000,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.canvas,
  },
  mark: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700',
    letterSpacing: -0.4,
    color: theme.colors.textPrimary,
  },
});
