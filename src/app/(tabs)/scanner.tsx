import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { GroupSelectorSheet } from '@/components/GroupSelectorSheet';
import { supabase } from '@/lib/supabase';

import { theme } from '@/theme/theme';
import { receiptService } from '../../services/ReceiptService';
import { ReceiptScanError, VisionService } from '../../services/VisionService';

export default function ScannerScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [pendingPhotoBase64, setPendingPhotoBase64] = useState<string | null>(null);
  const [isGroupSheetVisible, setGroupSheetVisible] = useState(false);

  const takePicture = async () => {
    if (!cameraRef.current || isCapturing) return;

    setIsCapturing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5 });
      if (!photo?.base64) {
        throw new Error('The camera did not return image data.');
      }
      setPendingPhotoBase64(photo.base64);
      setGroupSheetVisible(true);
    } catch (error) {
      console.error(error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Capture Failed', 'Could not take the photo. Please try again.');
    } finally {
      setIsCapturing(false);
    }
  };

  const processReceiptWithGroup = async (groupId: string | null) => {
    setGroupSheetVisible(false);
    if (!pendingPhotoBase64) return;

    setIsCapturing(true);
    try {
      if (!supabase) throw new Error('Not logged in');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.id) throw new Error('Not logged in');

      const newReceipt = await receiptService.createEmptyReceipt(session.user.id, groupId);
      const aiData = await VisionService.analyzeReceipt(pendingPhotoBase64);

      if (aiData.items.length > 0) {
        await receiptService.addScannedItems(
          newReceipt.id,
          aiData.items.map((item: { name: string; price: number }) => ({
            original_name: item.name,
            display_name: item.name,
            price: item.price,
            quantity: 1,
            is_tax_exempt: false,
          })),
        );
      }

      await receiptService.updateReceiptTotals(newReceipt.id, {
        merchant_name: aiData.merchant_name,
        subtotal: aiData.subtotal,
        tax_amount: aiData.tax,
        total_amount: aiData.total,
        status: 'open',
      });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.push(`/receipt/${newReceipt.id}`);
    } catch (error) {
      console.error(error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const message = error instanceof ReceiptScanError ? error.message : 'Could not read the line items. Please try again.';
      Alert.alert('Failed to parse receipt', message);
    } finally {
      setPendingPhotoBase64(null);
      setIsCapturing(false);
    }
  };

  if (!permission) {
    return <View style={styles.screen} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.denied}>
        <Text style={styles.title}>Camera Access Required</Text>
        <Text style={styles.subtitle}>Midnight needs your camera to scan and split receipts.</Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Grant Permission"
          activeOpacity={0.85}
          onPress={() => {
            void requestPermission();
          }}
          style={styles.permissionButton}>
          <Text style={styles.permissionLabel}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <CameraView ref={cameraRef} facing="back" style={StyleSheet.absoluteFill}>
        <View pointerEvents="none" style={styles.guideFrame}>
          <View style={styles.guide} />
        </View>
      </CameraView>

      <View style={styles.footer}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Shutter"
          accessibilityState={{ disabled: isCapturing, busy: isCapturing }}
          activeOpacity={0.85}
          disabled={isCapturing}
          onPress={() => {
            void takePicture();
          }}
          style={styles.shutterOuter}>
          {isCapturing ? (
            <ActivityIndicator color={theme.colors.accent} size="large" />
          ) : (
            <View style={styles.shutterInner} />
          )}
        </TouchableOpacity>
      </View>
      <GroupSelectorSheet
        visible={isGroupSheetVisible}
        onSelect={processReceiptWithGroup}
        onCancel={() => {
          setGroupSheetVisible(false);
          setPendingPhotoBase64(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.canvas,
  },
  denied: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: theme.colors.canvas,
  },
  title: {
    ...theme.typography.screenTitle,
    color: theme.colors.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 12,
    color: theme.colors.textSecondary,
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  permissionButton: {
    marginTop: 28,
    minHeight: 52,
    paddingHorizontal: 24,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  permissionLabel: {
    color: theme.colors.accentText,
    fontSize: 16,
    fontWeight: '700',
  },
  guideFrame: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 120,
  },
  guide: {
    width: '78%',
    height: '62%',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.textPrimary,
    borderRadius: theme.radius.lg,
  },
  footer: {
    position: 'absolute',
    bottom: 100,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.canvas,
    paddingTop: 20,
    paddingBottom: 20,
  },
  shutterOuter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 4,
    borderColor: theme.colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  shutterInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.colors.textPrimary,
  },
});
