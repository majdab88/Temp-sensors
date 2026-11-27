import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Screen, PageHeader, Section, Card, Button, Empty, Loading, ErrorState, T, Row, Chip } from '../ui';
import { useToast } from '../ui/feedback';
import { AlarmHero, SensorTile } from '../components/SensorBits';
import { useOrgData } from '../store/OrgData';
import { useAuth } from '../context/AuthContext';
import { connection } from '../utils/sensor';
import { smartTime } from '../utils/time';
import type { RootStackParamList } from '../navigation/types';
import type { AlertEvent } from '../types';
import { C, F, R, S } from '../theme';

function eventText(e: AlertEvent) {
  const name = e.sensor_name || e.sensor_mac;
  const v = e.value != null ? `${Number(e.value).toFixed(1)} °C` : '';
  if (e.kind === 'high') return `${name} crossed its max limit — ${v}`;
  if (e.kind === 'low') return `${name} crossed its min limit — ${v}`;
  return `${name} back in range — ${v}`;
}

export default function OverviewScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const tabNav = useNavigation<any>();
  const toast = useToast();
  const { canEdit, impersonatedOrg, user } = useAuth();
  const { sensors, readings, alerts, rules, sparks, events, liveSeen, loading, error, refresh, acknowledge } = useOrgData();
  const [refreshing, setRefreshing] = useState(false);
  const [acking, setAcking] = useState<number | null>(null);

  const onRefresh = async () => { setRefreshing(true); await refresh(); setRefreshing(false); };
  const ack = async (id: number) => {
    setAcking(id);
    try { await acknowledge(id); toast.success('Excursion acknowledged'); }
    catch { toast.error('Failed to acknowledge — try again'); }
    finally { setAcking(null); }
  };
  const viewMac = (mac: string) => {
    const s = sensors.find((x) => x.mac === mac);
    if (s) nav.navigate('SensorDetail', { sensorId: s.id });
  };

  const orgName = impersonatedOrg?.name ?? user?.memberships?.[0]?.org_name;
  const header = <PageHeader title="Overview" subtitle={orgName ?? undefined} />;

  if (loading) return <View style={{ flex: 1, backgroundColor: C.page }}>{header}<Loading label="Loading sensors…" /></View>;
  if (error) return <View style={{ flex: 1, backgroundColor: C.page }}>{header}<ErrorState message={error} onRetry={refresh} /></View>;

  const active = Object.values(alerts);
  let hero = null as null | (typeof active[number] & { delta: number; mins: number });
  let rest: string[] = [];
  if (active.length) {
    const scored = active.map((a) => {
      const cur = readings[a.sensor_mac]?.temp ?? a.value;
      const delta = a.kind === 'high' ? cur - (a.high_limit ?? cur) : (a.low_limit ?? cur) - cur;
      return { ...a, delta: Math.max(0, delta), mins: Math.max(1, Math.floor((Date.now() - a.ts) / 60000)) };
    }).sort((x, y) => y.delta - x.delta);
    hero = scored[0];
    rest = scored.slice(1).map((a) => a.sensor_name || a.sensor_mac);
  }
  const online = sensors.filter((s) => connection(readings[s.mac]?.recorded_at) === 'online').length;

  return (
    <View style={{ flex: 1, backgroundColor: C.page }}>
      {header}
      <Screen refreshing={refreshing} onRefresh={onRefresh} style={{ paddingTop: S.sm }}>
        {hero ? (
          <AlarmHero
            hero={hero} more={rest} canEdit={canEdit} acking={acking === hero.excursion_id}
            onView={() => viewMac(hero!.sensor_mac)}
            onAck={() => hero!.excursion_id != null && ack(hero!.excursion_id)}
            onRules={() => tabNav.navigate('Alerts')}
          />
        ) : (
          <View style={styles.clear}>
            <View style={styles.clearDot} />
            <Text style={styles.clearText}>All sensors within limits · {online}/{sensors.length} online</Text>
          </View>
        )}

        {active.length > 0 && (
          <Section title={`Active alarms · ${active.length}`}>
            {active.map((a) => {
              const now = readings[a.sensor_mac]?.temp;
              return (
                <Card key={a.sensor_mac} tone="alarm" style={{ marginBottom: S.sm }}>
                  <T v="h3">{a.sensor_name || a.sensor_mac} {a.kind === 'high' ? 'above' : 'below'} limit</T>
                  {/* The breaching value, not the live one: mixing the current
                      reading with the breach's limit produced nonsense once a
                      sensor recovered ("4.7 °C vs max 30 °C"). */}
                  <T v="monoSmall" style={{ marginTop: 4 }}>
                    {Number(a.value).toFixed(1)} °C
                    {a.kind === 'high' && a.high_limit != null ? ` vs max ${a.high_limit} °C` : ''}
                    {a.kind === 'low' && a.low_limit != null ? ` vs min ${a.low_limit} °C` : ''}
                    {now != null && Math.abs(Number(now) - Number(a.value)) >= 0.1 ? ` · now ${Number(now).toFixed(1)} °C` : ''}
                  </T>
                  <Row style={{ marginTop: S.md }}>
                    <Button label="Details" small onPress={() => viewMac(a.sensor_mac)} />
                    {canEdit && a.excursion_id != null && (a.acked
                      ? <T v="small" style={{ color: C.ok }}>✓ Acked{a.ack_by ? ` · ${a.ack_by}` : ''}</T>
                      : <Button label="Acknowledge" variant="primary" small busy={acking === a.excursion_id} onPress={() => ack(a.excursion_id!)} />)}
                  </Row>
                </Card>
              );
            })}
          </Section>
        )}

        <Section
          title={`Sensors · ${sensors.length} paired · ${online} online`}
          right={canEdit ? <Button label="Pair sensor" icon="plus" variant="ghost" small onPress={() => tabNav.navigate('Hubs')} /> : undefined}
        >
          {sensors.length === 0 ? (
            <Card><Empty icon="thermometer" title="No sensors yet" body="Pair a sensor to one of your hubs to see it here." /></Card>
          ) : (
            <View style={styles.grid}>
              {sensors.map((s) => (
                <SensorTile
                  key={s.id} sensor={s} reading={readings[s.mac] ?? null} alert={alerts[s.mac] ?? null}
                  rule={rules[s.id] ?? null} spark={sparks[s.mac] ?? null} liveSeenAt={liveSeen[s.mac] ?? 0}
                  onPress={() => nav.navigate('SensorDetail', { sensorId: s.id })}
                />
              ))}
            </View>
          )}
        </Section>

        <Section title="Recent alerts">
          <Card style={{ paddingVertical: S.sm }}>
            {events.length === 0 ? <T v="small" style={{ paddingVertical: S.sm }}>No alert activity yet.</T> : events.map((e, i) => (
              <View key={String(e.id)} style={[styles.event, i > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}>
                <Chip tone={e.kind === 'recovered' ? 'ok' : 'alarm'} label={e.kind === 'recovered' ? 'OK' : e.kind === 'high' ? 'High' : 'Low'} />
                <View style={{ flex: 1 }}>
                  <T v="small" style={{ color: C.ink }}>{eventText(e)}</T>
                  <T v="caption">{smartTime(Number(e.ts) * 1000)}</T>
                </View>
              </View>
            ))}
          </Card>
        </Section>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  clear: { flexDirection: 'row', alignItems: 'center', gap: S.sm, backgroundColor: C.okSoft, borderRadius: R.pill, paddingVertical: 10, paddingHorizontal: S.lg },
  clearDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.ok },
  clearText: { fontFamily: F.medium, fontSize: 13, color: C.ok, flexShrink: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  event: { flexDirection: 'row', gap: S.md, paddingVertical: 10, alignItems: 'flex-start' },
});
