import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Spacing } from '@/constants/theme';

type ScreenProps = {
  title: string;
  subtitle: string;
};

export function Screen({ title, subtitle }: ScreenProps) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.five,
    gap: Spacing.two,
  },
  title: {
    color: Colors.text,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 16,
    lineHeight: 24,
  },
});
