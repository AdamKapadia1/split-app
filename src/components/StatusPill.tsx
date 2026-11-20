import { StyleSheet, Text, View } from 'react-native';

import { theme } from '@/theme/theme';

export type StatusPillVariant = 'positive' | 'warning' | 'accent' | 'neutral';

const VARIANTS: Record<StatusPillVariant, { backgroundColor: string; color: string; dot: string }> = {
  positive: { backgroundColor: theme.colors.positiveSubtle, color: theme.colors.positive, dot: theme.colors.positive },
  warning: { backgroundColor: theme.colors.warningSubtle, color: theme.colors.warning, dot: theme.colors.warning },
  accent: { backgroundColor: theme.colors.accentSubtle, color: theme.colors.accent, dot: theme.colors.accent },
  neutral: { backgroundColor: theme.colors.surfaceElevated, color: theme.colors.textSecondary, dot: theme.colors.textMuted },
};

type StatusPillProps = {
  variant: StatusPillVariant;
  label: string;
  bordered?: boolean;
};

export function StatusPill({ variant, label, bordered = false }: StatusPillProps) {
  const colors = VARIANTS[variant];

  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: colors.backgroundColor },
        bordered && styles.bordered,
      ]}
    >
      <View style={[styles.dot, { backgroundColor: colors.dot }]} />
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
  bordered: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
