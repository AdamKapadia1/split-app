import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { DestinationOptions, type BillDestination, type DestinationGroup } from '@/components/DestinationSheet';
import { supabase } from '@/lib/supabase';
import { receiptService } from '@/services/ReceiptService';
import { theme } from '@/theme/theme';
import { mapErrorToUserMessage, readSafeErrorCode } from '@/utils/errorMapper';
import { hapticSelection, hapticSuccess, hapticWarning } from '@/utils/haptics';
import { logger } from '@/utils/logger';
import {
  manualBillLineItems,
  manualBillTotals,
  penceToPounds,
  validateManualBill,
  type ManualBillErrors,
  type ValidatedManualBill,
} from '@/utils/manualBill';
import { isValidGroupUuid } from '@/utils/receiptHistory';

type ItemRow = {
  key: string;
  name: string;
  amountInput: string;
};

type Draft = {
  signature: string;
  receiptId: string;
  itemsSaved: boolean;
};

type ManualBillModalProps = {
  visible: boolean;
  destination: BillDestination;
  groups: readonly DestinationGroup[];
  groupsLoading: boolean;
  onDestinationChange: (destination: BillDestination) => void;
  onClose: () => void;
  onCreated: (receiptId: string) => void;
};

export function ManualBillModal({
  visible,
  destination,
  groups,
  groupsLoading,
  onDestinationChange,
  onClose,
  onCreated,
}: ManualBillModalProps) {
  const [merchant, setMerchant] = useState('');
  const [totalInput, setTotalInput] = useState('');
  const [rows, setRows] = useState<ItemRow[]>([]);
  const [itemsOpen, setItemsOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [errors, setErrors] = useState<ManualBillErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rowKey = useRef(0);
  const draft = useRef<Draft | null>(null);

  function close() {
    if (saving) return;
    hapticSelection();
    onClose();
  }

  function toggleItems() {
    if (saving) return;
    hapticSelection();
    if (!itemsOpen && rows.length === 0) {
      rowKey.current += 1;
      setRows([{ key: `item-${rowKey.current}`, name: '', amountInput: '' }]);
    }
    setItemsOpen((open) => !open);
  }

  function addItem() {
    if (saving || rows.length >= 40) return;
    hapticSelection();
    rowKey.current += 1;
    setRows((current) => [...current, { key: `item-${rowKey.current}`, name: '', amountInput: '' }]);
  }

  async function createBill() {
    if (saving) return;
    const result = validateManualBill({
      merchantName: merchant,
      totalInput,
      items: rows.map((row) => ({ name: row.name, amountInput: row.amountInput })),
    });
    setErrors(result.errors);
    setSaveError(null);
    if (!result.ok || !result.bill) {
      hapticWarning();
      return;
    }

    setSaving(true);
    try {
      const receiptId = await saveManualBill(result.bill, destination, draft);
      draft.current = null;
      hapticSuccess();
      onCreated(receiptId);
    } catch (error) {
      logger.error('manual bill', { code: readSafeErrorCode(error, 'SAVE_FAILED') });
      hapticWarning();
      setSaveError(mapErrorToUserMessage(error, 'Could not save this bill. Please try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss manual bill" disabled={saving} onPress={close} style={styles.backdrop} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            {picking ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Back to bill" hitSlop={8} onPress={() => setPicking(false)} style={styles.headerButton}>
                <Ionicons name="chevron-back" size={18} color={theme.colors.textSecondary} />
              </Pressable>
            ) : <View style={styles.headerButton} />}
            <Text style={styles.title}>{picking ? 'Destination' : 'Enter a bill'}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close manual bill" disabled={saving} hitSlop={8} onPress={close} style={styles.headerButton}>
              <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
            </Pressable>
          </View>

          {picking ? (
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.picker}>
              <DestinationOptions
                selectedId={destination.id}
                groups={groups}
                loading={groupsLoading}
                onSelect={(next) => {
                  hapticSelection();
                  onDestinationChange(next);
                  setPicking(false);
                }}
              />
            </ScrollView>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.form}>
              <Text style={styles.label}>Merchant / description</Text>
              <TextInput
                value={merchant}
                onChangeText={setMerchant}
                placeholder="The Evil Eye"
                placeholderTextColor={theme.colors.textMuted}
                autoCapitalize="words"
                autoCorrect={false}
                editable={!saving}
                accessibilityLabel="Merchant or description"
                style={[styles.input, errors.merchantName && styles.inputError]}
              />
              {errors.merchantName ? <Text style={styles.fieldError}>{errors.merchantName}</Text> : null}

              <Text style={styles.label}>Total amount</Text>
              <View style={[styles.amountField, errors.total && styles.inputError]}>
                <Text style={styles.pound}>£</Text>
                <TextInput
                  value={totalInput}
                  onChangeText={setTotalInput}
                  placeholder="0.00"
                  placeholderTextColor={theme.colors.textMuted}
                  keyboardType="decimal-pad"
                  editable={!saving}
                  accessibilityLabel="Total amount in pounds"
                  style={styles.amountInput}
                />
              </View>
              {errors.total ? <Text style={styles.fieldError}>{errors.total}</Text> : null}

              <Text style={styles.label}>Destination</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Destination, ${destination.name}`}
                disabled={saving}
                onPress={() => {
                  hapticSelection();
                  setPicking(true);
                }}
                style={({ pressed }) => [styles.destination, pressed && styles.destinationPressed]}
              >
                <Text style={styles.destinationName} numberOfLines={1}>{destination.name}</Text>
                <Ionicons name="chevron-down" size={16} color={theme.colors.textSecondary} />
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add specific items"
                accessibilityState={{ expanded: itemsOpen }}
                disabled={saving}
                onPress={toggleItems}
                style={styles.addItems}
              >
                <Text style={styles.addItemsText}>{itemsOpen ? 'Hide specific items' : '+ Add specific items (optional)'}</Text>
              </Pressable>

              {itemsOpen ? (
                <View style={styles.items}>
                  {rows.map((row, index) => {
                    const rowError = errors.items?.[index];
                    return (
                      <View key={row.key} style={styles.item}>
                        <View style={styles.itemFields}>
                          <TextInput
                            value={row.name}
                            onChangeText={(name) => updateRow(setRows, row.key, { name })}
                            placeholder="Item"
                            placeholderTextColor={theme.colors.textMuted}
                            autoCorrect={false}
                            editable={!saving}
                            accessibilityLabel={`Item ${index + 1} name`}
                            style={[styles.input, styles.itemName, rowError?.name && styles.inputError]}
                          />
                          <View style={[styles.itemAmount, rowError?.amount && styles.inputError]}>
                            <Text style={styles.itemPound}>£</Text>
                            <TextInput
                              value={row.amountInput}
                              onChangeText={(amountInput) => updateRow(setRows, row.key, { amountInput })}
                              placeholder="0.00"
                              placeholderTextColor={theme.colors.textMuted}
                              keyboardType="decimal-pad"
                              editable={!saving}
                              accessibilityLabel={`Item ${index + 1} amount`}
                              style={styles.itemAmountInput}
                            />
                          </View>
                        </View>
                        {rowError?.name ? <Text style={styles.fieldError}>{rowError.name}</Text> : null}
                        {rowError?.amount ? <Text style={styles.fieldError}>{rowError.amount}</Text> : null}
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Remove item ${index + 1}`}
                          disabled={saving}
                          onPress={() => {
                            hapticSelection();
                            setRows((current) => current.filter((item) => item.key !== row.key));
                          }}
                          style={styles.remove}
                        >
                          <Text style={styles.removeText}>Remove</Text>
                        </Pressable>
                      </View>
                    );
                  })}
                  {errors.itemsTotal ? <Text style={styles.fieldError}>{errors.itemsTotal}</Text> : null}
                  <Pressable accessibilityRole="button" accessibilityLabel="Add another item" disabled={saving || rows.length >= 40} onPress={addItem} style={styles.addAnother}>
                    <Text style={styles.addItemsText}>Add another item</Text>
                  </Pressable>
                </View>
              ) : null}

              {saveError ? <Text style={styles.saveError}>{saveError}</Text> : null}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create bill"
                accessibilityState={{ disabled: saving, busy: saving }}
                disabled={saving}
                onPress={() => {
                  void createBill();
                }}
                style={({ pressed }) => [styles.create, pressed && styles.createPressed, saving && styles.createDisabled]}
              >
                {saving ? <ActivityIndicator color={theme.colors.accentText} /> : <Text style={styles.createText}>Create Bill</Text>}
              </Pressable>
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

