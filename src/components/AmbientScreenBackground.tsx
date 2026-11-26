import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ambientWash, velor } from '@/theme/velorVisuals';

type AmbientScreenBackgroundProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function AmbientScreenBackground({ children, style }: AmbientScreenBackgroundProps) {
  return (
    <View style={[styles.root, style]}>
      <LinearGradient
        pointerEvents="none"
        colors={ambientWash}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={styles.wash}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: velor.canvas,
  },
  wash: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 240,
  },
});
