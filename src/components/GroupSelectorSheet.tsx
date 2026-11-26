import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '@/lib/supabase';
import { theme } from '@/theme/theme';

type Group = { id: string; name: string; };

export function GroupSelectorSheet({ visible, onSelect, onCancel }: { visible: boolean; onSelect: (id: string | null) => void; onCancel: () => void; }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!visible) return;
    async function fetchGroups() {
      try {
        setIsLoading(true);
        if (!supabase) return;
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user?.id) return;
        const { data, error } = await supabase
          .from('groups')
          .select('id, name, group_members!inner(user_id)')
          .eq('group_members.user_id', session.user.id)
          .order('created_at', { ascending: false });
        if (!error && data) setGroups(data);
      } catch {
        setGroups([]);
      } finally { setIsLoading(false); }
    }
    fetchGroups();
  }, [visible]);

  const handleSelect = (groupId: string | null) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelect(groupId);
  };

  const options = [{ id: null, name: 'Personal Expense', icon: 'person-outline' as const }, ...groups.map((group) => ({ id: group.id, name: group.name, icon: 'people-outline' as const }))];

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={styles.sheet}>
          <View style={styles.dragIndicator} />
          <Text style={styles.sheetTitle}>Assign Receipt</Text>
          {isLoading ? (
            <ActivityIndicator size="large" color={theme.colors.accent} style={styles.loader} />
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
              <Text style={styles.sectionHeader}>Choose a ledger</Text>
              <View style={styles.card}>
                {options.map((option, index) => (
                  <View key={option.id ?? 'personal'}>
                    {index > 0 ? <View style={styles.divider} /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={option.name}
                      onPress={() => handleSelect(option.id)}
                      style={({ pressed }) => [styles.optionRow, pressed && styles.optionPressed]}
                    >
                      <View style={styles.iconWrap}>
                        <Ionicons name={option.icon} size={18} color={theme.colors.accent} />
                      </View>
                      <Text style={styles.optionText} numberOfLines={1}>{option.name}</Text>
                      <Ionicons name="chevron-forward" size={16} color={theme.colors.textMuted} />
                    </Pressable>
                  </View>
                ))}
              </View>
              {groups.length === 0 ? <Text style={styles.emptyText}>You haven&apos;t created any groups yet.</Text> : null}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.scrim },
  sheet: {
    backgroundColor: theme.colors.canvas,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    maxHeight: '80%',
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  dragIndicator: {
    width: 36,
    height: 4,
    backgroundColor: theme.colors.borderStrong,
    borderRadius: theme.radius.full,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 18,
  },
  sheetTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.4, color: theme.colors.textPrimary, marginBottom: 16 },
  loader: { marginVertical: 40 },
  scrollContent: { paddingBottom: 12 },
  sectionHeader: { ...theme.typography.sectionLabel, color: theme.colors.textMuted, marginBottom: 8, marginLeft: 4 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 66, backgroundColor: theme.colors.border },
  optionRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14 },
  optionPressed: { backgroundColor: theme.colors.surfaceElevated },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionText: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 8, fontSize: 16, fontWeight: '600', color: theme.colors.textPrimary },
  emptyText: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 16 },
});