async function saveManualBill(
  bill: ValidatedManualBill,
  destination: BillDestination,
  draft: { current: Draft | null },
): Promise<string> {
  if (!supabase) throw new Error('Please sign in again.');
  const { data: { session } } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error('Please sign in again.');

  const lines = manualBillLineItems(bill);
  const totals = manualBillTotals(bill);
  const groupId = destination.id && isValidGroupUuid(destination.id) ? destination.id : null;
  const signature = JSON.stringify({
    merchant: bill.merchantName,
    total: bill.totalPence,
    lines,
    groupId,
  });

  let current = draft.current;
  if (!current || current.signature !== signature) {
    const created = await receiptService.createEmptyReceipt(userId, groupId);
    current = { signature, receiptId: created.id, itemsSaved: false };
    draft.current = current;
  }

  if (!current.itemsSaved) {
    await receiptService.addScannedItems(
      current.receiptId,
      lines.map((line) => ({
        original_name: line.name,
        display_name: line.name,
        price: penceToPounds(line.amountPence),
        quantity: 1,
        is_tax_exempt: false,
      })),
    );
    current.itemsSaved = true;
    draft.current = current;
  }

  await receiptService.updateReceiptTotals(current.receiptId, {
    merchant_name: bill.merchantName,
    subtotal: penceToPounds(totals.subtotalPence),
    tax_amount: penceToPounds(totals.taxPence),
    total_amount: penceToPounds(totals.totalPence),
    status: 'open',
  });

  return current.receiptId;
}

