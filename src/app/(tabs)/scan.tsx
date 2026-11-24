import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DestinationSheet, loadDestinationGroups, PERSONAL_DESTINATION, type BillDestination, type DestinationGroup } from '@/components/DestinationSheet';
import { VelorBrand } from '@/components/VelorBrand';
import { APP_NAME } from '@/constants/brand';
import { luxury } from '@/constants/theme';
import { ManualBillModal } from '@/components/ManualBillModal';
import { ensureAiScanConsent } from '@/lib/aiConsent';
import { supabase } from '@/lib/supabase';
import { uploadReceiptImage } from '@/services/ReceiptImageService';
import { receiptService } from '@/services/ReceiptService';
import { formatScanLimitMessage, ReceiptScanError, VisionService, type ScannedReceipt } from '@/services/VisionService';
import { theme } from '@/theme/theme';
import { mapErrorToUserMessage, readSafeErrorCode } from '@/utils/errorMapper';
import { hapticImpactLight, hapticImpactMedium, hapticSelection, hapticSuccess, hapticWarning } from '@/utils/haptics';
import { logger } from '@/utils/logger';
import { RECEIPT_IMAGE_JPEG_QUALITY, RECEIPT_IMAGE_MAX_WIDTH } from '@/utils/receiptImage';
import { isValidGroupUuid } from '@/utils/receiptHistory';

type CaptureJob = {
  uri: string;
  base64: string;
  groupId: string | null;
  receiptId: string | null;
  uploaded: boolean;
  parsed: ScannedReceipt | null;
  itemsSaved: boolean;
};

type Phase = 'idle' | 'uploading' | 'reading' | 'error';

