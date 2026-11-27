// Frost primitives. Screens compose these instead of styling from scratch, so
// the look stays consistent: page #F2F6F8, white tiles, ice for interaction,
// red only for alarms, mono for numbers.
import React, { ReactNode } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, Modal, ActivityIndicator, RefreshControl,
  StyleSheet, StyleProp, ViewStyle, TextStyle, TextInputProps, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, F, R, S } from '../theme';

export type IconName = React.ComponentProps<typeof Feather>['name'];
export const Icon = ({ name, size = 18, color = C.ink2 }: { name: IconName; size?: number; color?: string }) =>
  <Feather name={name} size={size} color={color} />;

// ── Text ─────────────────────────────────────────────────────────────────────
type TVariant = 'display' | 'title' | 'h2' | 'h3' | 'body' | 'small' | 'caption' | 'label' | 'mono' | 'monoSmall';
const tStyles: Record<TVariant, TextStyle> = {
  display: { fontFamily: F.bold, fontSize: 30, color: C.ink, letterSpacing: -0.5 },
  title: { fontFamily: F.bold, fontSize: 24, color: C.ink, letterSpacing: -0.3 },
  h2: { fontFamily: F.bold, fontSize: 18, color: C.ink },
  h3: { fontFamily: F.medium, fontSize: 15, color: C.ink },
  body: { fontFamily: F.regular, fontSize: 15, color: C.ink, lineHeight: 21 },
  small: { fontFamily: F.regular, fontSize: 13, color: C.ink2, lineHeight: 18 },
  caption: { fontFamily: F.regular, fontSize: 12, color: C.ink3, lineHeight: 16 },
  label: { fontFamily: F.medium, fontSize: 12, color: C.ink2, letterSpacing: 0.4, textTransform: 'uppercase' },
  mono: { fontFamily: F.monoMedium, fontSize: 15, color: C.ink },
  monoSmall: { fontFamily: F.mono, fontSize: 12, color: C.ink2 },
};
export function T({ v = 'body', style, children, numberOfLines, selectable }: {
  v?: TVariant; style?: StyleProp<TextStyle>; children: ReactNode; numberOfLines?: number; selectable?: boolean;
}) {
  return <Text style={[tStyles[v], style]} numberOfLines={numberOfLines} selectable={selectable}>{children}</Text>;
}

// ── Layout ───────────────────────────────────────────────────────────────────
export function Screen({ children, refreshing, onRefresh, padded = true, scroll = true, style }: {
  children: ReactNode; refreshing?: boolean; onRefresh?: () => void; padded?: boolean; scroll?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const pad = padded ? { padding: S.lg, paddingBottom: S.xxl * 2 } : null;
  if (!scroll) return <View style={[st.page, pad, style]}>{children}</View>;
  return (
    <KeyboardAvoidingView style={st.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={st.page}
        contentContainerStyle={[pad, style]}
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={C.ice} colors={[C.ice]} /> : undefined}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Large tab-screen header, with the status-bar inset. */
export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[st.pageHeader, { paddingTop: insets.top + S.md }]}>
      <View style={{ flex: 1 }}>
        <T v="display">{title}</T>
        {subtitle ? <T v="small" style={{ marginTop: 2 }}>{subtitle}</T> : null}
      </View>
      {right}
    </View>
  );
}

export function Section({ title, right, children, style }: { title?: string; right?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ marginTop: S.xl }, style]}>
      {(title || right) && (
        <View style={st.sectionHead}>
          {title ? <T v="label" style={{ flex: 1 }}>{title}</T> : <View style={{ flex: 1 }} />}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function Card({ children, style, onPress, tone }: {
  children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; tone?: 'alarm' | 'ice' | 'amber';
}) {
  const toneStyle = tone === 'alarm' ? { borderColor: C.alarm, borderWidth: 2 }
    : tone === 'ice' ? { borderColor: C.ice, borderWidth: 1.5 }
    : tone === 'amber' ? { borderColor: C.amber, borderWidth: 1.5 } : null;
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [st.card, toneStyle, pressed && st.pressed, style]}>
        {children}
      </Pressable>
    );
  }
  return <View style={[st.card, toneStyle, style]}>{children}</View>;
}

