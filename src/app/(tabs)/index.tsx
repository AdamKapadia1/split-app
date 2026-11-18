import { supabase } from '@/lib/supabase';
import type { Receipt } from '@/types/database.types';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function HomeScreen() {
  const router = useRouter();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [isLoading, setIsLoading] = useState(true);

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

  useFocusEffect(
    useCallback(() => {
      fetchReceipts();
    }, [])
  );

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  // 1. Intelligent Naming Logic
  const getReceiptName = (item: Receipt) => {
    if (item.restaurant_name && item.restaurant_name.trim() !== '') return item.restaurant_name;
    if (item.merchant_name && item.merchant_name.trim() !== '') return item.merchant_name;
    
    // Fallback if the AI couldn't extract a merchant name
    const date = new Date(item.created_at).toLocaleDateString('en-GB', { 
      weekday: 'short', month: 'short', day: 'numeric' 
    });
    return `Receipt from ${date}`;
  };

  // 2. Optimistic Deletion Logic
  const deleteReceipt = async (id: string, name: string) => {
    Alert.alert(
      'Delete Receipt',
      `Are you sure you want to delete "${name}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Delete', 
          style: 'destructive', 
          onPress: async () => {
            // Optimistic UI update: instantly remove from screen for zero latency
            setReceipts(prev => prev.filter(r => r.id !== id));
            
            try {
              // The database will cascade and delete associated items automatically
              const { error } = await supabase.from('receipts').delete().eq('id', id);
              if (error) throw error;
            } catch (error) {
              console.error('Delete failed:', error);
              Alert.alert('Error', 'Could not delete receipt from the database.');
              fetchReceipts(); // Revert the UI if the database failed
            }
          }
        }
      ]
    );
  };

  const renderReceipt = ({ item }: { item: Receipt }) => {
    const displayName = getReceiptName(item);

    return (
      <View style={styles.receiptCardWrap}>
        <TouchableOpacity 
          style={styles.receiptCard}
          onPress={() => router.push({ pathname: '/receipt/[id]', params: { id: item.id } })}
          activeOpacity={0.7}
        >
          <View style={styles.receiptInfo}>
            <Text style={styles.restaurantName} numberOfLines={1}>{displayName}</Text>
            <Text style={styles.dateText}>
              {new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </Text>
          </View>
          <View style={styles.receiptAmount}>
            <Text style={styles.totalText}>£{Number(item.total_amount || 0).toFixed(2)}</Text>
          </View>
        </TouchableOpacity>
        
        {/* Dedicated Delete Button */}
        <TouchableOpacity 
          style={styles.deleteButton} 
          onPress={() => deleteReceipt(item.id, displayName)}
          activeOpacity={0.6}
        >
          <Ionicons name="trash-outline" size={22} color="#ef4444" />
        </TouchableOpacity>
      </View>
    );
  };

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
          <Text style={styles.emptySubtitle}>Tap the camera button below to scan your first bill.</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 64, paddingBottom: 24 },
  title: { fontSize: 32, fontWeight: '800', color: 'white', letterSpacing: -0.5 },
  logoutText: { color: '#ef4444', fontSize: 16, fontWeight: '600' },
  listContent: { paddingHorizontal: 16, paddingBottom: 40 },
  receiptCardWrap: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  receiptCard: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1e293b', padding: 20, borderRadius: 20, borderWidth: 1, borderColor: '#334155' },
  receiptInfo: { flex: 1, paddingRight: 12 },
  restaurantName: { fontSize: 18, fontWeight: '700', color: 'white', marginBottom: 6, letterSpacing: -0.3 },
  dateText: { fontSize: 14, color: '#94a3b8', fontWeight: '500' },
  receiptAmount: { flexDirection: 'row', alignItems: 'center' },
  totalText: { fontSize: 20, fontWeight: '800', color: '#38BDF8', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  deleteButton: { padding: 18, marginLeft: 8, backgroundColor: '#1e293b', borderRadius: 20, borderWidth: 1, borderColor: '#334155', justifyContent: 'center', alignItems: 'center' },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, marginTop: -60 },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: 'white', marginTop: 20, marginBottom: 8, letterSpacing: -0.5 },
  emptySubtitle: { fontSize: 16, color: '#64748b', textAlign: 'center', lineHeight: 24 },
});