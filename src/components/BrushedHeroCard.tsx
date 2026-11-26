import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { heroFill, heroSheen, platinumRim, toneWash, type VelorTone } from '@/theme/velorVisuals';

type BrushedHeroCardProps = {
  children: ReactNode;
  tone?: VelorTone;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  radius?: number;
};

export function BrushedHeroCard({
  children,
  tone = 'none',
  style,
  contentStyle,
  radius = 24,
}: BrushedHeroCardProps) {
  const innerRadius = radius - 1;

  return (
    <LinearGradient
      colors={platinumRim}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.rim, { borderRadius: radius, padding: 1 }, style]}
    >
      <LinearGradient
        colors={heroFill}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.fill, { borderRadius: innerRadius }]}
      >
        <LinearGradient
          pointerEvents="none"
          colors={heroSheen}
          locations={[0, 0.46, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {tone !== 'none' ? (
          <LinearGradient
            pointerEvents="none"
            colors={[toneWash[tone], 'rgba(5, 6, 11, 0)']}
            start={{ x: 1, y: 0 }}
            end={{ x: 0.15, y: 0.85 }}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <View style={contentStyle}>{children}</View>
      </LinearGradient>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  rim: {
    overflow: 'hidden',
  },
  fill: {
    overflow: 'hidden',
  },
});
