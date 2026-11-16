import { StyleSheet, Text } from 'react-native';

import { Screen } from '@/components/screen';
import { Surface } from '@/components/surface';

import { Colors, Spacing } from '@/constants/theme';

export default function GroupsScreen() {
  return (
    <Screen title="Groups" subtitle="Your groups will show up here.">
      <Surface style={styles.card}>
        <Text style={styles.cardTitle}>No groups yet</Text>
        <Text style={styles.cardBody}>When you start a split, the people in it will collect here.</Text>
      </Surface>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.five,
    gap: Spacing.two,
  },
  cardTitle: {
    color: Colors.text,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  cardBody: {
    color: Colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
  },
});
