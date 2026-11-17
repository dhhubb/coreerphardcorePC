import type { BranchHealthState } from './useBranchHealth';

/**
 * The till's connectivity badge, as a pure function of the health the branch reports.
 *
 * Three colours, fixed by the brief:
 *   green  — the branch and the cloud are both up;
 *   yellow — the LAN (branch) is up but the cloud is not, so sales queue locally;
 *   red    — the branch itself cannot be reached.
 *
 * Keeping the decision here (not inline in the page) makes it testable without a browser: the page
 * renders exactly what this returns.
 */

export type BadgeTone = 'green' | 'yellow' | 'red';

export interface BadgeState {
  tone: BadgeTone;
  /** The value of the badge's data-status attribute. */
  status: 'online' | 'offline' | 'incompatible' | 'branch-down';
  label: string;
}

export function badgeState(health: BranchHealthState): BadgeState {
  if (!health.branchReachable) {
    return { tone: 'red', status: 'branch-down', label: 'Branch unreachable — sales queue locally' };
  }

  if (health.cloudStatus === 'online') {
    return { tone: 'green', status: 'online', label: 'Cloud online' };
  }

  if (health.cloudStatus === 'incompatible') {
    return {
      tone: 'yellow',
      status: 'incompatible',
      label: `Cloud version mismatch (branch ${health.protocolVersion}, cloud ${health.cloudProtocolVersion}) — sync paused`,
    };
  }

  const queued = health.outboxSize && health.outboxSize > 0 ? ` · ${health.outboxSize} queued` : '';
  return { tone: 'yellow', status: 'offline', label: `Cloud offline — LAN up${queued}` };
}

/** The CSS class for a tone. */
export function badgeClass(tone: BadgeTone): string {
  return tone === 'green' ? 'badge badge-up' : tone === 'yellow' ? 'badge badge-warn' : 'badge badge-off';
}
