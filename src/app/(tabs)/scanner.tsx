import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function ScannerScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  async function handleCapture() {
    if (!cameraRef.current || isCapturing) {
      return;
    }

    setIsCapturing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5 });
      console.log('📸 Photo captured! Base64 length:', photo?.base64?.length);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error('Camera capture failed:', error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Capture Failed', 'Could not take the photo. Please try again.');
    } finally {
      setIsCapturing(false);
    }
  }

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
            void handleCapture();
          }}
          style={styles.shutterOuter}>
          {isCapturing ? (
            <ActivityIndicator color="#38BDF8" size="large" />
          ) : (
            <View style={styles.shutterInner} />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0B0F19',
  },
  denied: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: '#0B0F19',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -0.6,
  },
  subtitle: {
    marginTop: 12,
    color: '#94A3B8',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  permissionButton: {
    marginTop: 28,
    minHeight: 52,
    paddingHorizontal: 24,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#38BDF8',
  },
  permissionLabel: {
    color: '#FFFFFF',
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
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.5)',
    borderRadius: 18,
  },
  footer: {
    position: 'absolute',
    bottom: 100,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 15, 25, 0.8)',
    paddingTop: 20,
    paddingBottom: 20,
  },
  shutterOuter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 4,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  shutterInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#FFFFFF',
  },
});
