import { Ionicons } from '@expo/vector-icons';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { APP_NAME } from '@/constants/brand';
import { theme } from '@/theme/theme';
import { logger } from '@/utils/logger';
import { captureSanitizedException } from '@/utils/sentry';

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
  repeat: boolean;
};

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string' && value.trim()) return new Error(value);
  return new Error('Unknown error');
}

function diagnosticLine(error: Error | null): string {
  const name = error && typeof error.name === 'string' && error.name.trim() ? error.name.trim() : 'Error';
  const message = error && typeof error.message === 'string' ? error.message.slice(0, 140) : '';
  return `Error: ${name}: ${message}`;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false, error: null, repeat: false };

  private lastSignature: string | null = null;

  static getDerivedStateFromError(error: unknown): Pick<AppErrorBoundaryState, 'hasError' | 'error'> {
    return { hasError: true, error: asError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      const safe = asError(error);
      const signature = `${safe.name}:${safe.message}`;
      const repeat = this.lastSignature === signature;
      this.lastSignature = signature;
      this.setState({ repeat });
      const componentStack = typeof info?.componentStack === 'string' ? info.componentStack : '';
      logger.error('error boundary', { name: safe.name, message: safe.message.slice(0, 300), componentStack });
      captureSanitizedException(safe, {
        boundary: 'root',
        componentStack,
      });
    } catch (reportError) {
      try {
        logger.error('error boundary', { code: 'REPORT_FAILED', error: reportError });
      } catch {
        // Reporting the crash must not throw again.
      }
    }
  }

  tryAgain = () => {
    this.setState({ hasError: false, error: null, repeat: false });
  };

  goHome = () => {
    this.setState({ hasError: false, error: null, repeat: false });
    try {
      // Lazy require avoids a cycle with the root layout that mounts this boundary.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { router } = require('expo-router') as typeof import('expo-router');
      router.replace('/');
    } catch (error) {
      logger.error('error boundary', { code: 'HOME_FAILED', error });
    }
  };

  copyDiagnostic = () => {
    const line = diagnosticLine(this.state.error);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Clipboard = require('expo-clipboard') as typeof import('expo-clipboard');
      void Promise.resolve(Clipboard.setStringAsync(line)).catch((error: unknown) => {
        logger.error('error boundary', { code: 'COPY_FAILED', error });
      });
    } catch (error) {
      logger.error('error boundary', { code: 'COPY_FAILED', error });
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const diagnostic = diagnosticLine(this.state.error);

    return (
      <View style={styles.screen}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="alert-circle" size={28} color={theme.colors.danger} />
          </View>
          <Text style={styles.mark}>{APP_NAME}</Text>
          <Text style={styles.title}>Something needs a moment</Text>
          <Text style={styles.body}>Your receipts and balances are safe. Try again when you are ready.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try Again"
            onPress={this.tryAgain}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
            <Text style={styles.buttonText}>Try Again</Text>
          </Pressable>
          {this.state.repeat ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go to Home"
              onPress={this.goHome}
              style={({ pressed }) => [styles.escape, pressed && styles.escapePressed]}>
              <Text style={styles.escapeText}>Go to Home</Text>
            </Pressable>
          ) : null}
          <Text selectable onPress={this.copyDiagnostic} style={styles.diagnostic}>
            {diagnostic}
          </Text>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0A0A0C',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#141417',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 18,
    paddingHorizontal: 24,
    paddingVertical: 28,
    alignItems: 'center',
  },
  mark: {
    marginTop: 16,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: theme.colors.textMuted,
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.dangerSubtle,
  },
  title: {
    marginTop: 18,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700',
    letterSpacing: -0.4,
    color: theme.colors.textPrimary,
    textAlign: 'center',
  },
  body: {
    marginTop: 8,
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
  button: {
    marginTop: 24,
    alignSelf: 'stretch',
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  buttonPressed: { backgroundColor: theme.colors.accentPressed },
  buttonText: { fontSize: 15, fontWeight: '700', color: theme.colors.accentText },
  escape: {
    marginTop: 10,
    alignSelf: 'stretch',
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  escapePressed: { backgroundColor: 'rgba(255,255,255,0.04)' },
  escapeText: { fontSize: 15, fontWeight: '600', color: theme.colors.textSecondary },
  diagnostic: {
    marginTop: 16,
    fontSize: 11,
    lineHeight: 15,
    color: 'rgba(255,255,255,0.28)',
    textAlign: 'center',
  },
});
