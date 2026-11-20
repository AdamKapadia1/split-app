import { GlassView } from 'expo-glass-effect';
import { type ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '@/theme/theme';

type FrostProps = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function Frost({ children, style }: FrostProps) {
  return (
    <GlassView colorScheme="dark" glassEffectStyle="regular" tintColor={theme.colors.surface} style={[styles.frost, style]}>
      {children}
    </GlassView>
  );
}

const styles = StyleSheet.create({
  frost: {
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    overflow: 'hidden',
  },
});
