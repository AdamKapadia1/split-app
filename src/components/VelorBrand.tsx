import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { APP_NAME, APP_TAGLINE } from '@/constants/brand';
import { luxury } from '@/constants/theme';

type VelorBrandProps = {
  variant?: 'hero' | 'header' | 'watermark';
  /** Overrides the watermark opacity. Header and hero ignore this. */
  opacity?: number;
};

const WORDMARK = APP_NAME.toUpperCase();

export function VelorBrand({ variant = 'hero', opacity }: VelorBrandProps) {
  if (variant === 'header') {
    return (
      <View style={styles.header}>
        <VelorMark size="small" />
        <VelorWordmark tracking="header" />
      </View>
    );
  }

  if (variant === 'watermark') {
    return (
      <View style={[styles.watermark, opacity != null ? { opacity } : null]}>
        <VelorMark size="small" mono />
        <VelorWordmark tracking="watermark" />
      </View>
    );
  }

  return (
    <View style={styles.hero}>
      <VelorMark size="hero" />
      <VelorWordmark tracking="hero" />
      <View style={styles.rule} />
      <Text style={styles.tagline}>{APP_TAGLINE}</Text>
    </View>
  );
}

export function VelorMark({ size = 'hero', mono = false }: { size?: 'hero' | 'small'; mono?: boolean }) {
  const hero = size === 'hero';
  const dim = hero ? 72 : 28;
  const stroke = hero ? 3 : 1.6;
  const arm = hero ? 34 : 13;

  return (
    <View style={[styles.mark, { width: dim, height: dim, borderRadius: hero ? 14 : 8 }]}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0)']}
        style={styles.markSheen}
      />
      <View style={[styles.markGlow, { width: dim * 0.46, height: dim * 0.46, borderRadius: dim }]} />
      <View style={[styles.apex, { marginTop: hero ? 12 : 4 }]}>
        <View
          style={[
            styles.arm,
            {
              width: stroke,
              height: arm,
              marginLeft: -stroke / 2,
              borderRadius: stroke,
              backgroundColor: mono ? '#F7F8FA' : '#E8EAF2',
              transform: [{ rotate: '32deg' }],
            },
          ]}
        />
        <View
          style={[
            styles.arm,
            {
              width: stroke,
              height: arm,
              marginLeft: -stroke / 2,
              borderRadius: stroke,
              backgroundColor: mono ? 'rgba(247,248,250,0.62)' : luxury.accentPrimary,
              transform: [{ rotate: '-32deg' }],
            },
          ]}
        />
      </View>
    </View>
  );
}

export function VelorWordmark({ tracking }: { tracking: 'hero' | 'header' | 'watermark' }) {
  return <Text style={[styles.word, wordTracking[tracking]]}>{WORDMARK}</Text>;
}

const wordTracking = StyleSheet.create({
  hero: { marginTop: 16, fontSize: 22, lineHeight: 28, letterSpacing: 6, paddingRight: 2 },
  header: { fontSize: 13, lineHeight: 18, letterSpacing: 3.5, paddingRight: 1 },
  watermark: { fontSize: 10, lineHeight: 14, letterSpacing: 2.5 },
});

const styles = StyleSheet.create({
  hero: { alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  watermark: { flexDirection: 'row', alignItems: 'center', gap: 6, opacity: 0.3 },
  rule: {
    width: 32,
    height: 1,
    marginTop: 14,
    backgroundColor: '#FFFFFF',
    opacity: 0.2,
  },
  tagline: {
    marginTop: 12,
    fontSize: 13,
    lineHeight: 18,
    color: luxury.textMuted,
    textAlign: 'center',
  },
  word: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  mark: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: '#0B0D14',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  markSheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '46%',
  },
  markGlow: {
    position: 'absolute',
    backgroundColor: luxury.accentGlow,
  },
  apex: {
    width: 2,
    height: 2,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  arm: {
    position: 'absolute',
    left: '50%',
    bottom: 0,
    transformOrigin: 'center bottom',
  },
});
