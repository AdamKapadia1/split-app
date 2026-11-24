import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '@/lib/supabase';
import { theme } from '@/theme/theme';
import { readSafeErrorCode } from '@/utils/errorMapper';
import { logger } from '@/utils/logger';
import { isValidGroupUuid } from '@/utils/receiptHistory';

export type BillDestination = {
  id: string | null;
  name: string;
};

export type DestinationGroup = {
  id: string;
  name: string;
  memberCount: number;
};

export const PERSONAL_DESTINATION: BillDestination = { id: null, name: 'Personal' };

type DestinationOptionsProps = {
  selectedId: string | null;
  groups: readonly DestinationGroup[];
  loading: boolean;
  onSelect: (destination: BillDestination) => void;
};

export function DestinationOptions({ selectedId, groups, loading, onSelect }: DestinationOptionsProps) {
  return (
    <View style={styles.list}>
      <DestinationRow
        label="Personal"
        detail="Only you"
        selected={selectedId === null}
        onPress={() => onSelect(PERSONAL_DESTINATION)}
      />
      {loading && groups.length === 0 ? (
        <ActivityIndicator color={theme.colors.textSecondary} style={styles.loader} />
      ) : null}
      {groups.map((group) => (
        <DestinationRow
          key={group.id}
          label={group.name}
          detail={memberLabel(group.memberCount)}
          selected={selectedId === group.id}
          onPress={() => onSelect({ id: group.id, name: group.name })}
        />
      ))}
    </View>
  );
}

export function DestinationSheet({
  visible,
  selectedId,
  groups,
  loading,
  onSelect,
  onClose,
}: DestinationOptionsProps & { visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss destination" onPress={onClose} style={StyleSheet.absoluteFill} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>Destination</Text>
          <Text style={styles.subtitle}>The next scan, photo, or manual bill goes here.</Text>
          <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
            <DestinationOptions selectedId={selectedId} groups={groups} loading={loading} onSelect={onSelect} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export async function loadDestinationGroups(): Promise<DestinationGroup[]> {
  if (!supabase) return [];
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.id) return [];

    const counted = await supabase
      .from('groups')
      .select('id, name, group_members(count)')
      .order('name', { ascending: true });
    if (!counted.error) return parseGroups(counted.data);

    const listed = await supabase
      .from('groups')
      .select('id, name, group_members(user_id)')
      .order('name', { ascending: true });
    if (listed.error) {
      logger.error('scan', { code: readSafeErrorCode(listed.error, 'GROUPS_FAILED') });
      return [];
    }
    return parseGroups(listed.data);
  } catch (error) {
    logger.error('scan', { code: readSafeErrorCode(error, 'GROUPS_FAILED') });
    return [];
  }
}

function DestinationRow({
  label,
  detail,
  selected,
  onPress,
}: {
  label: string;
  detail: string | null;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, selected && styles.rowSelected]}
    >
      <View style={styles.copy}>
        <Text style={styles.label} numberOfLines={1}>{label}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      {selected ? <Ionicons name="checkmark" size={18} color={theme.colors.accent} /> : <View style={styles.checkSpace} />}
    </Pressable>
  );
}

function memberLabel(count: number): string | null {
  if (!Number.isInteger(count) || count < 1) return null;
  return count === 1 ? '1 member' : `${count} members`;
}

function parseGroups(data: unknown): DestinationGroup[] {
  if (!Array.isArray(data)) return [];
  const groups: DestinationGroup[] = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const record = row as { id?: unknown; name?: unknown; group_members?: unknown };
    if (typeof record.id !== 'string' || typeof record.name !== 'string') continue;
    const id = record.id.trim();
    const name = record.name.trim();
    if (!isValidGroupUuid(id) || !name) continue;
    groups.push({ id, name: name.slice(0, 80), memberCount: readCount(record.group_members) });
  }
  groups.sort((left, right) => left.name.localeCompare(right.name));
  return groups;
}

function readCount(value: unknown): number {
  if (Array.isArray(value)) {
    const first = value[0];
    if (first && typeof first === 'object' && 'count' in first) {
      return finiteCount((first as { count: unknown }).count);
    }
    return value.length;
  }
  if (value && typeof value === 'object' && 'count' in value) {
    return finiteCount((value as { count: unknown }).count);
  }
  return 0;
}

function finiteCount(value: unknown): number {
  const count = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.round(count);
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: theme.colors.scrim,
  },
  sheet: {
    maxHeight: '78%',
    paddingHorizontal: 20,
    paddingBottom: 28,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#141417',
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    marginTop: 10,
    marginBottom: 16,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  subtitle: {
    marginTop: 6,
    marginBottom: 16,
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  list: {
    gap: 8,
    paddingBottom: 8,
  },
  loader: {
    marginVertical: 16,
  },
  row: {
    minHeight: 58,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowPressed: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  rowSelected: {
    borderColor: theme.colors.accentBorder,
    backgroundColor: theme.colors.accentSubtle,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  detail: {
    marginTop: 2,
    color: theme.colors.textSecondary,
    fontSize: 13,
  },
  checkSpace: {
    width: 18,
    height: 18,
  },
});
