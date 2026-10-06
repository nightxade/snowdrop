import { useMemo } from 'react';
import { encode as encodeQr } from 'uqr';
import styles from './QrCode.module.css';

export interface QrCodeProps {
  value: string;
  /** Rendered size in CSS pixels. */
  size?: number;
  /** Accessible description of what scanning does. */
  label: string;
}

/**
 * QR code drawn locally as SVG (one path; no network, no innerHTML). Always
 * dark-on-light with a quiet zone, whatever the theme: scanners need contrast.
 */
export function QrCode({ value, size = 220, label }: QrCodeProps) {
  const { path, count } = useMemo(() => {
    const qr = encodeQr(value, { ecc: 'M', border: 0 });
    const n = qr.size;
    let d = '';
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) if (qr.data[y]?.[x]) d += `M${x} ${y}h1v1h-1z`;
    return { path: d, count: n };
  }, [value]);
  const quiet = 4;
  const box = count + quiet * 2;
  return (
    <svg
      className={styles.qr}
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
      shapeRendering="crispEdges"
    >
      <rect x={-quiet} y={-quiet} width={box} height={box} className={styles.paper} />
      <path d={path} className={styles.ink} />
    </svg>
  );
}
