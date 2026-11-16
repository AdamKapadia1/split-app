import { GlassView } from 'expo-glass-effect';
import { type ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

type FrostProps = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function Frost({ children, style }: FrostProps) {
  return (
    <GlassView colorScheme="dark" glassEffectStyle="regular" tintColor="#0B132B" style={[styles.frost, style]}>
      {children}
    </GlassView>
  );
}

const styles = StyleSheet.create({
  frost: {
    backgroundColor: 'rgba(11, 19, 43, 0.62)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    overflow: 'hidden',
  },
});
