import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { GroupServiceError, groupService, type GroupMemberProfile } from '@/services/GroupService';

type AddMemberModalProps = {
  visible: boolean;
  groupId: string;
  existingMemberIds: string[];
  onMemberAdded: (member: GroupMemberProfile) => void;
  onClose: () => void;
};

const ERROR_COPY: Partial<Record<GroupServiceError['code'], string>> = {
  INVALID_EMAIL: 'Enter a valid email address.',
  NOT_FOUND: 'No account found for that email.',
  ALREADY_MEMBER: 'Already in this group.',
};

export function AddMemberModal({ visible, groupId, existingMemberIds, onMemberAdded, onClose }: AddMemberModalProps) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canSubmit = email.trim().length > 0 && !isSubmitting;

  useEffect(() => {
    if (!visible) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [visible]);

  function dismiss() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setEmail('');
    setError(null);
    onClose();
  }

  async function handleSubmit() {
    const trimmed = email.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const member = await groupService.addMemberByEmail(groupId, trimmed);
      if (existingMemberIds.includes(member.userId)) {
        setError(ERROR_COPY.ALREADY_MEMBER ?? 'Already in this group.');
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onMemberAdded(member);
      setEmail('');
      setError(null);
      onClose();
    } catch (caught) {
      const code = caught instanceof GroupServiceError ? caught.code : 'NETWORK_ERROR';
      setError(ERROR_COPY[code] ?? 'Could not add this member. Try again.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent onRequestClose={dismiss}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.overlay}>
        <BlurView intensity={50} tint="dark" style={StyleSheet.absoluteFill} />
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={dismiss} />

        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>Add Member</Text>
              <Text style={styles.subtitle}>Enter the email linked to their account.</Text>
            </View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close" onPress={dismiss} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close-circle" size={28} color="#64748B" />
            </TouchableOpacity>
          </View>

          <TextInput
            value={email}
            onChangeText={(value) => {
              setEmail(value);
              if (error) setError(null);
            }}
            placeholder="name@email.com"
            placeholderTextColor="#64748B"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            returnKeyType="done"
            onSubmitEditing={() => {
              void handleSubmit();
            }}
            selectionColor="#38BDF8"
            style={styles.input}
          />

          {error ? (
            <Animated.View key={error} entering={FadeIn.duration(180)} style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </Animated.View>
          ) : null}

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Add to Group"
            disabled={!canSubmit}
            activeOpacity={0.9}
            onPress={() => {
              void handleSubmit();
            }}
            style={[styles.buttonWrap, !canSubmit && styles.buttonDisabled]}
          >
            <LinearGradient colors={['#7DD3FC', '#38BDF8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.button}>
              {isSubmitting ? <ActivityIndicator color="#030712" /> : <Text style={styles.buttonText}>Add to Group</Text>}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', padding: 16 },
  card: {
    backgroundColor: '#151F32',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.16)',
    padding: 24,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  headerCopy: { flex: 1 },
  title: { color: '#F8FAFC', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { marginTop: 6, color: '#94A3B8', fontSize: 15, lineHeight: 22 },
  input: {
    marginTop: 22,
    backgroundColor: '#0B1120',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.16)',
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  errorBanner: {
    marginTop: 12,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  errorText: { color: '#F87171', fontSize: 14, fontWeight: '600' },
  buttonWrap: { marginTop: 22, borderRadius: 999 },
  buttonDisabled: { opacity: 0.45 },
  button: { minHeight: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#030712', fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
});