export function Row({ children, style, gap = S.sm }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

export const Divider = ({ style }: { style?: StyleProp<ViewStyle> }) => <View style={[st.divider, style]} />;

/** Label / value line in a detail card. */
export function KV({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <View style={st.kv}>
      <T v="small" style={{ flex: 1 }}>{k}</T>
      {typeof v === 'string' || typeof v === 'number'
        ? <T v={mono ? 'mono' : 'body'} style={{ textAlign: 'right', flexShrink: 1, fontSize: mono ? 13 : 14 }} selectable>{v}</T>
        : v}
    </View>
  );
}

// ── Controls ─────────────────────────────────────────────────────────────────
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'onAlarm' | 'onAlarmGhost';
export function Button({ label, onPress, variant = 'secondary', icon, disabled, busy, small, style, full }: {
  label: string; onPress?: () => void; variant?: BtnVariant; icon?: IconName; disabled?: boolean; busy?: boolean;
  small?: boolean; style?: StyleProp<ViewStyle>; full?: boolean;
}) {
  const v = btn[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        st.btn, small && st.btnSmall, v.box, full && { alignSelf: 'stretch' },
        (disabled || busy) && { opacity: 0.45 }, pressed && st.pressed, style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={v.fg} /> : icon ? <Feather name={icon} size={small ? 14 : 16} color={v.fg} /> : null}
      <Text style={[st.btnText, small && { fontSize: 13 }, { color: v.fg }]}>{label}</Text>
    </Pressable>
  );
}
const btn: Record<BtnVariant, { box: ViewStyle; fg: string }> = {
  primary: { box: { backgroundColor: C.ice }, fg: C.onDark },
  secondary: { box: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.lineStrong }, fg: C.ink },
  ghost: { box: { backgroundColor: 'transparent' }, fg: C.ice },
  danger: { box: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.lineStrong }, fg: C.alarmDeep },
  onAlarm: { box: { backgroundColor: C.surface }, fg: C.alarm },
  onAlarmGhost: { box: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)' }, fg: C.onDark },
};

export function IconButton({ name, onPress, color = C.ink2, label, disabled, bg }: {
  name: IconName; onPress: () => void; color?: string; label: string; disabled?: boolean; bg?: string;
}) {
  return (
    <Pressable
      onPress={onPress} disabled={disabled} accessibilityLabel={label} hitSlop={8}
      style={({ pressed }) => [st.iconBtn, bg ? { backgroundColor: bg } : null, disabled && { opacity: 0.4 }, pressed && st.pressed]}
    >
      <Feather name={name} size={18} color={color} />
    </Pressable>
  );
}

