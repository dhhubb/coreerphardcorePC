'use client';

import { useEffect, useRef, useState } from 'react';
import { branchHealthPollMs } from './config';

/**
 * The till's view of the branch's connectivity.
 *
 * The till polls the branch's health endpoint rather than trusting `navigator.onLine`. `onLine`
 * reports whether the browser has *a* network, not whether the branch and the cloud are reachable:
 * on a shop LAN with the internet down, `onLine` is true but the cloud is not reachable, which is
 * exactly the case the till must show. The branch reports what it saw of the cloud, so the till
 * shows the truth without probing the cloud itself.
 */

export interface BranchHealthState {
  /** null until the first poll completes. */
  cloudStatus: 'online' | 'offline' | 'incompatible' | null;
  databaseUp: boolean | null;
  /** True once a poll has succeeded, i.e. the branch answered. */
  branchReachable: boolean;
  protocolVersion: number | null;
  cloudProtocolVersion: number | null;
  /** The branch must refuse to push (protocol mismatch). */
  pushBlocked: boolean;
  /** Unacked outbox events, or null when the branch did not report a size. */
  outboxSize: number | null;
}

const INITIAL: BranchHealthState = {
  cloudStatus: null,
  databaseUp: null,
  branchReachable: false,
  protocolVersion: null,
  cloudProtocolVersion: null,
  pushBlocked: false,
  outboxSize: null,
};

/**
 * Poll the branch health endpoint on an interval. `probe` asks the branch to refresh its cloud
 * observation; leave it false for a cheap read of the last stored observation. The default interval
 * is five seconds (the brief's cadence).
 */
export function useBranchHealth(options: { intervalMs?: number; probe?: boolean } = {}): BranchHealthState {
  const { intervalMs = branchHealthPollMs(), probe = false } = options;
  const [state, setState] = useState<BranchHealthState>(INITIAL);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;

    const poll = async () => {
      try {
        const response = await fetch(`/api/branch/health${probe ? '?probe=1' : ''}`, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          if (!cancelled.current) setState((current) => ({ ...current, branchReachable: false }));
          return;
        }
        const payload = (await response.json()) as {
          branch_up?: boolean;
          branch_online?: boolean;
          database_up: boolean;
          cloud_status: 'online' | 'offline' | 'incompatible';
          protocol_version: number;
          cloud_protocol_version: number | null;
          push_blocked: boolean;
          outbox_size?: number | null;
        };
        if (cancelled.current) return;
        setState({
          cloudStatus: payload.cloud_status,
          databaseUp: payload.database_up,
          branchReachable: payload.branch_online ?? payload.branch_up ?? true,
          protocolVersion: payload.protocol_version,
          cloudProtocolVersion: payload.cloud_protocol_version,
          pushBlocked: payload.push_blocked,
          outboxSize: payload.outbox_size ?? null,
        });
      } catch {
        // The branch itself is unreachable (LAN blip). The sale path still queues to the outbox.
        if (!cancelled.current) setState((current) => ({ ...current, branchReachable: false }));
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      cancelled.current = true;
      clearInterval(timer);
    };
  }, [intervalMs, probe]);

  return state;
}
