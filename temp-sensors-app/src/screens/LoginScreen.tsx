import React, { useState } from 'react';
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { Button, Field, Notice, T } from '../ui';
import { useAuth } from '../context/AuthContext';
import { errText } from '../services/api';
import { C, F, R, S } from '../theme';

export default function LoginScreen() {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!identifier.trim() || !password) return setError('Enter your email and password');
    setError(null); setBusy(true);
    try { await login(identifier, password); }
    catch (err) { setError(errText(err, "Couldn't sign in. Check your connection and try again.")); }
    finally { setBusy(false); }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.page }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
        <View style={styles.mark}>
          <Svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke={C.onDark} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
            <Circle cx={11.5} cy={17.5} r={1.5} fill={C.onDark} />
          </Svg>
        </View>
        <Text style={styles.brand}>Temp Sensors</Text>
        <T v="small" style={{ marginBottom: S.xl }}>Cold-chain monitoring</T>
        <View style={styles.card}>
          {error && <Notice tone="alarm">{error}</Notice>}
          <Field label="Email" value={identifier} onChangeText={setIdentifier} autoCapitalize="none" autoCorrect={false}
            keyboardType="email-address" autoComplete="email" textContentType="username" placeholder="you@example.com" returnKeyType="next" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password"
            placeholder="••••••••••" returnKeyType="go" onSubmitEditing={submit} />
          <Button label="Sign in" variant="primary" full busy={busy} onPress={submit} style={{ marginTop: S.sm }} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: S.xl },
  mark: { width: 64, height: 64, borderRadius: 20, backgroundColor: C.ice, alignItems: 'center', justifyContent: 'center', marginBottom: S.md },
  brand: { fontFamily: F.bold, fontSize: 28, color: C.ink, letterSpacing: -0.5 },
  card: { width: '100%', maxWidth: 400, backgroundColor: C.surface, borderRadius: R.card, padding: S.xl },
});
