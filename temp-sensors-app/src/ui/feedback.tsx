import React, { createContext, useCallback, useContext, useRef, useState, ReactNode } from 'react';
import { Alert, Platform, Text, View, StyleSheet, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { C, F, R, S } from '../theme';

/**
 * Ask before anything destructive. Native Alert on a phone; the web build
 * (used only for checking the UI) has no Alert buttons, so it uses confirm().
 */
export function confirm(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(globalThis.confirm?.(`${opts.title}\n\n${opts.message}`) ?? false);
  }
  return new Promise((resolve) => {
    Alert.alert(opts.title, opts.message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: opts.confirmLabel ?? 'OK', style: opts.danger ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

type Kind = 'success' | 'error' | 'info';
interface ToastApi { success: (m: string) => void; error: (m: string) => void; info: (m: string) => void }
const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<{ msg: string; kind: Kind } | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((msg: string, kind: Kind) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ msg, kind });
    Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: Platform.OS !== 'web' }).start();
    timer.current = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: Platform.OS !== 'web' })
        .start(() => setToast(null));
    }, kind === 'error' ? 4500 : 2800);
  }, [opacity]);

  const api = useRef<ToastApi>({
    success: (m) => show(m, 'success'),
    error: (m) => show(m, 'error'),
    info: (m) => show(m, 'info'),
  });
  api.current.success = (m) => show(m, 'success');
  api.current.error = (m) => show(m, 'error');
  api.current.info = (m) => show(m, 'info');

  const icon = toast?.kind === 'success' ? 'check' : toast?.kind === 'error' ? 'alert-circle' : 'info';
  return (
    <ToastCtx.Provider value={api.current}>
      {children}
      {toast && (
        <Animated.View pointerEvents="none" style={[styles.wrap, { top: insets.top + S.sm, opacity }]}>
          <View style={styles.toast}>
            <Feather name={icon} size={16} color={toast.kind === 'error' ? '#FFB3BC' : C.iceSoft} />
            <Text style={styles.text}>{toast.msg}</Text>
          </View>
        </Animated.View>
      )}
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const t = useContext(ToastCtx);
  if (!t) throw new Error('useToast must be used within ToastProvider');
  return t;
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: S.lg, right: S.lg, alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', gap: S.sm, backgroundColor: C.ink, borderRadius: R.pill, paddingVertical: 10, paddingHorizontal: 16, maxWidth: 480 },
  text: { color: C.onDark, fontFamily: F.medium, fontSize: 14, flexShrink: 1 },
});
