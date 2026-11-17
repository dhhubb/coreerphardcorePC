'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cameraSupported, startCameraScan, type CameraScanner as CameraScannerHandle } from './camera';

/**
 * The optional camera scanner (F7).
 *
 * A camera needs a secure context: on a branch LAN served over plain HTTP the browser will not grant
 * `getUserMedia`, so the component renders nothing but a short note ("Camera scan requires HTTPS")
 * rather than an affordance that then fails. On HTTPS it shows a toggle and a preview, and decodes
 * barcodes with `@zxing/library` (imported dynamically inside `startCameraScan`, so a build without
 * the optional dependency is unaffected).
 *
 * This is additive to H4's till: the keyboard-wedge path stays the default and the only path a sale
 * depends on. A decoded barcode is handed to `onScan` exactly like a wedge scan.
 */

/** The message shown when the page is not a secure context. Exported so a test can assert it. */
export const CAMERA_HTTPS_MESSAGE = 'Camera scan requires HTTPS';

export interface CameraScannerProps {
  /** Called once per decoded barcode. */
  onScan: (code: string) => void;
  /** Show the affordance even when the context is insecure, with the HTTPS note. Default true. */
  showWhenUnsupported?: boolean;
}

export function CameraScanner({ onScan, showWhenUnsupported = true }: CameraScannerProps) {
  // `cameraSupported()` reads `window.isSecureContext`; it is false during the server pass and in a
  // non-HTTPS browser, so the camera never renders where it cannot work.
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<CameraScannerHandle | null>(null);

  useEffect(() => {
    setSupported(cameraSupported());
  }, []);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setOn(false);
  }, []);

  const toggle = useCallback(async () => {
    if (on) {
      stop();
      return;
    }
    setError(null);
    const video = videoRef.current;
    if (!video) return;
    try {
      handleRef.current = await startCameraScan({
        video,
        onResult: (code) => onScan(code),
        onError: (caught) => setError(caught.message),
      });
      setOn(true);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [on, onScan, stop]);

  useEffect(() => () => handleRef.current?.stop(), []);

  if (!supported) {
    if (!showWhenUnsupported) return null;
    return (
      <p className="camera-unsupported" data-testid="camera-unsupported">
        {CAMERA_HTTPS_MESSAGE}
      </p>
    );
  }

  return (
    <div className="camera-scanner" data-testid="camera-scanner">
      <button type="button" data-testid="camera-toggle" onClick={() => void toggle()}>
        {on ? 'Stop camera' : 'Scan with camera'}
      </button>
      <video
        ref={videoRef}
        data-testid="camera-video"
        muted
        playsInline
        style={{ width: 200, display: on ? 'block' : 'none' }}
      />
      {error && (
        <span className="error" data-testid="camera-error">
          {error}
        </span>
      )}
    </div>
  );
}