export type ChipTone = 'alarm' | 'amber' | 'muted' | 'ok' | 'ice' | 'plain';
const chipColors: Record<ChipTone, { bg: string; fg: string }> = {
  alarm: { bg: C.alarm, fg: C.onDark },
  amber: { bg: C.amberSoft, fg: C.amber },
  muted: { bg: C.inset, fg: C.ink2 },
  ok: { bg: C.okSoft, fg: C.ok },
  ice: { bg: C.iceSoft, fg: C.iceDeep },
  plain: { bg: C.surface, fg: C.ink2 },
};
export function Chip({ label, tone = 'muted', icon }: { label: string; tone?: ChipTone; icon?: IconName }) {
  const c = chipColors[tone];
  return (
    <View style={[st.chip, { backgroundColor: c.bg }, tone === 'plain' && { borderWidth: 1, borderColor: C.line }]}>
      {icon ? <Feather name={icon} size={11} color={c.fg} /> : null}
      <Text style={[st.chipText, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

export function Field({ label, hint, error, style, ...input }: TextInputProps & {
  label?: string; hint?: string; error?: string; style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ marginBottom: S.md }, style]}>
      {label ? <T v="label" style={{ marginBottom: 6 }}>{label}</T> : null}
      <TextInput
        placeholderTextColor={C.ink3}
        {...input}
        style={[st.input, input.editable === false && { backgroundColor: C.inset, color: C.ink2 }, error ? { borderColor: C.alarm } : null]}
      />
      {error ? <T v="small" style={{ color: C.alarmDeep, marginTop: 4 }}>{error}</T> : null}
      {hint ? <T v="caption" style={{ marginTop: 4 }}>{hint}</T> : null}
    </View>
  );
}

export function Toggle({ label, value, onChange, disabled, hint }: {
  label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: string;
}) {
  return (
    <Pressable
      onPress={() => !disabled && onChange(!value)}
      accessibilityRole="switch" accessibilityState={{ checked: value, disabled }}
      style={[st.toggleRow, disabled && { opacity: 0.55 }]}
    >
      <View style={{ flex: 1 }}>
        <T v="body">{label}</T>
        {hint ? <T v="caption">{hint}</T> : null}
      </View>
      <View style={[st.switch, value && { backgroundColor: C.ice }]}>
        <View style={[st.knob, value && { transform: [{ translateX: 18 }] }]} />
      </View>
    </Pressable>
  );
}

export function Segmented<V extends string | number>({ options, value, onChange, style }: {
  options: { value: V; label: string }[]; value: V; onChange: (v: V) => void; style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[st.seg, style]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={String(o.value)} onPress={() => onChange(o.value)} style={[st.segItem, on && st.segOn]}>
            <Text style={[st.segText, on && { color: C.ink, fontFamily: F.medium }]} numberOfLines={1}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Pick one from a list; renders as a row that opens a sheet. */
export function Picker<V extends string | number>({ label, value, options, onChange, placeholder = 'Choose…' }: {
  label?: string; value: V | null; options: { value: V; label: string; sub?: string }[];
  onChange: (v: V) => void; placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <View style={{ marginBottom: S.md }}>
      {label ? <T v="label" style={{ marginBottom: 6 }}>{label}</T> : null}
      <Pressable onPress={() => setOpen(true)} style={[st.input, { flexDirection: 'row', alignItems: 'center' }]}>
        <T v="body" style={{ flex: 1, color: current ? C.ink : C.ink3 }} numberOfLines={1}>{current?.label ?? placeholder}</T>
        <Feather name="chevron-down" size={16} color={C.ink2} />
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title={label ?? 'Choose'}>
        {options.map((o) => (
          <Pressable key={String(o.value)} onPress={() => { onChange(o.value); setOpen(false); }} style={st.pickRow}>
            <View style={{ flex: 1 }}>
              <T v="body">{o.label}</T>
              {o.sub ? <T v="caption">{o.sub}</T> : null}
            </View>
            {o.value === value ? <Feather name="check" size={18} color={C.ice} /> : null}
          </Pressable>
        ))}
      </Sheet>
    </View>
  );
}

// ── Sheets & states ──────────────────────────────────────────────────────────
export function Sheet({ visible, onClose, title, subtitle, children, footer }: {
  visible: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode; footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={st.scrim} onPress={onClose} />
        <View style={[st.sheet, { paddingBottom: insets.bottom + S.lg }]}>
          <View style={st.grabber} />
          <View style={st.sheetHead}>
            <View style={{ flex: 1 }}>
              <T v="h2">{title}</T>
              {subtitle ? <T v="small" numberOfLines={1}>{subtitle}</T> : null}
            </View>
            <IconButton name="x" label="Close" onPress={onClose} />
          </View>
          <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ paddingBottom: S.md }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer ? <View style={st.sheetFoot}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Notice({ tone = 'ice', children, icon }: { tone?: 'ice' | 'amber' | 'alarm' | 'ok'; children: ReactNode; icon?: IconName }) {
  const map = {
    ice: { bg: C.iceSoft, fg: C.iceDeep, i: 'info' as IconName },
    amber: { bg: C.amberSoft, fg: C.amber, i: 'alert-triangle' as IconName },
    alarm: { bg: C.alarmSoft, fg: C.alarmDeep, i: 'alert-octagon' as IconName },
    ok: { bg: C.okSoft, fg: C.ok, i: 'check-circle' as IconName },
  }[tone];
  return (
    <View style={[st.notice, { backgroundColor: map.bg }]}>
      <Feather name={icon ?? map.i} size={16} color={map.fg} style={{ marginTop: 1 }} />
      <Text style={[st.noticeText, { color: map.fg }]}>{children}</Text>
    </View>
  );
}

export function Empty({ icon = 'inbox', title, body, action }: { icon?: IconName; title: string; body?: string; action?: ReactNode }) {
  return (
    <View style={st.empty}>
      <View style={st.emptyIcon}><Feather name={icon} size={22} color={C.ice} /></View>
      <T v="h3" style={{ textAlign: 'center' }}>{title}</T>
      {body ? <T v="small" style={{ textAlign: 'center', marginTop: 4 }}>{body}</T> : null}
      {action ? <View style={{ marginTop: S.md }}>{action}</View> : null}
    </View>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={st.loading}>
      <ActivityIndicator color={C.ice} />
      <T v="small" style={{ marginTop: S.sm }}>{label}</T>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Empty icon="cloud-off" title="Couldn't load this" body={message}
      action={onRetry ? <Button label="Try again" icon="refresh-cw" onPress={onRetry} small /> : undefined} />
  );
}

/** Small metric: label above, mono number below. */
export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'alarm' | 'amber' | 'ok' }) {
  const color = tone === 'alarm' ? C.alarm : tone === 'amber' ? C.amber : tone === 'ok' ? C.ok : C.ink;
  return (
    <View style={st.stat}>
      <T v="caption">{label}</T>
      <Text style={[st.statVal, { color }]}>{value}</Text>
    </View>
  );
}

export const st = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.page },
  pageHeader: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: S.lg, paddingBottom: S.sm, backgroundColor: C.page, gap: S.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', marginBottom: S.sm, minHeight: 28 },
  card: { backgroundColor: C.surface, borderRadius: R.tile, padding: S.lg, borderWidth: 1, borderColor: 'transparent' },
  pressed: { opacity: 0.75, transform: [{ scale: 0.99 }] },
  divider: { height: 1, backgroundColor: C.line, marginVertical: S.md },
  kv: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: S.md },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: R.pill, paddingVertical: 12, paddingHorizontal: 18, alignSelf: 'flex-start' },
  btnSmall: { paddingVertical: 7, paddingHorizontal: 13 },
  btnText: { fontFamily: F.medium, fontSize: 15 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: R.pill, paddingHorizontal: 9, paddingVertical: 3, alignSelf: 'flex-start' },
  chipText: { fontFamily: F.medium, fontSize: 11, letterSpacing: 0.2 },
  input: { backgroundColor: C.surface, borderRadius: R.control, borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, paddingVertical: 12, fontFamily: F.regular, fontSize: 15, color: C.ink, minHeight: 46 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: S.md },
  switch: { width: 44, height: 26, borderRadius: 13, backgroundColor: C.lineStrong, padding: 3 },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: C.surface },
  seg: { flexDirection: 'row', backgroundColor: C.inset, borderRadius: R.pill, padding: 3 },
  segItem: { flex: 1, paddingVertical: 8, paddingHorizontal: 6, borderRadius: R.pill, alignItems: 'center' },
  segOn: { backgroundColor: C.surface },
  segText: { fontFamily: F.regular, fontSize: 13, color: C.ink2 },
  pickRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.line, gap: S.md },
  scrim: { flex: 1, backgroundColor: C.scrim },
  sheet: { backgroundColor: C.page, borderTopLeftRadius: R.card, borderTopRightRadius: R.card, paddingHorizontal: S.lg, paddingTop: S.sm },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: C.lineStrong, marginBottom: S.sm },
  sheetHead: { flexDirection: 'row', alignItems: 'center', marginBottom: S.md },
  sheetFoot: { flexDirection: 'row', gap: S.sm, justifyContent: 'flex-end', paddingTop: S.md, borderTopWidth: 1, borderTopColor: C.line },
  notice: { flexDirection: 'row', gap: S.sm, padding: S.md, borderRadius: R.control, marginBottom: S.md },
  noticeText: { flex: 1, fontFamily: F.regular, fontSize: 13, lineHeight: 18 },
  empty: { alignItems: 'center', paddingVertical: S.xxl, paddingHorizontal: S.xl },
  emptyIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: C.iceSoft, alignItems: 'center', justifyContent: 'center', marginBottom: S.md },
  loading: { alignItems: 'center', paddingVertical: S.xxl * 1.5 },
  stat: { flex: 1, backgroundColor: C.surface, borderRadius: R.control, padding: S.md, minWidth: 90 },
  statVal: { fontFamily: F.monoMedium, fontSize: 20, marginTop: 2 },
});