function updateRow(setRows: (value: ItemRow[] | ((current: ItemRow[]) => ItemRow[])) => void, key: string, patch: Partial<ItemRow>) {
  setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.scrim,
  },
  sheet: {
    maxHeight: '92%',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#141417',
    paddingBottom: 20,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    marginTop: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  header: {
    minHeight: 48,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: theme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  form: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  picker: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  label: {
    marginTop: 16,
    marginBottom: 8,
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  input: {
    minHeight: 48,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#09090B',
    color: theme.colors.textPrimary,
    fontSize: 16,
  },
  inputError: {
    borderColor: theme.colors.dangerBorder,
  },
  amountField: {
    minHeight: 72,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#09090B',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pound: {
    color: theme.colors.textSecondary,
    fontSize: 28,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  amountInput: {
    flex: 1,
    minHeight: 64,
    color: theme.colors.textPrimary,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.8,
    fontVariant: ['tabular-nums'],
  },
  destination: {
    minHeight: 48,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#09090B',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  destinationPressed: {
    backgroundColor: '#111114',
  },
  destinationName: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  addItems: {
    marginTop: 18,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addItemsText: {
    color: theme.colors.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  addAnother: {
    alignSelf: 'flex-start',
    minHeight: 36,
    justifyContent: 'center',
  },
  items: {
    gap: 12,
  },
  item: {
    gap: 6,
  },
  itemFields: {
    flexDirection: 'row',
    gap: 8,
  },
  itemName: {
    flex: 1.4,
  },
  itemAmount: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#09090B',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  itemPound: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  itemAmountInput: {
    flex: 1,
    minHeight: 44,
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  remove: {
    alignSelf: 'flex-start',
    minHeight: 32,
    justifyContent: 'center',
  },
  removeText: {
    color: theme.colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  fieldError: {
    marginTop: 6,
    color: theme.colors.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  saveError: {
    marginTop: 16,
    color: theme.colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  create: {
    marginTop: 20,
    minHeight: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  createPressed: {
    backgroundColor: theme.colors.accentPressed,
  },
  createDisabled: {
    opacity: 0.7,
  },
  createText: {
    color: theme.colors.accentText,
    fontSize: 16,
    fontWeight: '700',
  },
});
