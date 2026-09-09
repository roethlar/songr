/** Observations before authorization; independent of the paired-Core lifecycle. */
export interface DiscoveredCore {
  readonly id: string;
  readonly displayName: string;
  readonly host: string;
  readonly phase: 'connecting' | 'registering' | 'awaiting-approval' | 'registered' | 'failed';
  readonly detail?: string;
}

export interface CoreDiscoveryStatus {
  readonly cores: readonly DiscoveredCore[];
  readonly error?: string;
}

export const CORE_DISCOVERY_WAIT_MS = 15_000;
export const MAX_DISCOVERED_CORES = 32;

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** Project only display data: never forward registry bodies or pairing tokens. */
export function normalizeDiscoveredCore(value: unknown): DiscoveredCore | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const core = value as Record<string, unknown>;
  if (!text(core.id, 256) || !text(core.displayName, 256) || !text(core.host, 256)) return null;
  if (core.phase !== 'connecting' && core.phase !== 'registering' &&
      core.phase !== 'awaiting-approval' && core.phase !== 'registered' && core.phase !== 'failed') return null;
  if (core.detail !== undefined && !text(core.detail, 512)) return null;
  return {
    id: core.id, displayName: core.displayName, host: core.host, phase: core.phase,
    ...(core.detail === undefined ? {} : { detail: core.detail }),
  };
}

export function normalizeCoreDiscoveryStatus(value: unknown): CoreDiscoveryStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = value as Record<string, unknown>;
  if (!Array.isArray(status.cores) || status.cores.length > MAX_DISCOVERED_CORES) return null;
  if (status.error !== undefined && !text(status.error, 512)) return null;
  const cores = status.cores.map(normalizeDiscoveredCore);
  if (cores.some((core) => core === null)) return null;
  const valid = cores as DiscoveredCore[];
  if (new Set(valid.map((core) => core.id)).size !== valid.length) return null;
  return { cores: valid, ...(status.error === undefined ? {} : { error: status.error }) };
}
