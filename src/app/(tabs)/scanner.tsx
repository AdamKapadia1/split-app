import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Frost } from '@/components/frost';
import { NightScreen } from '@/components/night-screen';
import { ScanLaser } from '@/components/scan-laser';
import { Skeleton } from '@/components/skeleton';
import { Colors, Spacing } from '@/constants/theme';
import { mediumHaptic } from '@/lib/haptics';
import { parseReceiptImage } from '@/lib/parse-receipt';

const ICE = '#38BDF8';
const NAVY = '#030712';

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
  const [frameUri, setFrameUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      return () => {
        setCameraReady(false);
        setCapturing(false);
        setProcessing(false);
        setFrameUri(null);
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

    mediumHaptic();
    setCapturing(true);
    setError(null);

    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5 });
      const image = photo?.base64 ?? photo?.uri;
      if (!photo?.uri || !image) {
        return;
      }

      setFrameUri(photo.uri);
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
      setFrameUri(null);
      setError(caught instanceof Error ? caught.message : "Couldn't read this receipt.");
    } finally {
      setCapturing(false);
    }
  }

  if (!permission || (!permission.granted && permission.canAskAgain && !didRequest)) {
    return (
      <NightScreen>
        <Animated.View entering={FadeIn.duration(280)} style={styles.fallback}>
          <ActivityIndicator color={ICE} />
        </Animated.View>
      </NightScreen>
    );
  }

  if (!permission.granted) {
    const canAskAgain = permission.canAskAgain;

    return (
      <NightScreen>
        <Animated.View entering={FadeIn.duration(320)} style={styles.fallback}>
          <Text accessibilityRole="header" style={styles.title}>
            Camera access
          </Text>
          <Text style={styles.message}>
            {canAskAgain
              ? 'Allow camera access to scan a receipt.'
              : 'Camera access is off. Enable it in Settings to scan a receipt.'}
          </Text>
          <GradientButton
            label={canAskAgain ? 'Allow camera' : 'Open Settings'}
            onPress={() => {
              mediumHaptic();
              if (canAskAgain) {
                void requestPermission();
                return;
              }
              void Linking.openSettings();
            }}
          />
        </Animated.View>
      </NightScreen>
    );
  }

  return (
    <NightScreen>
      {isFocused && !processing ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          mode="picture"
          onCameraReady={() => setCameraReady(true)}
          onMountError={() => setCameraReady(false)}
        />
      ) : null}
      {processing && frameUri ? (
        <Image accessibilityLabel="Receipt being scanned" contentFit="cover" source={{ uri: frameUri }} style={StyleSheet.absoluteFill} />
      ) : null}
      {capturing || processing ? (
        <View pointerEvents="none" style={styles.scanFrame}>
          <View style={styles.scanScrim} />
          <ScanLaser />
          {processing ? (
            <View style={styles.processingCopy}>
              <Text accessibilityLiveRegion="polite" style={styles.processingLabel}>
                Processing...
              </Text>
              <Frost style={styles.skeletonCard}>
                <Skeleton style={styles.skeletonWide} />
                <Skeleton style={styles.skeletonLine} />
                <Skeleton style={styles.skeletonShort} />
              </Frost>
            </View>
          ) : null}
        </View>
      ) : null}
      <View
        pointerEvents="box-none"
        style={[styles.footer, { paddingBottom: Math.max(insets.bottom, Spacing.three) + 72 }]}>
        <GradientButton
          label={capturing ? 'Snapping…' : 'Snap Receipt'}
          disabled={!cameraReady || capturing || processing}
          onPress={() => {
            void snapReceipt();
          }}
        />
      </View>
      {error ? (
        <Animated.View entering={FadeIn.duration(280)} accessibilityLiveRegion="polite" style={styles.processing}>
          <Text style={styles.errorLabel}>{error}</Text>
          <GradientButton
            label="Try again"
            onPress={() => {
              mediumHaptic();
              setError(null);
            }}
          />
        </Animated.View>
      ) : null}
    </NightScreen>
  );
}

function GradientButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: label === 'Snapping…' }}
      activeOpacity={0.85}
      disabled={disabled}
      onPress={onPress}
      style={[styles.sharePress, disabled && styles.buttonDisabled]}>
      <LinearGradient
        colors={['#7DD3FC', '#38BDF8']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.shareButton}>
        <Text style={styles.buttonLabel}>{label}</Text>
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  title: {
    color: Colors.text,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.8,
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
    zIndex: 3,
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    gap: Spacing.two,
  },
  scanFrame: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 2,
  },
  scanScrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(3, 7, 18, 0.28)',
  },
  processingCopy: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 168,
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  processing: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(3, 7, 18, 0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    zIndex: 4,
  },
  processingLabel: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  skeletonCard: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 24,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
    gap: Spacing.three,
  },
  skeletonWide: {
    width: '72%',
    height: 18,
  },
  skeletonLine: {
    width: '100%',
  },
  skeletonShort: {
    width: '46%',
  },
  errorLabel: {
    color: Colors.text,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: Spacing.four,
  },
  sharePress: {
    alignSelf: 'stretch',
    borderRadius: 999,
    shadowColor: ICE,
    shadowOpacity: 0.38,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  shareButton: {
    minHeight: 56,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonLabel: {
    color: NAVY,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
});
