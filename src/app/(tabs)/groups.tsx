import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

export default function GroupsScreen() {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Groups</Text>
      </View>

      <View style={styles.emptyState}>
        <Ionicons name="people-circle-outline" size={80} color="#334155" />
        <Text style={styles.emptyTitle}>Trips & Shared Tabs</Text>
        <Text style={styles.emptySubtitle}>
          Soon, you'll be able to create groups to net out balances across multiple receipts, Ubers, and grocery runs.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: { paddingHorizontal: 24, paddingTop: 64, paddingBottom: 24 },
  title: { fontSize: 32, fontWeight: '800', color: 'white', letterSpacing: -0.5 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40, marginTop: -60 },
  emptyTitle: { fontSize: 24, fontWeight: '800', color: 'white', marginTop: 24, marginBottom: 12, letterSpacing: -0.5 },
  emptySubtitle: { fontSize: 16, color: '#94a3b8', textAlign: 'center', lineHeight: 24 },
});