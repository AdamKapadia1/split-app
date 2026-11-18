import { supabase } from '@/lib/supabase';
import type { Receipt } from '@/types/database.types';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function HomeScreen() {
  const router = useRouter();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Queries the database for receipts and orders them chronologically 
  const fetchReceipts = async () => {
    try {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('receipts')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setReceipts(data || []);
    } catch (error) {
      console.error('Error fetching receipts:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // useFocusEffect triggers fetchReceipts every time this screen becomes active
  useFocusEffect(
    useCallback(() => {
      fetchReceipts();
    }, [])
  );

  async function handleLogout() {
    await supabase.auth.signOut();
    // The Root Layout listener will automatically catch this and route to Auth
  }

  // Renders individual list items for the FlatList
  const renderReceipt = ({ item }: { item: Receipt }) => (
    <TouchableOpacity 
      style={styles.receiptCard}
      onPress={() => router.push({ pathname: '/receipt/[id]', params: { id: item.id } })}
      activeOpacity={0.7}
    >
      <View style={styles.receiptInfo}>
        <Text style={styles.restaurantName}>{item.restaurant_name || 'New Receipt'}</Text>
        <Text style={styles.dateText}>
          {new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
        </Text>
      </View>
      <View style={styles.receiptAmount}>
        <Text style={styles.totalText}>£{Number(item.total_amount || 0).toFixed(2)}</Text>
        <Ionicons name="chevron-forward" size={20} color="#64748b" />
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>History</Text>
        <TouchableOpacity onPress={handleLogout}>
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#38BDF8" style={{ marginTop: 60 }} />
      ) : receipts.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="receipt-outline" size={64} color="#334155" />
          <Text style={styles.emptyTitle}>No receipts yet</Text>
          <Text style={styles.emptySubtitle}>Tap the camera button to scan your first bill.</Text>
        </View>
      ) : (
        <FlatList
          data={receipts}
          keyExtractor={(item) => item.id}
          renderItem={renderReceipt}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Primary Call to Action */}
      <TouchableOpacity 
        style={styles.fab}
        onPress={() => router.push('/scanner')}
        activeOpacity={0.9}
      >
        <Ionicons name="camera" size={32} color="#030712" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 64, paddingBottom: 24 },
  title: { fontSize: 32, fontWeight: '800', color: 'white', letterSpacing: -0.5 },
  logoutText: { color: '#ef4444', fontSize: 16, fontWeight: '600' },
  listContent: { paddingHorizontal: 16, paddingBottom: 120 },
  receiptCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1e293b', padding: 20, borderRadius: 20, marginBottom: 12, borderWidth: 1, borderColor: '#334155' },
  receiptInfo: { flex: 1 },
  restaurantName: { fontSize: 18, fontWeight: '700', color: 'white', marginBottom: 6, letterSpacing: -0.3 },
  dateText: { fontSize: 14, color: '#94a3b8', fontWeight: '500' },
  receiptAmount: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  totalText: { fontSize: 20, fontWeight: '800', color: '#38BDF8', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: 'white', marginTop: 20, marginBottom: 8, letterSpacing: -0.5 },
  emptySubtitle: { fontSize: 16, color: '#64748b', textAlign: 'center', lineHeight: 24 },
  fab: { position: 'absolute', bottom: 32, right: 24, width: 72, height: 72, borderRadius: 36, backgroundColor: '#38BDF8', justifyContent: 'center', alignItems: 'center', shadowColor: '#38BDF8', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 10 },
});