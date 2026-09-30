// Preset swatches for the color filter, plus hex helpers. The hex values are data (like the
// palettes Eagle extracts from images), not styling.

export interface ColorPreset {
  name: string;
  hex: string;
}

export const COLOR_PRESETS: ColorPreset[] = [
  { name: 'red', hex: '#e03131' },
  { name: 'orange', hex: '#f08c00' },
  { name: 'yellow', hex: '#fcc419' },
  { name: 'lime', hex: '#94d82d' },
  { name: 'green', hex: '#37b24d' },
  { name: 'teal', hex: '#12b886' },
  { name: 'cyan', hex: '#15aabf' },
  { name: 'blue', hex: '#228be6' },
  { name: 'indigo', hex: '#4c6ef5' },
  { name: 'purple', hex: '#7950f2' },
  { name: 'magenta', hex: '#be4bdb' },
  { name: 'pink', hex: '#e64980' },
  { name: 'brown', hex: '#8d5a3b' },
  { name: 'tan', hex: '#d2b48c' },
  { name: 'white', hex: '#ffffff' },
  { name: 'light gray', hex: '#c4c7cc' },
  { name: 'dark gray', hex: '#6b6f76' },
  { name: 'black', hex: '#000000' },
];

export type RGB = [number, number, number];

/** "#rgb" or "#rrggbb" (with or without the #), else null. */
export function hexToRgb(text: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** A preset's name when the color is exactly one of them, else the hex. */
export function colorName(rgb: RGB): string {
  const hex = rgbToHex(rgb);
  return COLOR_PRESETS.find((p) => p.hex === hex)?.name ?? hex.toUpperCase();
}
