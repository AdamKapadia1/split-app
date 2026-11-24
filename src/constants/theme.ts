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

/** Dark-luxury surfaces for Velor. Existing `Colors` exports stay on the shared theme. */
export const luxury = {
  bgCanvas: '#050609',
  bgElevated: '#0D0F15',
  bgElevatedHigh: '#141722',
  bgInput: '#090B10',
  borderSubtle: 'rgba(255, 255, 255, 0.07)',
  borderHighlight: 'rgba(255, 255, 255, 0.14)',
  borderFocus: 'rgba(139, 149, 255, 0.65)',
  accentPrimary: '#8B95FF',
  accentGlow: 'rgba(124, 134, 255, 0.16)',
  textPrimary: '#F7F8FA',
  textSecondary: 'rgba(247, 248, 250, 0.56)',
  textMuted: 'rgba(247, 248, 250, 0.34)',
  positive: '#10B981',
  positiveSoft: 'rgba(16, 185, 129, 0.12)',
  warning: '#F59E0B',
  warningSoft: 'rgba(245, 158, 11, 0.12)',
} as const;
