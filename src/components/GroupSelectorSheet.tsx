import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { supabase } from '@/lib/supabase';

type Group = { id: string; name: string; };

export function GroupSelectorSheet({ visible, onSelect, onCancel }: { visible: boolean; onSelect: (id: string | null) => void; onCancel: () => void; }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!visible) return;
    async function fetchGroups() {
      try {
        setIsLoading(true);
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user?.id) return;
        const { data, error } = await supabase
          .from('groups')
          .select('id, name, group_members!inner(user_id)')
          .eq('group_members.user_id', session.user.id)
          .order('created_at', { ascending: false });
        if (!error && data) setGroups(data);
      } finally { setIsLoading(false); }
    }
    fetchGroups();
  }, [visible]);

  const handleSelect = (groupId: string | null) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onSelect(groupId);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={styles.overlay}>
        <TouchableOpacity style={StyleSheet.absoluteFill} onPress={onCancel} activeOpacity={1} />
        <BlurView intensity={60} tint="dark" style={styles.sheet}>
          <View style={styles.dragIndicator} />
          <Text style={styles.sheetTitle}>Assign Receipt</Text>
          {isLoading ? (
            <ActivityIndicator size="large" color="#38BDF8" style={styles.loader} />
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
              <TouchableOpacity style={[styles.optionCard, styles.personalOption]} onPress={() => handleSelect(null)} activeOpacity={0.7}>
                <View style={[styles.iconWrap, { backgroundColor: 'rgba(255, 255, 255, 0.1)' }]}>
                  <Ionicons name="person" size={20} color="#fff" />
                </View>
                <Text style={styles.optionText}>Personal Expense</Text>
                <Ionicons name="chevron-forward" size={20} color="#64748b" />
              </TouchableOpacity>
              <Text style={styles.sectionHeader}>YOUR GROUPS</Text>
              {groups.map(group => (
                <TouchableOpacity key={group.id} style={styles.optionCard} onPress={() => handleSelect(group.id)} activeOpacity={0.7}>
                  <View style={[styles.iconWrap, { backgroundColor: 'rgba(56, 189, 248, 0.15)' }]}>
                    <Ionicons name="people" size={20} color="#38BDF8" />
                  </View>
                  <Text style={styles.optionText}>{group.name}</Text>
                  <Ionicons name="chevron-forward" size={20} color="#64748b" />
                </TouchableOpacity>
              ))}
              {groups.length === 0 && <Text style={styles.emptyText}>{"You haven't created any groups yet."}</Text>}
            </ScrollView>
          )}
        </BlurView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 0, 0, 0.4)' },
  sheet: { backgroundColor: 'rgba(15, 23, 42, 0.85)', borderTopLeftRadius: 32, borderTopRightRadius: 32, maxHeight: '80%', paddingHorizontal: 24, paddingBottom: 40 },
  dragIndicator: { width: 40, height: 5, backgroundColor: '#334155', borderRadius: 3, alignSelf: 'center', marginTop: 12, marginBottom: 24 },
  sheetTitle: { fontSize: 24, fontWeight: '800', color: 'white', letterSpacing: -0.5, marginBottom: 24 },
  loader: { marginVertical: 40 },
  scrollContent: { paddingBottom: 24 },
  sectionHeader: { color: '#64748b', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, marginTop: 24, marginBottom: 12, marginLeft: 4 },
  optionCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1e293b', padding: 16, borderRadius: 20, marginBottom: 12, borderWidth: 1, borderColor: '#334155' },
  personalOption: { borderColor: 'rgba(255, 255, 255, 0.1)' },
  iconWrap: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  optionText: { flex: 1, fontSize: 17, fontWeight: '600', color: 'white' },
  emptyText: { color: '#94a3b8', fontSize: 15, textAlign: 'center', marginTop: 24, fontStyle: 'italic' },
});
