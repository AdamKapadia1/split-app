import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '@/lib/supabase';
import { theme } from '@/theme/theme';

type Group = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
};

export default function GroupsScreen() {
  const router = useRouter();
  const [groups, setGroups] = useState<Group[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isModalVisible, setModalVisible] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [nameFocused, setNameFocused] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const nameReady = newGroupName.trim().length > 0;

  const fetchGroups = useCallback(async (mode: 'load' | 'refresh' = 'load') => {
    try {
      if (mode === 'refresh') {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      if (!supabase) return;
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id;

      if (!userId) return;

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
      setIsRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void fetchGroups();
    }, [fetchGroups])
  );

  const handleCreateGroup = async () => {
    const trimmedName = newGroupName.trim();
    if (!trimmedName) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert('Hold up', 'Please enter a group name.');
      return;
    }

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsCreating(true);

    try {
      if (!supabase) throw new Error('Supabase is not configured.');
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id;

      if (!userId) throw new Error('Authentication required');

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

      const { data: newGroup, error: groupError } = await supabase
        .from('groups')
        .insert({ name: trimmedName, created_by: userId })
        .select()
        .single();

      if (groupError) throw groupError;

      const { error: memberError } = await supabase
        .from('group_members')
        .insert({ group_id: newGroup.id, user_id: userId });

      if (memberError) throw memberError;

      setGroups(prev => prev.map(g => g.id === tempId ? newGroup : g));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error('Error creating group:', error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Transaction Failed', 'Could not create the group securely.');
      void fetchGroups();
    } finally {
      setIsCreating(false);
    }
  };

  const openModal = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setModalVisible(true);
  };

  const closeModal = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setModalVisible(false);
    setNewGroupName('');
    setNameFocused(false);
  };

  return (
    <SafeAreaView edges={['top']} style={styles.container}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>Groups</Text>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color={theme.colors.accent} style={styles.loader} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => {
                void fetchGroups('refresh');
              }}
              tintColor={theme.colors.accent}
            />
          }
        >
          {groups.length > 0 ? <Text style={styles.sectionHeading}>Your groups</Text> : null}
          <View style={styles.card}>
            {groups.length === 0 ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyBadge}>
                  <Ionicons name="people-outline" size={22} color={theme.colors.accent} />
                </View>
                <Text style={styles.emptyTitle}>No groups yet</Text>
                <Text style={styles.emptySubtitle}>Tap + to create a group for dinners or trips.</Text>
              </View>
            ) : (
              groups.map((item, index) => {
                const isSyncing = item.id.startsWith('temp-');
                return (
                  <View key={item.id}>
                    {index > 0 ? <View style={styles.divider} /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={item.name}
                      onPress={() => {
                        if (isSyncing) {
                          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                          return;
                        }
                        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        router.push({ pathname: '/group/[id]', params: { id: item.id } });
                      }}
                      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, isSyncing && styles.rowSyncing]}
                    >
                      <View style={styles.iconBadge}>
                        <Ionicons name="people-outline" size={18} color={theme.colors.accent} />
                      </View>
                      <View style={styles.copy}>
                        <Text style={styles.groupName} numberOfLines={1}>{item.name}</Text>
                        <Text style={[styles.groupMeta, isSyncing && styles.syncing]}>
                          {isSyncing
                            ? 'Syncing...'
                            : `Created ${new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
                    </Pressable>
                  </View>
                );
              })
            )}
          </View>
        </ScrollView>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create group"
        onPress={openModal}
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
      >
        <Ionicons name="add" size={24} color={theme.colors.accentText} />
      </Pressable>

      <Modal visible={isModalVisible} animationType="fade" transparent onRequestClose={closeModal}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New Group</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={10}
                onPress={closeModal}
                style={({ pressed }) => [styles.closeButton, pressed && styles.closePressed]}
              >
                <Ionicons name="close" size={15} color={theme.colors.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.modalSubtitle}>Name the group for this dinner, trip, or house.</Text>
            <TextInput
              style={[styles.input, nameFocused && styles.inputFocused]}
              placeholder="e.g., Manchester Trip"
              placeholderTextColor={theme.colors.textMuted}
              value={newGroupName}
              onChangeText={setNewGroupName}
              onFocus={() => setNameFocused(true)}
              onBlur={() => setNameFocused(false)}
              autoFocus
              selectionColor={theme.colors.accent}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create Group"
              disabled={!nameReady || isCreating}
              onPress={() => {
                void handleCreateGroup();
              }}
              style={({ pressed }) => [
                styles.createButton,
                !nameReady && !isCreating && styles.createButtonDisabled,
                nameReady && !isCreating && pressed && styles.createButtonPressed,
              ]}
            >
              {isCreating ? (
                <ActivityIndicator color={theme.colors.accentText} />
              ) : (
                <Text style={[styles.createButtonText, !nameReady && styles.createButtonTextDisabled]}>Create Group</Text>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.canvas },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 },
  title: { ...theme.typography.screenTitle, color: theme.colors.textPrimary },
  loader: { marginTop: 48 },
  scrollContent: { paddingBottom: 120 },
  sectionHeading: {
    ...theme.typography.sectionLabel,
    color: theme.colors.textMuted,
    marginBottom: 8,
    marginLeft: 20,
  },
  card: {
    marginHorizontal: 16,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 66, backgroundColor: theme.colors.border },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14 },
  rowPressed: { backgroundColor: theme.colors.surfaceElevated },
  rowSyncing: { opacity: 0.6 },
  iconBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 8 },
  groupName: { fontSize: 16, lineHeight: 21, fontWeight: '600', color: theme.colors.textPrimary },
  groupMeta: { marginTop: 2, fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
  syncing: { color: theme.colors.accent, fontWeight: '600' },
  emptyState: { paddingVertical: 36, paddingHorizontal: 24, alignItems: 'center' },
  emptyBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { marginTop: 12, fontSize: 16, fontWeight: '600', color: theme.colors.textPrimary },
  emptySubtitle: { marginTop: 4, fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary, textAlign: 'center' },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
    shadowColor: theme.colors.accent,
    shadowOpacity: 0.28,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabPressed: { backgroundColor: theme.colors.accentPressed },
  modalOverlay: {
    flex: 1,
    backgroundColor: theme.colors.scrim,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  modalCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    padding: 20,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  modalTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.4, color: theme.colors.textPrimary },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceElevated,
  },
  closePressed: { backgroundColor: theme.colors.surfacePressed },
  modalSubtitle: { fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary, marginBottom: 20 },
  input: {
    height: 52,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.canvas,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    fontSize: 16,
    color: theme.colors.textPrimary,
  },
  inputFocused: { borderColor: theme.colors.accentBorder },
  createButton: {
    height: 52,
    borderRadius: theme.radius.md,
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  createButtonPressed: { backgroundColor: theme.colors.accentPressed },
  createButtonDisabled: {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  createButtonText: { fontSize: 16, fontWeight: '700', color: theme.colors.accentText },
  createButtonTextDisabled: { fontWeight: '600', color: theme.colors.textMuted },
});
