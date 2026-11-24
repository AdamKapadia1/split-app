import { StyleSheet, Text, View } from 'react-native';

import { theme } from '@/theme/theme';

const TINTS = [
  { backgroundColor: 'rgba(129, 140, 248, 0.18)', color: '#A5B4FC' },
  { backgroundColor: 'rgba(52, 211, 153, 0.18)', color: '#6EE7B7' },
  { backgroundColor: 'rgba(167, 139, 250, 0.18)', color: '#C4B5FD' },
  { backgroundColor: 'rgba(251, 191, 36, 0.18)', color: '#FCD34D' },
  { backgroundColor: 'rgba(34, 211, 238, 0.18)', color: '#67E8F9' },
  { backgroundColor: 'rgba(244, 114, 182, 0.18)', color: '#F9A8D4' },
  { backgroundColor: 'rgba(251, 146, 60, 0.18)', color: '#FDBA74' },
] as const;

const FONT_SIZE = { 18: 8, 20: 9, 24: 10, 28: 11, 36: 13, 40: 14, 44: 15 } as const;

type AvatarBadgeProps = {
  name: string;
  userId?: string;
  size?: keyof typeof FONT_SIZE;
  active?: boolean;
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

function tintFor(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return TINTS[hash % TINTS.length] ?? TINTS[0];
}

export function AvatarBadge({ name, userId, size = 36, active = false }: AvatarBadgeProps) {
  const tint = tintFor(userId || name);
  const mark = initials(name);

  return (
    <View
      accessibilityLabel={name}
      style={[
        styles.badge,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: tint.backgroundColor,
          borderColor: active ? theme.colors.accent : 'transparent',
        },
      ]}
    >
      <Text style={[styles.mark, { color: tint.color, fontSize: FONT_SIZE[size] }]}>{mark}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  mark: { fontWeight: '700' },
});