export default function ScanScreen() {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ groupId?: string | string[]; groupName?: string | string[] }>();
  const routeGroupId = firstParam(params.groupId);
  const routeGroupName = firstParam(params.groupName);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const jobRef = useRef<CaptureJob | null>(null);
  const busyRef = useRef(false);
  const destinationRef = useRef<string | null>(null);

  const [destination, setDestination] = useState<BillDestination>(PERSONAL_DESTINATION);
  const [groups, setGroups] = useState<DestinationGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualSession, setManualSession] = useState(0);
  const [focusSeen, setFocusSeen] = useState(isFocused);
  const [appliedRoute, setAppliedRoute] = useState<string | null>(null);
  const [groupsRequested, setGroupsRequested] = useState(false);

  if (focusSeen !== isFocused) {
    setFocusSeen(isFocused);
    if (!isFocused) setTorchEnabled(false);
  }

  const routed = routeBillDestination(routeGroupId, routeGroupName);
  if (routed && routed.key !== appliedRoute) {
    setAppliedRoute(routed.key);
    setDestination(routed.destination);
  }

  const matchedGroup = destination.id ? groups.find((group) => group.id === destination.id) : undefined;
  const activeDestination: BillDestination = matchedGroup
    ? { id: matchedGroup.id, name: matchedGroup.name }
    : destination;
  const shouldLoadGroups = isFocused || destinationOpen || manualOpen;
  if (shouldLoadGroups && !groupsRequested) {
    setGroupsRequested(true);
    setGroupsLoading(true);
  }

  const processing = phase === 'uploading' || phase === 'reading';
  const locked = busy || processing;
  const askForCamera = permission?.status === 'undetermined' && permission.canAskAgain;

  useEffect(() => {
    destinationRef.current = activeDestination.id;
  }, [activeDestination.id]);

  useEffect(() => {
    if (!shouldLoadGroups) return;
    let cancelled = false;
    void loadDestinationGroups()
      .then((next) => {
        if (!cancelled) setGroups(next);
      })
      .finally(() => {
        if (!cancelled) setGroupsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [destinationOpen, manualOpen, shouldLoadGroups]);

  function chooseDestination(next: BillDestination) {
    hapticSelection();
    setDestination(next.id && isValidGroupUuid(next.id) ? next : PERSONAL_DESTINATION);
    setDestinationOpen(false);
  }

  function openDestination() {
    if (locked) return;
    hapticSelection();
    setDestinationOpen(true);
  }

  function openManual() {
    if (locked) return;
    hapticSelection();
    setManualSession((session) => session + 1);
    setManualOpen(true);
  }

  async function allowCamera() {
    hapticSelection();
    await requestPermission();
  }

  function openSettings() {
    hapticSelection();
    void Linking.openSettings();
  }

  async function takePicture() {
    if (locked || !cameraRef.current) return;
    hapticImpactMedium();
    await withBusy(async () => {
      let photo: { uri?: string; base64?: string } | undefined;
      try {
        photo = await cameraRef.current?.takePictureAsync({
          base64: true,
          quality: 0.5,
          exif: false,
        });
      } catch {
        photo = undefined;
      }
      setTorchEnabled(false);
      if (!photo?.uri || !photo.base64) {
        logger.error('scan', { code: 'CAPTURE_FAILED' });
        hapticWarning();
        jobRef.current = null;
        setPreviewUri(null);
        setPhase('error');
        setErrorMessage('Could not take the photo. Please try again.');
        return;
      }
      await runPipeline(freshJob(photo.uri, photo.base64, destinationRef.current));
    });
  }

  async function importFromPhotos() {
    if (locked) return;
    hapticSelection();
    await withBusy(async () => {
      let uri: string | undefined;
      let base64: string | undefined;
      try {
        const picked = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 0.9,
        });
        if (picked.canceled) return;
        uri = picked.assets[0]?.uri;
        if (!uri) throw new Error('Could not read the photo.');
        base64 = await readReceiptBase64(uri);
      } catch {
        logger.error('scan', { code: 'IMPORT_FAILED' });
        hapticWarning();
        jobRef.current = null;
        setPreviewUri(null);
        setPhase('error');
        setErrorMessage('Could not import that photo. Please try again.');
        return;
      }
      if (!uri || !base64) return;
      await runPipeline(freshJob(uri, base64, destinationRef.current));
    });
  }

  function retryScan() {
    if (locked) return;
    const job = jobRef.current;
    hapticSelection();
    if (!job) {
      setPhase('idle');
      setErrorMessage(null);
      return;
    }
    void withBusy(() => runPipeline({ ...job }));
  }

  async function withBusy(task: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await task();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function runPipeline(start: CaptureJob) {
    const job: CaptureJob = { ...start };
    jobRef.current = job;
    setPreviewUri(job.uri);
    setErrorMessage(null);
    setPhase('uploading');
    setTorchEnabled(false);

    let stage: 'create_receipt' | 'upload_image' | 'parse' | 'save_items' | 'save_totals' = 'create_receipt';
    try {
      if (!(await ensureAiScanConsent())) {
        clearCapture();
        return;
      }
      if (!supabase) throw new Error('Please sign in again.');
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) throw new Error('Please sign in again.');

      if (!job.receiptId) {
        stage = 'create_receipt';
        const created = await receiptService.createEmptyReceipt(userId, job.groupId);
        job.receiptId = created.id;
        jobRef.current = job;
      }

      if (!job.uploaded) {
        stage = 'upload_image';
        const imagePath = await uploadReceiptImage(userId, job.receiptId, job.uri);
        await receiptService.setReceiptImagePath(job.receiptId, imagePath);
        job.uploaded = true;
        jobRef.current = job;
      }

      setPhase('reading');
      if (!job.parsed) {
        stage = 'parse';
        job.parsed = await VisionService.analyzeReceipt(job.base64);
        jobRef.current = job;
      }
      const parsed = job.parsed;
      if (!parsed) throw new Error('Could not read the line items. Please try again.');

      if (!job.itemsSaved && parsed.items.length > 0) {
        stage = 'save_items';
        await receiptService.addScannedItems(
          job.receiptId,
          parsed.items.map((item) => ({
            original_name: item.name,
            display_name: item.name,
            price: item.price,
            quantity: 1,
            is_tax_exempt: false,
          })),
        );
        job.itemsSaved = true;
        jobRef.current = job;
      }

      stage = 'save_totals';
      await receiptService.updateReceiptTotals(job.receiptId, {
        merchant_name: parsed.merchant_name,
        subtotal: parsed.subtotal,
        tax_amount: parsed.tax,
        total_amount: parsed.total,
        status: 'open',
      });

      const receiptId = job.receiptId;
      clearCapture();
      hapticSuccess();
      router.push({ pathname: '/receipt/[id]', params: { id: receiptId } });
    } catch (error) {
      logger.error('scan', {
        stage,
        code: error instanceof ReceiptScanError ? error.code : readSafeErrorCode(error, 'PARSE_FAILED'),
      });
      hapticWarning();
      jobRef.current = job;
      setPhase('error');
      setErrorMessage(scanFailureMessage(error));
    }
  }

  function clearCapture() {
    jobRef.current = null;
    setPreviewUri(null);
    setPhase('idle');
    setErrorMessage(null);
    setTorchEnabled(false);
  }

  const cameraReady = Boolean(permission?.granted);
  const showPermissionCard = Boolean(permission && !permission.granted && !previewUri && phase === 'idle');
  const stageLabel = phase === 'reading' ? 'Reading items & totals...' : 'Uploading receipt...';

  return (
    <View style={styles.screen}>
      {cameraReady ? (
        <CameraView
          ref={cameraRef}
          facing="back"
          active={isFocused && previewUri === null}
          enableTorch={isFocused && torchEnabled}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View style={styles.backdrop} />
      )}

      {previewUri ? <Image source={{ uri: previewUri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
      {cameraReady && !previewUri ? (
        <>
          <ViewfinderVignette />
          <Viewfinder />
        </>
      ) : null}

      {phase !== 'idle' ? (
        <View style={styles.overlay}>
          <View style={styles.statusCard}>
            {phase === 'error' ? (
              <>
                <Ionicons name="alert-circle-outline" size={28} color={theme.colors.danger} />
                <Text style={styles.statusTitle}>Couldn&apos;t read that receipt</Text>
                <Text style={styles.statusBody}>{errorMessage ?? 'Check the connection and try again.'}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Retry" onPress={retryScan} style={styles.primaryButton}>
                  <Text style={styles.primaryLabel}>Retry</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Enter manually" onPress={openManual} style={styles.secondaryButton}>
                  <Text style={styles.secondaryLabel}>Enter Manually</Text>
                </Pressable>
              </>
            ) : (
              <>
                <ActivityIndicator color={theme.colors.textPrimary} size="large" />
                <Text style={styles.statusTitle}>{stageLabel}</Text>
              </>
            )}
          </View>
        </View>
      ) : null}

      <LinearGradient
        pointerEvents="none"
        colors={['rgba(0,0,0,0.65)', 'rgba(0,0,0,0)']}
        style={[styles.topScrim, { height: insets.top + 96 }]}
      />
      <View pointerEvents={locked ? 'none' : 'auto'} style={[styles.topBar, { top: insets.top + 8 }]}>
        <VelorBrand variant="header" />
        <View style={styles.topActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Destination, ${activeDestination.name}`}
            onPress={openDestination}
            style={({ pressed }) => [styles.glassButton, pressed && styles.pressed]}
          >
            <Ionicons name="people-outline" size={16} color="#FFFFFF" />
          </Pressable>
          {cameraReady ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={torchEnabled ? 'Turn torch off' : 'Turn torch on'}
              accessibilityState={{ selected: torchEnabled }}
              onPress={() => {
                if (locked) return;
                hapticSelection();
                setTorchEnabled((enabled) => !enabled);
              }}
              style={({ pressed }) => [styles.glassButton, torchEnabled && styles.torchOn, pressed && styles.pressed]}
            >
              <Ionicons name={torchEnabled ? 'flash' : 'flash-off'} size={16} color={torchEnabled ? '#F59E0B' : '#FFFFFF'} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Destination, ${activeDestination.name}`}
        onPress={openDestination}
        style={[styles.destinationChip, { top: insets.top + 74 }]}
      >
        <Text style={styles.destinationText} numberOfLines={1}>{activeDestination.name}</Text>
      </Pressable>

      {!permission ? <ActivityIndicator color={theme.colors.textPrimary} style={styles.centered} /> : null}

      {showPermissionCard ? (
        <View style={styles.permissionWrap}>
          <View style={styles.permissionCard}>
            <VelorBrand variant="watermark" />
            <Text style={styles.permissionTitle}>{askForCamera ? 'Camera access' : 'Camera access is off'}</Text>
            <Text style={styles.permissionBody}>
              {askForCamera
                ? `${APP_NAME} uses your camera to scan itemised receipts accurately.`
                : 'Camera access is turned off, so a live scan is unavailable. Turn it on in Settings, import a photo, or enter the bill by hand.'}
            </Text>
            {askForCamera ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Enable Camera" onPress={() => { hapticImpactLight(); void allowCamera(); }} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}>
                <LinearGradient colors={['#9AA3FF', '#7C86FF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.primaryFill}>
                  <Text style={styles.primaryLabel}>Enable Camera</Text>
                </LinearGradient>
              </Pressable>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel="Open Settings" onPress={openSettings} style={styles.primaryButton}>
                <Text style={styles.primaryLabel}>Open Settings</Text>
              </Pressable>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel="Import from Photos" onPress={() => { void importFromPhotos(); }} style={styles.secondaryButton}>
              <Text style={styles.secondaryLabel}>Import from Photos</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Enter manually" onPress={openManual} style={styles.secondaryButton}>
              <Text style={styles.secondaryLabel}>Enter Manually</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {cameraReady ? (
        <View pointerEvents={locked ? 'none' : 'auto'} style={[styles.bottomWrap, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.controls}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Photos"
              accessibilityState={{ disabled: locked }}
              disabled={locked}
              onPress={() => { void importFromPhotos(); }}
              style={({ pressed }) => [styles.sideButton, pressed && styles.pressed, locked && styles.locked]}
            >
              <Ionicons name="images-outline" size={20} color="#FFFFFF" />
              <Text style={styles.sideLabel}>Photos</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Shutter"
              accessibilityState={{ disabled: locked, busy: locked }}
              disabled={locked}
              onPress={() => { void takePicture(); }}
              style={({ pressed }) => [styles.shutterOuter, pressed && !locked && styles.shutterPressed, locked && styles.locked]}
            >
              <View style={styles.shutterInner} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Manual"
              accessibilityState={{ disabled: locked }}
              disabled={locked}
              onPress={openManual}
              style={({ pressed }) => [styles.sideButton, pressed && styles.pressed, locked && styles.locked]}
            >
              <Ionicons name="create-outline" size={22} color="#FFFFFF" />
              <Text style={styles.sideLabel}>Manual</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <DestinationSheet
        visible={destinationOpen}
        selectedId={activeDestination.id}
        groups={groups}
        loading={groupsLoading}
        onSelect={chooseDestination}
        onClose={() => setDestinationOpen(false)}
      />
      <ManualBillModal
        key={manualSession}
        visible={manualOpen}
        destination={activeDestination}
        groups={groups}
        groupsLoading={groupsLoading}
        onDestinationChange={setDestination}
        onClose={() => setManualOpen(false)}
        onCreated={(receiptId) => {
          setManualOpen(false);
          clearCapture();
          router.push({ pathname: '/receipt/[id]', params: { id: receiptId } });
        }}
      />
    </View>
  );
}

function ViewfinderVignette() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient colors={['rgba(5,6,9,0.72)', 'rgba(5,6,9,0)']} style={styles.vignetteTop} />
      <LinearGradient colors={['rgba(5,6,9,0)', 'rgba(5,6,9,0.78)']} style={styles.vignetteBottom} />
    </View>
  );
}

function Viewfinder() {
  return (
    <View pointerEvents="none" style={styles.viewfinderWrap}>
      <View style={styles.frame}>
        <View style={[styles.corner, styles.cornerTL]} />
        <View style={[styles.corner, styles.cornerTR]} />
        <View style={[styles.corner, styles.cornerBL]} />
        <View style={[styles.corner, styles.cornerBR]} />
      </View>
      <View style={styles.hint}>
        <Text style={styles.hintText}>Align receipt within frame</Text>
      </View>
    </View>
  );
}

function routeBillDestination(groupId: string | undefined, groupName: string | undefined) {
  if (!groupId || !isValidGroupUuid(groupId)) return null;
  const name = groupName?.trim();
  return {
    key: `${groupId}:${name ?? ''}`,
    destination: { id: groupId, name: name ? name.slice(0, 80) : 'Group' } satisfies BillDestination,
  };
}

function freshJob(uri: string, base64: string, groupId: string | null): CaptureJob {
  return {
    uri,
    base64,
    groupId: groupId && isValidGroupUuid(groupId) ? groupId : null,
    receiptId: null,
    uploaded: false,
    parsed: null,
    itemsSaved: false,
  };
}

async function readReceiptBase64(uri: string): Promise<string> {
  const saved = await manipulateAsync(
    uri,
    [{ resize: { width: RECEIPT_IMAGE_MAX_WIDTH } }],
    { compress: RECEIPT_IMAGE_JPEG_QUALITY, format: SaveFormat.JPEG, base64: true },
  );
  if (!saved.base64) throw new Error('Could not read the photo.');
  return saved.base64;
}

function scanFailureMessage(error: unknown): string {
  if (error instanceof ReceiptScanError && error.code === 'RATE_LIMITED' && error.retryAfterSeconds !== null) {
    return formatScanLimitMessage(error.retryAfterSeconds);
  }
  return mapErrorToUserMessage(error, 'Could not read the line items. Please try again.');
}

function firstParam(value: string | string[] | undefined) {
  const picked = Array.isArray(value) ? value[0] : value;
  const trimmed = picked?.trim();
  return trimmed ? trimmed : undefined;
}

const CORNER = 24;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000000',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: luxury.bgCanvas,
  },
  topScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  topBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    minHeight: 56,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: 'rgba(5, 6, 9, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  destinationChip: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '70%',
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(5,6,9,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  destinationText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  glassButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  torchOn: {
    backgroundColor: 'rgba(245,158,11,0.22)',
    borderColor: '#F59E0B',
  },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.92 },
  viewfinderWrap: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 96,
  },
  frame: {
    width: '78%',
    height: '58%',
  },
  vignetteTop: { position: 'absolute', top: 0, left: 0, right: 0, height: '28%' },
  vignetteBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '34%' },
  hint: {
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(5,6,9,0.62)',
  },
  hintText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '500',
  },
  corner: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    borderColor: luxury.accentPrimary,
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 2.5,
    borderLeftWidth: 2.5,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 2.5,
    borderRightWidth: 2.5,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 2.5,
    borderLeftWidth: 2.5,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 2.5,
    borderRightWidth: 2.5,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    backgroundColor: 'rgba(10,10,14,0.82)',
  },
  statusCard: {
    width: '100%',
    maxWidth: 340,
    paddingHorizontal: 22,
    paddingVertical: 24,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#141417',
    alignItems: 'center',
  },
  statusTitle: {
    marginTop: 14,
    color: theme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  statusBody: {
    marginTop: 8,
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  centered: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionWrap: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  permissionCard: {
    paddingHorizontal: 22,
    paddingVertical: 24,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: luxury.borderSubtle,
    borderTopColor: luxury.borderHighlight,
    backgroundColor: luxury.bgElevated,
    alignItems: 'center',
  },
  permissionTitle: {
    marginTop: 12,
    color: theme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  permissionBody: {
    marginTop: 8,
    marginBottom: 8,
    color: theme.colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  primaryButton: {
    alignSelf: 'stretch',
    minHeight: 48,
    marginTop: 14,
    borderRadius: 16,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: luxury.accentPrimary,
    shadowColor: '#8B95FF',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  primaryFill: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryLabel: {
    color: '#050609',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    alignSelf: 'stretch',
    minHeight: 44,
    marginTop: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryLabel: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  bottomWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(5, 6, 9, 0.85)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.10)',
  },
  controls: {
    paddingTop: 16,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sideButton: {
    minWidth: 76,
    minHeight: 64,
    paddingHorizontal: 12,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  sideLabel: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  shutterOuter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: luxury.accentPrimary,
  },
  shutterPressed: {
    transform: [{ scale: 0.92 }],
  },
  locked: {
    opacity: 0.4,
  },
});
