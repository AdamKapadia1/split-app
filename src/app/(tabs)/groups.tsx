import { supabase } from '@/lib/supabase';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

type Group = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
};

export default function GroupsScreen() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isModalVisible, setModalVisible] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // 1. Relational Database Fetching
  const fetchGroups = async () => {
    try {
      setIsLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id;

      if (!userId) return;

      // Advanced query: Fetch all groups where this user exists in the group_members mapping table
      const { data, error } = await supabase
        .from('groups')
        .select('*, group_members!inner(user_id)')
        .eq('group_members.user_id', userId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setGroups(data || []);
    } catch (error) {
      console.error('Error fetching groups:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      fetchGroups();
    }, [])
  );

  // 2. Seamless Creation Pipeline
  const handleCreateGroup = async () => {
    const trimmedName = newGroupName.trim();
    if (!trimmedName) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert('Hold up', 'Please enter a group name.');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setIsCreating(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id;

      if (!userId) throw new Error('Authentication required');

      // Optimistic UI Update: Create a temporary group object and inject it instantly
      const tempId = `temp-${Date.now()}`;
      const optimisticGroup: Group = {
        id: tempId,
        name: trimmedName,
        created_by: userId,
        created_at: new Date().toISOString(),
      };
      
      setGroups(prev => [optimisticGroup, ...prev]);
      setModalVisible(false);
      setNewGroupName('');

      // Background Execution: Create Group
      const { data: newGroup, error: groupError } = await supabase
        .from('groups')
        .insert({ name: trimmedName, created_by: userId })
        .select()
        .single();

      if (groupError) throw groupError;

      // Background Execution: Map Creator to Group
      const { error: memberError } = await supabase
        .from('group_members')
        .insert({ group_id: newGroup.id, user_id: userId });

      if (memberError) throw memberError;

      // Silently swap the temporary ID for the real database UUID
      setGroups(prev => prev.map(g => g.id === tempId ? newGroup : g));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    } catch (error) {
      console.error('Error creating group:', error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Transaction Failed', 'Could not create the group securely.');
      fetchGroups(); // Revert the UI to the verified database state
    } finally {
      setIsCreating(false);
    }
  };

  const openModal = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setModalVisible(true);
  };

  const closeModal = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setModalVisible(false);
    setNewGroupName('');
  };

  const renderGroup = ({ item }: { item: Group }) => (
    <TouchableOpacity 
      style={styles.groupCard} 
      activeOpacity={0.8}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        // Future route: router.push({ pathname: '/group/[id]', params: { id: item.id } })
      }}
    >
      <View style={styles.groupIconWrap}>
        <Ionicons name="people" size={24} color="#38BDF8" />
      </View>
      <View style={styles.groupInfo}>
        <Text style={styles.groupName}>{item.name}</Text>
        <Text style={styles.dateText}>
          Created {new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color="#64748b" />
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Groups</Text>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#38BDF8" style={{ marginTop: 60 }} />
      ) : groups.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="people-circle-outline" size={80} color="#334155" />
          <Text style={styles.emptyTitle}>No Groups Yet</Text>
          <Text style={styles.emptySubtitle}>Create a group to track shared expenses for trips, housemates, or events.</Text>
        </View>
      ) : (
        <FlatList
          data={groups}
          keyExtractor={(item) => item.id}
          renderItem={renderGroup}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Floating Action Button */}
      <TouchableOpacity 
        style={styles.fab}
        onPress={openModal}
        activeOpacity={0.9}
      >
        <LinearGradient
          colors={['#7DD3FC', '#38BDF8']}
          style={styles.fabGradient}
        >
          <Ionicons name="add" size={36} color="#030712" />
        </LinearGradient>
      </TouchableOpacity>

      {/* Premium Creation Modal */}
      <Modal visible={isModalVisible} animationType="fade" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalContainer}>
          <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
          
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New Group</Text>
              <TouchableOpacity onPress={closeModal} hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}>
                <Ionicons name="close-circle" size={28} color="#64748b" />
              </TouchableOpacity>
            </View>
            
            <TextInput
              style={styles.input}
              placeholder="e.g., Manchester Trip"
              placeholderTextColor="#64748b"
              value={newGroupName}
              onChangeText={setNewGroupName}
              autoFocus
              selectionColor="#38BDF8"
            />

            <TouchableOpacity 
              style={styles.createButtonContainer} 
              onPress={handleCreateGroup}
              disabled={isCreating}
              activeOpacity={0.9}
            >
              <LinearGradient
                colors={['#7DD3FC', '#38BDF8']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.createButtonGradient}
              >
                {isCreating ? (
                  <ActivityIndicator color="#030712" />
                ) : (
                  <Text style={styles.createButtonText}>Create Group</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: { paddingHorizontal: 24, paddingTop: 64, paddingBottom: 24 },
  title: { fontSize: 32, fontWeight: '800', color: 'white', letterSpacing: -0.5 },
  listContent: { paddingHorizontal: 16, paddingBottom: 120 },
  groupCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1e293b', padding: 20, borderRadius: 24, marginBottom: 12, borderWidth: 1, borderColor: '#334155' },
  groupIconWrap: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(56, 189, 248, 0.1)', justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  groupInfo: { flex: 1 },
  groupName: { fontSize: 18, fontWeight: '700', color: 'white', marginBottom: 4, letterSpacing: -0.3 },
  dateText: { fontSize: 14, color: '#94a3b8', fontWeight: '500' },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, marginTop: -60 },
  emptyTitle: { fontSize: 24, fontWeight: '800', color: 'white', marginTop: 24, marginBottom: 12, letterSpacing: -0.5 },
  emptySubtitle: { fontSize: 16, color: '#94a3b8', textAlign: 'center', lineHeight: 24 },
  
  // Floating Action Button
  fab: { position: 'absolute', bottom: 32, right: 24, width: 72, height: 72, borderRadius: 36, shadowColor: '#38BDF8', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 10 },
  fabGradient: { flex: 1, borderRadius: 36, justifyContent: 'center', alignItems: 'center' },
  
  // Premium Modal Styles
  modalContainer: { flex: 1, justifyContent: 'center', padding: 16 },
  modalContent: { backgroundColor: '#1e293b', padding: 24, borderRadius: 32, borderWidth: 1, borderColor: '#334155', shadowColor: '#000', shadowOffset: { width: 0, height: 24 }, shadowOpacity: 0.6, shadowRadius: 32, elevation: 24 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  modalTitle: { fontSize: 24, fontWeight: '800', color: 'white', letterSpacing: -0.5 },
  input: { backgroundColor: '#0f172a', padding: 20, borderRadius: 20, color: 'white', fontSize: 18, borderWidth: 1, borderColor: '#334155', marginBottom: 28, fontWeight: '600' },
  createButtonContainer: { borderRadius: 999, shadowColor: '#38BDF8', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 12, elevation: 8 },
  createButtonGradient: { minHeight: 60, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  createButtonText: { color: '#030712', fontSize: 18, fontWeight: '800', letterSpacing: -0.2 },
});