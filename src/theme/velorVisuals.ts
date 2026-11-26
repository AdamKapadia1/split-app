import type { ViewStyle } from 'react-native';

/** Obsidian, Liquid Iris, and Brushed Platinum. Original to Velor. */
export const velor = {
  canvas: '#05060B',
  ink: '#F5F7FF',
  inkStrong: '#FFFFFF',
  decimal: '#8A93AB',
  zero: '#7B849B',
  mint: '#2EE59D',
  mintText: '#45F0AE',
  amber: '#FFB547',
  iris: '#7C8CFF',
  irisDeep: '#6B78FF',
  irisInk: '#060812',
  inactive: '#687085',
  hairline: 'rgba(255, 255, 255, 0.07)',
  rim: 'rgba(255, 255, 255, 0.08)',
  specular: 'rgba(235, 240, 255, 0.12)',
  wash: 'rgba(124, 140, 255, 0.10)',
  washFade: 'rgba(5, 6, 11, 0)',
  tabScrim: '#070912B8',
  tabFallback: '#090B13F2',
} as const;

export const heroFill = ['#181C2E', '#0F1220', '#090B13'] as const;
export const heroSheen = ['rgba(255, 255, 255, 0.05)', 'rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.02)'] as const;
export const platinumRim = ['rgba(235, 240, 255, 0.22)', 'rgba(255, 255, 255, 0.07)', 'rgba(255, 255, 255, 0.02)'] as const;
export const glassFill = ['#131624', '#0C0E17'] as const;
export const irisFill = ['#8E9EFF', '#6B78FF', '#5A67F2'] as const;
export const ambientWash = ['rgba(124, 140, 255, 0.10)', 'rgba(5, 6, 11, 0)'] as const;

export const toneWash = {
  mint: 'rgba(46, 229, 157, 0.09)',
  iris: 'rgba(124, 140, 255, 0.09)',
  amber: 'rgba(255, 181, 71, 0.08)',
  none: 'rgba(5, 6, 11, 0)',
} as const;

export type VelorTone = keyof typeof toneWash;

export const irisLift: ViewStyle = {
  shadowColor: '#6B78FF',
  shadowOpacity: 0.24,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 6 },
  elevation: 6,
};

export const chrome = {
  paddingHorizontal: 20,
  paddingTop: 8,
  rowHeight: 46,
  avatar: 40 as const,
  gapBelow: 16,
};

export const tabular = { fontVariant: ['tabular-nums'] as const };
