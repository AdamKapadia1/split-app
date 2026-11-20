import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { Colors, Radius } from '@/constants/theme';

type SurfaceProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function Surface({ children, style }: SurfaceProps) {
  return (
    <LinearGradient
      colors={[Colors.cardStart, Colors.cardEnd]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.surface, style]}>
      {children}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  surface: {
    borderRadius: Radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
});
