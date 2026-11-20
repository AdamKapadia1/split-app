import { StyleSheet, Text, View } from 'react-native';

import { theme } from '@/theme/theme';

export type StatusPillVariant = 'positive' | 'warning' | 'accent' | 'neutral';

const VARIANTS: Record<StatusPillVariant, { backgroundColor: string; color: string }> = {
  positive: { backgroundColor: theme.colors.positiveSubtle, color: theme.colors.positive },
  warning: { backgroundColor: theme.colors.warningSubtle, color: theme.colors.warning },
  accent: { backgroundColor: theme.colors.accentSubtle, color: theme.colors.accent },
  neutral: { backgroundColor: theme.colors.surfaceElevated, color: theme.colors.textSecondary },
};

type StatusPillProps = {
  variant: StatusPillVariant;
  label: string;
};

export function StatusPill({ variant, label }: StatusPillProps) {
  const colors = VARIANTS[variant];

  return (
    <View style={[styles.pill, { backgroundColor: colors.backgroundColor }]}>
      <View style={[styles.dot, { backgroundColor: colors.color }]} />
      <Text style={[styles.label, { color: colors.color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius.full,
    gap: 6,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
