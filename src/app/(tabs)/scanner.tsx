import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { receiptService } from '../../services/ReceiptService';
import { supabase } from '../../lib/supabase';

export default function ScannerScreen() {
  const router = useRouter();
  const [isProcessing, setIsProcessing] = useState(false);

  async function handleMockScan() {
    if (!supabase) {
      Alert.alert('Authentication Error', 'You must be logged in to scan.');
      return;
    }

    const { data, error: authError } = await supabase.auth.getUser();
    const user = data.user;
    if (authError || !user) {
      Alert.alert('Authentication Error', 'You must be logged in to scan.');
      return;
    }

    setIsProcessing(true);

    try {
      const receipt = await receiptService.createEmptyReceipt(user.id);
      const mockItems = [
        {
          original_name: 'Artisan Ribeye',
          display_name: 'Artisan Ribeye',
          price: 45,
          quantity: 1,
          is_tax_exempt: false,
        },
        {
          original_name: 'Truffle Fries',
          display_name: 'Truffle Fries',
          price: 8.5,
          quantity: 1,
          is_tax_exempt: false,
        },
        {
          original_name: 'Old Fashioned',
          display_name: 'Old Fashioned',
          price: 14,
          quantity: 1,
          is_tax_exempt: false,
        },
      ];

      await receiptService.addScannedItems(receipt.id, mockItems);
      await receiptService.updateReceiptTotals(receipt.id, {
        subtotal: 67.5,
        tax_amount: 13.5,
        service_charge: 8.44,
        total_amount: 89.44,
        status: 'open',
      });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.push(`/receipt/${receipt.id}`);
    } catch (error) {
      console.error('[Scanner][handleMockScan] Pipeline failure:', error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Transaction Failed', 'Unable to sync receipt data.');
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <View style={styles.screen}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Snap Receipt"
        accessibilityState={{ disabled: isProcessing, busy: isProcessing }}
        disabled={isProcessing}
        onPress={() => {
          void handleMockScan();
        }}
        style={({ pressed }) => [styles.button, pressed && !isProcessing && styles.buttonPressed, isProcessing && styles.buttonDisabled]}>
        <Text style={styles.buttonLabel}>Snap Receipt</Text>
      </Pressable>

      {isProcessing ? (
        <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill}>
          <View style={styles.overlay}>
            <ActivityIndicator color="#38BDF8" size="large" />
            <Text style={styles.overlayLabel}>Securing ledger...</Text>
          </View>
        </BlurView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#0B0F19',
  },
  button: {
    width: '100%',
    maxWidth: 360,
    minHeight: 64,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#38BDF8',
  },
  buttonPressed: {
    opacity: 0.88,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonLabel: {
    color: '#030712',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  overlayLabel: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
});
