import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';

type NightScreenProps = {
  children: ReactNode;
};

export function NightScreen({ children }: NightScreenProps) {
  return (
    <LinearGradient colors={['#030712', '#0B132B']} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }} style={styles.fill}>
      {children}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
