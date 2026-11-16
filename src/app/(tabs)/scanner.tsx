import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useFocusEffect, useIsFocused } from 'expo-router';
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
import { parseReceiptImage } from '@/lib/parse-receipt';

export default function ScannerScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraView>(null);
  const hasAskedRef = useRef(false);
  const [didRequest, setDidRequest] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      return () => {
        setCameraReady(false);
        setCapturing(false);
        setProcessing(false);
        setError(null);
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
    setError(null);

    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5 });
      const image = photo?.base64 ?? photo?.uri;
      if (!photo?.uri || !image) {
        return;
      }

      setProcessing(true);
      const receipt = await parseReceiptImage(image);
      router.navigate({
        pathname: '/split',
        params: {
          imageUri: photo.uri,
          receipt: JSON.stringify(receipt),
        },
      });
    } catch (caught) {
      console.error(caught);
      setProcessing(false);
      setError(caught instanceof Error ? caught.message : "Couldn't read this receipt.");
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Snap Receipt"
          accessibilityState={{ disabled: !cameraReady || capturing, busy: capturing }}
          disabled={!cameraReady || capturing || processing}
          onPress={() => {
            void snapReceipt();
          }}
          style={({ pressed }) => [
            styles.button,
            (!cameraReady || capturing || processing) && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}>
          <Text style={styles.buttonLabel}>{capturing ? 'Snapping…' : 'Snap Receipt'}</Text>
        </Pressable>
      </View>
      {processing || error ? (
        <View accessibilityLiveRegion="polite" accessibilityRole="progressbar" style={styles.processing}>
          {processing ? <ActivityIndicator color={Colors.accent} size="large" /> : null}
          <Text style={processing ? styles.processingLabel : styles.errorLabel}>
            {processing ? 'Processing...' : error}
          </Text>
          {error ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setError(null)}
              style={({ pressed }) => [styles.button, styles.retryButton, pressed && styles.buttonPressed]}>
              <Text style={styles.buttonLabel}>Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
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
  processing: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(9, 9, 11, 0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    zIndex: 2,
  },
  processingLabel: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  errorLabel: {
    color: Colors.text,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: Spacing.four,
  },
  retryButton: {
    alignSelf: 'center',
    marginTop: Spacing.two,
    minWidth: 180,
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
