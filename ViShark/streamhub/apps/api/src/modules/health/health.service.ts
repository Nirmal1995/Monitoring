import type { Logger } from 'pino';
import type { Metrics } from '../../infrastructure/metrics.ts';

/**
 * Liveness: "is this process able to run at all?" It must not depend on
 * MongoDB or anything else external. If it did, a short database outage would
 * make the orchestrator restart every API container, turning a dependency
 * blip into a full outage.
 *
 * Readiness: "should this instance receive traffic right now?" It checks the
 * dependencies a request needs, and is also false while shutting down so the
 * load balancer stops routing new requests before the process exits.
 */
export type DependencyCheck = {
  name: string;
  check: () => Promise<void>;
};

export type DependencyStatus = { name: string; status: 'up' | 'down'; latencyMs: number };

export type ReadinessReport = {
  status: 'ready' | 'not_ready';
  draining: boolean;
  dependencies: DependencyStatus[];
};

const CHECK_TIMEOUT_MS = 2000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class HealthService {
  private draining = false;
  private readonly checks: DependencyCheck[];
  private readonly logger: Logger;
  private readonly metrics: Metrics | undefined;

  constructor(checks: DependencyCheck[], logger: Logger, metrics?: Metrics) {
    this.checks = checks;
    this.logger = logger;
    this.metrics = metrics;
  }

  startDraining(): void {
    this.draining = true;
  }

  async readiness(): Promise<ReadinessReport> {
    const dependencies = await Promise.all(
      this.checks.map(async ({ name, check }): Promise<DependencyStatus> => {
        const started = performance.now();
        try {
          await withTimeout(check(), CHECK_TIMEOUT_MS);
          this.metrics?.dependencyUp.set({ dependency: name }, 1);
          return { name, status: 'up', latencyMs: Math.round(performance.now() - started) };
        } catch (err) {
          this.metrics?.dependencyUp.set({ dependency: name }, 0);
          // Details go to the log only; the HTTP response says just "down".
          this.logger.warn({ dependency: name, err }, 'readiness check failed');
          return { name, status: 'down', latencyMs: Math.round(performance.now() - started) };
        }
      }),
    );
    const allUp = dependencies.every((d) => d.status === 'up');
    return {
      status: allUp && !this.draining ? 'ready' : 'not_ready',
      draining: this.draining,
      dependencies,
    };
  }
}
