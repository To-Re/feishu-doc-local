export type ColorRole = 'text' | 'background' | 'table' | 'callout' | 'border';

// Confirmed by the same S03/S05/S07 source and full-fetch document (2026-09-12).
// Feishu resolves names by context: light-blue text highlighting and callout
// backgrounds are different colors. Unknown names are not color-mapped.
const palette: Record<ColorRole, Record<string, string>> = {
  text: {
    red: 'rgb(216,57,49)', orange: 'rgb(222,120,2)', yellow: 'rgb(220,155,4)',
    green: 'rgb(46,161,33)', blue: 'rgb(36,91,219)', purple: 'rgb(100,37,208)', gray: 'rgb(143,149,158)',
  },
  background: {
    'light-red': 'rgb(251,191,188)', 'light-orange': 'rgba(254,212,164,0.8)',
    'light-yellow': 'rgba(255,246,122,0.8)', 'light-green': 'rgba(183,237,177,0.8)',
    'light-blue': 'rgba(186,206,253,0.7)', 'light-purple': 'rgba(205,178,250,0.7)',
    'medium-gray': 'rgba(222,224,227,0.8)',
  },
  table: {
    'light-gray': 'rgba(245,246,247,0.9)', 'medium-gray': 'rgb(242,243,245)',
    'light-green': 'rgb(240,251,239)', 'light-yellow': 'rgb(254,255,240)',
  },
  callout: {
    'light-blue': 'rgb(240,244,255)', 'light-green': 'rgb(240,251,239)',
    'medium-yellow': 'rgb(255,255,204)',
  },
  border: { blue: 'rgb(130,167,252)', green: 'rgb(142,224,133)', orange: 'rgb(255,186,107)' },
};

// Full fetch returns numeric CSS colors, while authored XML also accepts names.
// Parse only color literals: never interpolate arbitrary CSS into a style attribute.
export function docxColor(value: unknown, role: ColorRole): string | undefined {
  if (typeof value !== 'string') return;
  if (Object.hasOwn(palette[role], value)) return palette[role][value];
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return value;
  const numeric = /^(rgb|rgba)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+|1\.0+))?\s*\)$/i.exec(value);
  if (!numeric || numeric.slice(2, 5).some(channel => Number(channel) > 255)) return;
  if ((numeric[1].toLowerCase() === 'rgba') !== (numeric[5] !== undefined)) return;
  return value;
}
