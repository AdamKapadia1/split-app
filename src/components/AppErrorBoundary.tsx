import { reloadAppAsync } from 'expo';
import { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '@/theme/theme';
import { logger } from '@/utils/logger';

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  errorCode: string | null;
};

function errorCode(error: Error) {
  return /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(error.name) ? error.name : 'Error';
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { errorCode: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { errorCode: errorCode(error) };
  }

  componentDidCatch(error: Error) {
    logger.error('AppErrorBoundary', { code: errorCode(error) });
  }

  reload = () => {
    void reloadAppAsync('Recover from an unexpected error').catch(() => {
      this.setState({ errorCode: null });
    });
  };

  render() {
    if (!this.state.errorCode) return this.props.children;

    return (
      <View style={styles.screen}>
        <Text style={styles.mark}>Midnight</Text>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>The screen closed before it could show your details. You can reload and pick up where you left off.</Text>
        <Text style={styles.code}>{this.state.errorCode}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Reload App" onPress={this.reload} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
          <Text style={styles.buttonText}>Reload App</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.canvas,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  mark: {
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: theme.colors.textMuted,
  },
  title: {
    marginTop: 16,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    letterSpacing: -0.6,
    color: theme.colors.textPrimary,
    textAlign: 'center',
  },
  body: {
    marginTop: 12,
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
  code: {
    marginTop: 20,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.4,
    color: theme.colors.textMuted,
  },
  button: {
    marginTop: 28,
    height: 48,
    paddingHorizontal: 22,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  buttonPressed: { backgroundColor: theme.colors.accentPressed },
  buttonText: { fontSize: 15, fontWeight: '700', color: theme.colors.accentText },
});
