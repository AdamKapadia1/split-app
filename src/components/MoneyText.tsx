import { StyleSheet, Text } from 'react-native';

import { theme } from '@/theme/theme';
import { formatPence } from '@/utils/money';

type MoneySize = 'sm' | 'md' | 'lg' | 'hero';

type MoneyTextProps = {
  amountMinor: number;
  size?: MoneySize;
  color?: string;
  splitDecimals?: boolean;
  showSign?: boolean;
  /** Overrides the hero figure size when decimals are split. */
  figureSize?: number;
};

const SIZE_STYLE = {
  sm: { fontSize: 13, lineHeight: 18, fontWeight: '600' as const },
  md: { fontSize: 15, lineHeight: 20, fontWeight: '600' as const },
  lg: { fontSize: 16, lineHeight: 21, fontWeight: '700' as const },
  hero: theme.typography.hero,
};

export function MoneyText({ amountMinor, size = 'md', color, splitDecimals = false, showSign = false, figureSize }: MoneyTextProps) {
  const formatted = showSign && amountMinor > 0 ? `+${formatPence(amountMinor)}` : formatPence(amountMinor);
  const ink = color ?? theme.colors.textPrimary;

  if (splitDecimals) {
    const dot = formatted.lastIndexOf('.');
    const whole = dot === -1 ? formatted : formatted.slice(0, dot);
    const fraction = dot === -1 ? '' : formatted.slice(dot);

    return (
      <Text
        accessibilityLabel={formatted}
        adjustsFontSizeToFit
        minimumFontScale={0.55}
        numberOfLines={1}
        style={[
          styles.heroWhole,
          figureSize != null ? { fontSize: figureSize, lineHeight: figureSize + 6 } : null,
          { color: ink },
        ]}
      >
        {whole}
        {fraction ? (
          <Text style={[styles.heroFraction, figureSize != null ? { fontSize: figureSize, lineHeight: figureSize + 6 } : null]}>
            {fraction}
          </Text>
        ) : null}
      </Text>
    );
  }

  return (
    <Text accessibilityLabel={formatted} style={[SIZE_STYLE[size], styles.tabular, { color: ink }]}>
      {formatted}
    </Text>
  );
}

const styles = StyleSheet.create({
  tabular: { fontVariant: ['tabular-nums'] },
  heroWhole: {
    ...theme.typography.hero,
    fontWeight: '700',
    letterSpacing: -1.2,
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
  },
  heroFraction: {
    fontSize: 30,
    fontWeight: '600',
    letterSpacing: -1.2,
    color: 'rgba(255, 255, 255, 0.36)',
    fontVariant: ['tabular-nums'],
  },
});
