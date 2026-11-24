import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

function canHaptic() {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

function fire(task: Promise<unknown>) {
  if (!canHaptic()) return;
  void task.catch(() => undefined);
}

/** Light tap for tab switches, filter pills, and toggles. */
export function hapticSelection() {
  fire(Haptics.selectionAsync());
}

/** Subtle impact for quick actions and card taps. */
export function hapticImpactLight() {
  fire(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** Confirmation after a nudge is sent or a payment is recorded. */
export function hapticSuccess() {
  fire(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** Cooldown, validation, or a failed action. */
export function hapticWarning() {
  fire(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}
