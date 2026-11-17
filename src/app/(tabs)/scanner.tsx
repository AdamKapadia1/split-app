import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function ScannerScreen() {
  const [permission, requestPermission] = useCameraPermissions();

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
      <CameraView facing="back" style={StyleSheet.absoluteFill}>
        <View pointerEvents="none" style={styles.guideFrame}>
          <View style={styles.guide} />
        </View>
      </CameraView>

      <View style={styles.footer}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Shutter"
          activeOpacity={0.85}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          }}
          style={styles.shutterOuter}>
          <View style={styles.shutterInner} />
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
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    backgroundColor: 'rgba(11, 15, 25, 0.8)',
    paddingTop: 20,
    paddingBottom: 40,
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
