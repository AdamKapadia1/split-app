import { BlurView } from 'expo-blur';
import type { BlurViewProps } from 'expo-blur';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors, Spacing } from '@/constants/theme';
import { theme } from '@/theme/theme';
import { successHaptic, tickHaptic } from '@/lib/haptics';
import { useHoldScale } from '@/lib/use-snap-scale';

const BANKS = [
  {
    id: 'monzo',
    name: 'Monzo',
    hint: 'Personal account',
    mask: '1234',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/11/Monzo_2016_logo.svg/330px-Monzo_2016_logo.svg.png',
  },
  {
    id: 'revolut',
    name: 'Revolut',
    hint: 'Personal account',
    mask: '4821',
    logo: 'https://cdn.simpleicons.org/revolut/0A0A0A',
  },
  {
    id: 'barclays',
    name: 'Barclays',
    hint: 'Current account',
    mask: '9090',
    logo: 'https://cdn.simpleicons.org/barclays/00AEEF',
  },
  {
    id: 'manual',
    name: 'Manual Bank Transfer',
    hint: 'Sort code and account',
    mask: '2210',
    logo: null,
  },
] as const;

export type PayoutBank = (typeof BANKS)[number];

type PayoutSetupProps = {
  visible: boolean;
  blurTarget?: BlurViewProps['blurTarget'];
  onClose: () => void;
  onConnected: (bank: PayoutBank) => void;
};

export function payoutRouteLabel(bank: Pick<PayoutBank, 'id' | 'name' | 'mask'>) {
  if (bank.id === 'manual') {
    return `Routing to your bank (•••• ${bank.mask})`;
  }

  return `Routing to ${bank.name} (•••• ${bank.mask})`;
}

export function PayoutSetup({ visible, blurTarget, onClose, onConnected }: PayoutSetupProps) {
  const insets = useSafeAreaInsets();
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function linkBank(bank: PayoutBank) {
    if (linkingId) {
      return;
    }

    tickHaptic();
    setLinkingId(bank.id);
    timer.current = setTimeout(() => {
      successHaptic();
      onConnected(bank);
    }, 1500);
  }

  return (
    <View
      accessibilityViewIsModal={visible}
      importantForAccessibility={visible ? 'yes' : 'no-hide-descendants'}
      pointerEvents={visible ? 'auto' : 'none'}
      style={styles.overlay}>
      {visible ? (
        <>
          <Animated.View entering={FadeIn.duration(280)} exiting={FadeOut.duration(240)} style={styles.backdrop}>
            <BlurView
              blurMethod="dimezisBlurViewSdk31Plus"
              blurTarget={blurTarget}
              intensity={42}
              tint="systemThickMaterialDark"
              style={styles.fill}>
              <Pressable
                accessibilityLabel="Dismiss payout setup"
                accessibilityRole="button"
                disabled={linkingId !== null}
                onPress={onClose}
                style={styles.fill}
              />
            </BlurView>
          </Animated.View>

          <Animated.View
            entering={SlideInDown.duration(460).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(320).easing(Easing.in(Easing.cubic))}
            style={styles.sheet}>
            <View style={[styles.sheetFill, { paddingBottom: Math.max(insets.bottom, Spacing.four) }]}>
              <View style={styles.handle} />
              <Text style={styles.title}>Where should the money go?</Text>
              <View style={styles.list}>
                {BANKS.map((bank) => (
                  <BankCard
                    key={bank.id}
                    bank={bank}
                    linking={linkingId === bank.id}
                    dimmed={linkingId !== null && linkingId !== bank.id}
                    onPress={() => linkBank(bank)}
                  />
                ))}
              </View>
            </View>
          </Animated.View>
        </>
      ) : null}
    </View>
  );
}

function BankLogo({ logo }: { logo: string | null }) {
  return (
    <View style={styles.logoWell}>
      {logo ? (
        <Image accessible={false} contentFit="contain" source={{ uri: logo }} style={styles.logo} />
      ) : (
        <SymbolView
          name={{ ios: 'building.columns.fill', android: 'account_balance', web: 'account_balance' }}
          size={20}
          tintColor={theme.colors.accentText}
        />
      )}
    </View>
  );
}

function BankCard({
  bank,
  linking,
  dimmed,
  onPress,
}: {
  bank: PayoutBank;
  linking: boolean;
  dimmed: boolean;
  onPress: () => void;
}) {
  const scaleStyle = useHoldScale(linking);

  return (
    <Animated.View style={[scaleStyle, dimmed && styles.dimmed]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={bank.name}
        accessibilityState={{ busy: linking, disabled: dimmed }}
        disabled={dimmed || linking}
        onPress={onPress}>
        <View style={styles.card}>
          <View style={[styles.cardBody, linking && styles.cardBodyDim]}>
            <BankLogo logo={bank.logo} />
            <View style={styles.copy}>
              <Text style={styles.name} numberOfLines={1}>
                {bank.name}
              </Text>
              <Text style={styles.hint} numberOfLines={1}>
                {bank.hint}
              </Text>
            </View>
          </View>
          {linking ? (
            <ActivityIndicator color={theme.colors.textPrimary} />
          ) : (
            <SymbolView
              name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
              size={16}
              tintColor={Colors.textSecondary}
            />
          )}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 30,
    justifyContent: 'flex-end',
  },
  fill: {
    flex: 1,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
  },
  sheetFill: {
    backgroundColor: theme.colors.surface,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    gap: Spacing.four,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.borderStrong,
  },
  title: {
    color: Colors.text,
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '700',
    letterSpacing: 1.8,
  },
  list: {
    gap: Spacing.two,
  },
  card: {
    minHeight: 76,
    borderRadius: 18,
    paddingHorizontal: Spacing.three,
    paddingVertical: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  cardBodyDim: {
    opacity: 0.4,
  },
  logoWell: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logo: {
    width: 28,
    height: 28,
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  name: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  hint: {
    color: Colors.textSecondary,
    fontSize: 13,
    letterSpacing: -0.1,
  },
  dimmed: {
    opacity: 0.4,
  },
});
