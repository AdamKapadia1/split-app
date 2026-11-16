import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors, Spacing } from '@/constants/theme';

export default function ScannerScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraView>(null);
  const hasAskedRef = useRef(false);
  const [didRequest, setDidRequest] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [snapped, setSnapped] = useState(false);

  useFocusEffect(
    useCallback(() => {
      return () => {
        setCameraReady(false);
        setSnapped(false);
      };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      if (!permission || permission.granted || hasAskedRef.current) {
        return;
      }

      if (!permission.canAskAgain) {
        setDidRequest(true);
        return;
      }

      hasAskedRef.current = true;
      void requestPermission().finally(() => {
        setDidRequest(true);
      });
    }, [permission, requestPermission]),
  );

  async function snapReceipt() {
    if (!cameraRef.current || !cameraReady || capturing) {
      return;
    }

    setCapturing(true);
    setSnapped(false);

    try {
      const photo = await cameraRef.current.takePictureAsync();
      setSnapped(Boolean(photo?.uri));
    } catch {
      setSnapped(false);
    } finally {
      setCapturing(false);
    }
  }

  if (!permission || (!permission.granted && permission.canAskAgain && !didRequest)) {
    return (
      <View style={styles.fallback}>
        <ActivityIndicator color={Colors.accent} />
      </View>
    );
  }

  if (!permission.granted) {
    const canAskAgain = permission.canAskAgain;

    return (
      <View style={styles.fallback}>
        <Text accessibilityRole="header" style={styles.title}>
          Camera access
        </Text>
        <Text style={styles.message}>
          {canAskAgain
            ? 'Allow camera access to scan a receipt.'
            : 'Camera access is off. Enable it in Settings to scan a receipt.'}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (canAskAgain) {
              void requestPermission();
              return;
            }
            void Linking.openSettings();
          }}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
          <Text style={styles.buttonLabel}>{canAskAgain ? 'Allow camera' : 'Open Settings'}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {isFocused ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          mode="picture"
          onCameraReady={() => setCameraReady(true)}
          onMountError={() => setCameraReady(false)}
        />
      ) : null}
      <View
        pointerEvents="box-none"
        style={[styles.footer, { paddingBottom: Math.max(insets.bottom, Spacing.three) + 72 }]}>
        {snapped ? (
          <Text accessibilityLiveRegion="polite" style={styles.status}>
            Receipt snapped
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Snap Receipt"
          accessibilityState={{ disabled: !cameraReady || capturing, busy: capturing }}
          disabled={!cameraReady || capturing}
          onPress={() => {
            void snapReceipt();
          }}
          style={({ pressed }) => [
            styles.button,
            (!cameraReady || capturing) && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}>
          <Text style={styles.buttonLabel}>{capturing ? 'Snapping…' : 'Snap Receipt'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  fallback: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.five,
    gap: Spacing.three,
  },
  title: {
    color: Colors.text,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  message: {
    color: Colors.textSecondary,
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    gap: Spacing.two,
  },
  status: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  button: {
    alignSelf: 'stretch',
    backgroundColor: Colors.accent,
    borderRadius: 999,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonLabel: {
    color: Colors.background,
    fontSize: 17,
    fontWeight: '700',
  },
});
