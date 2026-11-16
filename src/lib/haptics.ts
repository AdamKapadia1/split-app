import * as Haptics from 'expo-haptics';

function fire(task: Promise<unknown>) {
  void task.catch(() => undefined);
}

export function tickHaptic() {
  fire(Haptics.selectionAsync());
}

export function pulseHaptic() {
  fire(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

export function mediumHaptic() {
  fire(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

export function successHaptic() {
  fire(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));
  fire(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}
