import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { velor } from '@/theme/velorVisuals';

type IonName = keyof typeof Ionicons.glyphMap;

type CategoryVisual = {
  icon: IonName;
  wash: string;
  ink: string;
};

const FALLBACK: CategoryVisual = {
  icon: 'receipt-outline',
  wash: 'rgba(124, 140, 255, 0.14)',
  ink: '#C5CDFF',
};

const GROUP_TINTS: readonly CategoryVisual[] = [
  { icon: 'people', wash: 'rgba(124, 140, 255, 0.16)', ink: '#C5CDFF' },
  { icon: 'people', wash: 'rgba(46, 229, 157, 0.14)', ink: '#8EF0C8' },
  { icon: 'people', wash: 'rgba(96, 156, 255, 0.16)', ink: '#B7D2FF' },
  { icon: 'people', wash: 'rgba(176, 146, 255, 0.16)', ink: '#D4C6FF' },
  { icon: 'people', wash: 'rgba(212, 184, 122, 0.16)', ink: '#E6D4A8' },
];

function includes(title: string, words: readonly string[]) {
  return words.some((word) => title.includes(word));
}

export function categoryVisual(title: string): CategoryVisual {
  const value = title.toLowerCase();
  if (includes(value, ['skat', 'ice rink', 'cinema', 'movie', 'bowling', 'theatre', 'theater'])) {
    if (includes(value, ['cinema', 'movie', 'theatre', 'theater'])) {
      return { icon: 'film-outline', wash: 'rgba(124, 140, 255, 0.16)', ink: '#C5CDFF' };
    }
    if (includes(value, ['bowling'])) {
      return { icon: 'ellipse-outline', wash: 'rgba(124, 140, 255, 0.16)', ink: '#C5CDFF' };
    }
    return { icon: 'snow-outline', wash: 'rgba(186, 214, 255, 0.14)', ink: '#D5E4FF' };
  }
  if (includes(value, ['pizza'])) return { icon: 'pizza-outline', wash: 'rgba(255, 181, 71, 0.14)', ink: '#FFD089' };
  if (includes(value, ['cafe', 'coffee'])) return { icon: 'cafe-outline', wash: 'rgba(212, 184, 122, 0.16)', ink: '#E6D4A8' };
  if (includes(value, ['restaurant', 'dining', 'dinner', 'lunch', 'bistro', 'kitchen', 'sushi', 'grill'])) {
    return { icon: 'restaurant-outline', wash: 'rgba(255, 181, 71, 0.12)', ink: '#FFD089' };
  }
  if (includes(value, ['pub', 'bar', 'wine', 'cocktail', 'drink', 'brew'])) {
    return { icon: 'wine-outline', wash: 'rgba(176, 146, 255, 0.16)', ink: '#D4C6FF' };
  }
  if (includes(value, ['grocer', 'supermarket', 'market', 'tesco', 'sainsbury', 'waitrose'])) {
    return { icon: 'cart-outline', wash: 'rgba(46, 229, 157, 0.12)', ink: '#8EF0C8' };
  }
  if (includes(value, ['flight', 'airline', 'plane'])) {
    return { icon: 'airplane-outline', wash: 'rgba(96, 156, 255, 0.16)', ink: '#B7D2FF' };
  }
  if (includes(value, ['train', 'rail', 'tube', 'underground'])) {
    return { icon: 'train-outline', wash: 'rgba(96, 156, 255, 0.16)', ink: '#B7D2FF' };
  }
  if (includes(value, ['uber', 'taxi', 'cab', 'travel', 'ride'])) {
    return { icon: 'car-outline', wash: 'rgba(96, 156, 255, 0.16)', ink: '#B7D2FF' };
  }
  if (includes(value, ['utilit', 'electric', 'energy', 'rent', 'broadband', 'home'])) {
    return { icon: 'home-outline', wash: 'rgba(123, 132, 155, 0.2)', ink: '#D5DBEA' };
  }
  return FALLBACK;
}

function tintIndex(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash % GROUP_TINTS.length;
}

type TileProps = {
  icon: IonName;
  wash: string;
  ink: string;
  size?: number;
};

function IconTile({ icon, wash, ink, size = 44 }: TileProps) {
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: 14,
          backgroundColor: wash,
        },
      ]}
    >
      <View pointerEvents="none" style={styles.specular} />
      <Ionicons name={icon} size={Math.round(size * 0.42)} color={ink} />
    </View>
  );
}

export function CategoryIconTile({ title, size = 44 }: { title: string; size?: number }) {
  const visual = categoryVisual(title);
  return <IconTile icon={visual.icon} wash={visual.wash} ink={visual.ink} size={size} />;
}

export function GroupIconTile({ id, name, size = 44 }: { id?: string; name?: string; size?: number }) {
  const seed = (id && id.trim()) || (name && name.trim()) || 'group';
  const visual = GROUP_TINTS[tintIndex(seed)] ?? GROUP_TINTS[0];
  return <IconTile icon={visual.icon} wash={visual.wash} ink={visual.ink} size={size} />;
}

const styles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: velor.rim,
  },
  specular: {
    position: 'absolute',
    top: 0,
    left: 8,
    right: 8,
    height: 1,
    backgroundColor: 'rgba(235, 240, 255, 0.28)',
  },
});
