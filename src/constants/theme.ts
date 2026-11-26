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
  bgCanvas: '#05060B',
  bgElevated: '#131624',
  bgElevatedHigh: '#181C2E',
  bgInput: '#090B13',
  borderSubtle: 'rgba(255, 255, 255, 0.07)',
  borderHighlight: 'rgba(235, 240, 255, 0.14)',
  borderFocus: '#7C8CFF',
  accentPrimary: '#7C8CFF',
  accentGlow: 'rgba(124, 140, 255, 0.16)',
  textPrimary: '#F5F7FF',
  textSecondary: 'rgba(245, 247, 255, 0.62)',
  textMuted: '#7B849B',
  positive: '#2EE59D',
  positiveSoft: 'rgba(46, 229, 157, 0.12)',
  warning: '#FFB547',
  warningSoft: 'rgba(255, 181, 71, 0.12)',
} as const;
