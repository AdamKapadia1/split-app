import { theme } from '@/theme/theme';

export const Colors = {
  text: theme.colors.textPrimary,
  background: theme.colors.canvas,
  backgroundElement: theme.colors.surface,
  backgroundSelected: theme.colors.surfaceElevated,
  textSecondary: theme.colors.textSecondary,
  accent: theme.colors.accent,
  border: theme.colors.border,
  cardStart: theme.colors.surface,
  cardEnd: theme.colors.canvas,
  skeleton: theme.colors.surfaceElevated,
} as const;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const Radius = {
  card: 16,
  pill: 999,
} as const;
