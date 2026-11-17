'use client';

import { useEffect, useMemo, useRef } from 'react';
import { ScannerBuffer, type KeyEventLike, type ScanDecision } from './scanner';

/**
 * The keyboard-wedge scanner input (F7).
 *
 * A wedge scanner is a keyboard: it types the barcode characters and sends Enter. `useScannerInput`
 * listens at the document level, so a scan lands no matter which element has focus, and it buffers
 * a burst typed faster than `SCANNER_MAX_AVG_GAP_MS` (50 ms between keys) as one code.
 *
 * The engine is a plain controller (`createScannerController`) over `ScannerBuffer`, so the buffering
 * rule is asserted with simulated fast typing without a browser; the hook is a thin wiring of that
 * controller to real `keydown` events.
 */

export interface ScannerController {
  feed(event: KeyEventLike): ScanDecision;
  reset(): void;
  readonly pending: string;
}

/** A DOM-free controller: the same state machine the hook drives, usable in a test. */
export function createScannerController(options: { minLength?: number } = {}): ScannerController {
  const buffer = new ScannerBuffer(options);
  return {
    feed: (event) => buffer.feed(event),
    reset: () => buffer.reset(),
    get pending() {
      return buffer.pending;
    },
  };
}

export interface UseScannerInputOptions {
  /** Called when Enter closes a long-enough burst. `fromScanner` is true for a fast burst. */
  onScan: (code: string, meta: { fromScanner: boolean }) => void;
  /** Called for each printable character that joins the pending buffer (the on-screen echo). */
  onChar?: (value: string) => void;
  /** Called when Enter arrives with too short a buffer (or an empty one). */
  onEnter?: () => void;
  /** When false the listener is detached (for example while a dialog owns the keyboard). */
  enabled?: boolean;
  /** The minimum barcode length a burst must reach before Enter submits it. */
  minLength?: number;
  /** Return true for a target whose own key handling owns the keys (the scan field). */
  ignoreWhen?: (target: EventTarget | null) => boolean;
  /** The event target to listen on. Defaults to `document`. */
  target?: Document | HTMLElement | null;
}

/**
 * Wire the scanner controller to real keydown events. Returns the controller so a caller can reset
 * the buffer (for example when a shortcut interrupts a partial entry).
 */
export function useScannerInput(options: UseScannerInputOptions): ScannerController {
  const controller = useMemo(
    () => createScannerController(options.minLength !== undefined ? { minLength: options.minLength } : {}),
    [options.minLength],
  );

  // Keep the latest callbacks in a ref, so the listener is attached once and never re-subscribes
  // on every render (which would drop a barcode mid-burst).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const enabled = options.enabled ?? true;
  const target = options.target ?? null;

  useEffect(() => {
    if (!enabled) return;
    const node: Document | HTMLElement | null =
      target ?? (typeof document !== 'undefined' ? document : null);
    if (!node) return;

    const onKeyDown = (event: Event) => {
      const keyEvent = event as KeyboardEvent;
      const current = optionsRef.current;
      if (current.ignoreWhen?.(keyEvent.target)) return;

      const decision = controller.feed({ key: keyEvent.key, timeStamp: keyEvent.timeStamp });
      if (decision.kind === 'char') {
        keyEvent.preventDefault();
        current.onChar?.(decision.value);
        return;
      }
      if (decision.kind === 'scan') {
        keyEvent.preventDefault();
        current.onScan(decision.code, { fromScanner: decision.fromScanner });
        return;
      }
      if (decision.kind === 'enter' && keyEvent.key === 'Enter') {
        keyEvent.preventDefault();
        current.onEnter?.();
      }
    };

    node.addEventListener('keydown', onKeyDown as EventListener);
    return () => node.removeEventListener('keydown', onKeyDown as EventListener);
  }, [controller, enabled, target]);

  return controller;
}
