/**
 * Procedurally generated illustrations used as demo image attachments.
 * Returned as data: URLs so the demo works fully offline with no assets.
 */
import type { Attachment } from '@/core/domain';
import type { ImageKind } from './content/conversations';
import type { Random } from './prng';

interface Generated {
  svg: string;
  width: number;
  height: number;
}

const PALETTES: readonly (readonly string[])[] = [
  ['#1d2b53', '#7e2553', '#d4744a', '#ffcc70'],
  ['#0f2027', '#2c5364', '#78c2ad', '#f2e8cf'],
  ['#2d1e2f', '#6d3b47', '#e07a5f', '#f4d58d'],
  ['#14213d', '#3a506b', '#5bc0be', '#fca311'],
];

function ridge(rnd: Random, width: number, base: number, amplitude: number, steps: number): string {
  const pts: string[] = [`0,${base}`];
  for (let i = 1; i <= steps; i++) {
    const x = Math.round((i / steps) * width);
    const y = Math.round(base - rnd.next() * amplitude);
    pts.push(`${x},${y}`);
  }
  return pts.join(' ');
}

function peaks(rnd: Random): Generated {
  const [sky, far, near, sun] = rnd.pick(PALETTES) as [string, string, string, string];
  const w = 1200;
  const h = 800;
  const layers = [0, 1, 2]
    .map((i) => {
      const base = 520 + i * 90;
      const pts = ridge(rnd, w, base, 220 - i * 50, 7 + i * 3);
      const color = i === 0 ? far : i === 1 ? near : sky;
      return `<polygon points="${pts} ${w},${h} 0,${h}" fill="${color}" opacity="${0.75 + i * 0.1}"/>`;
    })
    .join('');
  const sx = rnd.int(200, 1000);
  return {
    width: w,
    height: h,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="${sun}"/></linearGradient></defs>` +
      `<rect width="${w}" height="${h}" fill="url(#s)"/><circle cx="${sx}" cy="260" r="70" fill="${sun}" opacity=".9"/>${layers}</svg>`,
  };
}

function sunset(rnd: Random): Generated {
  const [deep, mid, warm, light] = rnd.pick(PALETTES) as [string, string, string, string];
  const w = 1080;
  const h = 1080;
  const lines = Array.from({ length: 9 }, (_, i) => {
    const y = 640 + i * 42;
    const inset = 80 + i * rnd.int(10, 40);
    return `<rect x="${inset}" y="${y}" width="${w - inset * 2}" height="${6 + i}" rx="4" fill="${light}" opacity="${0.5 - i * 0.04}"/>`;
  }).join('');
  return {
    width: w,
    height: h,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${deep}"/><stop offset=".55" stop-color="${mid}"/><stop offset="1" stop-color="${warm}"/></linearGradient></defs>` +
      `<rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w / 2}" cy="600" r="${rnd.int(150, 220)}" fill="${light}"/>` +
      `<rect y="620" width="${w}" height="${h - 620}" fill="${deep}" opacity=".85"/>${lines}</svg>`,
  };
}

function bars(rnd: Random): Generated {
  const [bg, , accent, fg] = rnd.pick(PALETTES) as [string, string, string, string];
  const w = 1200;
  const h = 700;
  const n = 8;
  const barW = 90;
  const gap = (w - 160 - n * barW) / (n - 1);
  const rects = Array.from({ length: n }, (_, i) => {
    const bh = rnd.int(120, 460);
    const x = 80 + i * (barW + gap);
    return `<rect x="${Math.round(x)}" y="${600 - bh}" width="${barW}" height="${bh}" rx="10" fill="${i === n - 1 ? accent : fg}" opacity="${i === n - 1 ? 1 : 0.55}"/>`;
  }).join('');
  return {
    width: w,
    height: h,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<rect width="${w}" height="${h}" fill="${bg}"/><rect x="60" y="602" width="${w - 120}" height="3" fill="${fg}" opacity=".4"/>${rects}</svg>`,
  };
}

function palette(rnd: Random): Generated {
  const colors = rnd.pick(PALETTES);
  const w = 1200;
  const h = 800;
  const cards = colors
    .map((c, i) => {
      const x = 80 + i * 270;
      return `<rect x="${x}" y="160" width="230" height="420" rx="24" fill="${c}"/><rect x="${x + 24}" y="610" width="${rnd.int(90, 180)}" height="18" rx="9" fill="#e9e7e4" opacity=".7"/>`;
    })
    .join('');
  return {
    width: w,
    height: h,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<rect width="${w}" height="${h}" fill="#1b1d22"/><rect x="80" y="80" width="360" height="30" rx="15" fill="#e9e7e4" opacity=".85"/>${cards}</svg>`,
  };
}

function garden(rnd: Random): Generated {
  const w = 1000;
  const h = 1000;
  const leafColors = ['#2f6f3e', '#4f9a53', '#7cc36b', '#a8d672'];
  const bloomColors = ['#d4744a', '#f5b44a', '#f0506e', '#ffd6e0', '#c38bff'];
  const leaves = Array.from({ length: 26 }, () => {
    const x = rnd.int(0, w);
    const y = rnd.int(300, h);
    const r = rnd.int(40, 110);
    return `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${Math.round(r * 0.55)}" transform="rotate(${rnd.int(-60, 60)} ${x} ${y})" fill="${rnd.pick(leafColors)}"/>`;
  }).join('');
  const blooms = Array.from({ length: 14 }, () => {
    const x = rnd.int(60, w - 60);
    const y = rnd.int(260, h - 60);
    const c = rnd.pick(bloomColors);
    return `<circle cx="${x}" cy="${y}" r="${rnd.int(18, 34)}" fill="${c}"/><circle cx="${x}" cy="${y}" r="8" fill="#fff4c2"/>`;
  }).join('');
  return {
    width: w,
    height: h,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<rect width="${w}" height="${h}" fill="#cfe8f3"/><rect y="320" width="${w}" height="${h - 320}" fill="#6b4f3a"/>${leaves}${blooms}</svg>`,
  };
}

const GENERATORS: Record<ImageKind, (rnd: Random) => Generated> = {
  peaks,
  sunset,
  bars,
  palette,
  garden,
};

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function generateImageAttachment(rnd: Random, kind: ImageKind, id: string): Attachment {
  const { svg, width, height } = GENERATORS[kind](rnd);
  return {
    id,
    contentType: 'image/svg+xml',
    fileName: `${kind}-${id.slice(0, 6)}.svg`,
    size: svg.length,
    width,
    height,
    url: svgDataUrl(svg),
  };
}
