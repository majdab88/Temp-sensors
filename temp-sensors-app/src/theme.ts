// "Frost" — the mobile app's design system.
//
// Light ice-white surfaces, rounded tiles, Space Grotesk for words and
// JetBrains Mono for every number a person reads off a cooler. It is
// deliberately not the web dashboard's look (Archivo + Plex Mono, flat gray),
// but it keeps the one rule that carries meaning across both: red is used for
// alarms and nothing else. Stale data, low batteries and warnings are amber;
// live and interactive things are ice blue.

export const C = {
  page: '#F2F6F8',
  surface: '#FFFFFF',
  inset: '#E7EEF2',     // segmented controls, wells, skeletons
  line: '#DCE5EA',
  lineStrong: '#C3D1D9',

  ink: '#0E1A24',
  ink2: '#5B6B77',
  ink3: '#8A99A4',

  ice: '#2F7F9F',       // interactive + live
  iceDeep: '#1E5D77',
  iceSoft: '#DCEDF4',

  alarm: '#D7263D',     // alarms only
  alarmDeep: '#9E1B2C',
  alarmSoft: '#FBE4E7',

  amber: '#B7790F',     // stale, low battery, warnings
  amberSoft: '#FBF0D9',

  ok: '#2E8F65',
  okSoft: '#DDF2E8',

  onDark: '#FFFFFF',
  scrim: 'rgba(14,26,36,0.42)',
} as const;

export const F = {
  regular: 'SpaceGrotesk_400Regular',
  medium: 'SpaceGrotesk_500Medium',
  bold: 'SpaceGrotesk_700Bold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

export const R = { tile: 16, card: 20, control: 12, pill: 999 } as const;

export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
