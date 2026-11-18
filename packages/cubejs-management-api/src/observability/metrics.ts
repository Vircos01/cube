export interface RequestMetric {
  count: number;
  totalDurationMs: number;
  durations: number[];
}

export class MetricsRegistry {
  private requestCounts: Map<string, RequestMetric> = new Map();
  private compilerValidationsTotal = 0;
  private compilerValidationsFailed = 0;
  private compilerDurationsMs: number[] = [];
  private startTime = Date.now();

  public recordRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const key = `${method} ${route} ${statusCode}`;
    let metric = this.requestCounts.get(key);
    if (!metric) {
      metric = { count: 0, totalDurationMs: 0, durations: [] };
      this.requestCounts.set(key, metric);
    }
    metric.count += 1;
    metric.totalDurationMs += durationMs;
    // Keep last 100 durations for percentiles
    if (metric.durations.length >= 100) {
      metric.durations.shift();
    }
    metric.durations.push(durationMs);
  }

  public recordCompilerValidation(success: boolean, durationMs: number): void {
    this.compilerValidationsTotal += 1;
    if (!success) this.compilerValidationsFailed += 1;
    if (this.compilerDurationsMs.length >= 100) {
      this.compilerDurationsMs.shift();
    }
    this.compilerDurationsMs.push(durationMs);
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return Number((sorted[Math.max(0, index)] || 0).toFixed(2));
  }

  public getSummaryJson(): Record<string, any> {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const mem = process.memoryUsage();

    const endpoints: Record<string, any> = {};
    for (const [key, metric] of this.requestCounts.entries()) {
      endpoints[key] = {
        requestsCount: metric.count,
        avgDurationMs: Number((metric.totalDurationMs / (metric.count || 1)).toFixed(2)),
        p50Ms: this.calculatePercentile(metric.durations, 50),
        p95Ms: this.calculatePercentile(metric.durations, 95),
        p99Ms: this.calculatePercentile(metric.durations, 99),
      };
    }

    return {
      service: 'voxel-analytics-service',
      uptimeSeconds,
      memory: {
        rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
        heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
        heapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
      },
      compiler: {
        totalValidations: this.compilerValidationsTotal,
        failedValidations: this.compilerValidationsFailed,
        avgDurationMs: this.compilerDurationsMs.length > 0
          ? Number((this.compilerDurationsMs.reduce((a, b) => a + b, 0) / this.compilerDurationsMs.length).toFixed(2))
          : 0,
        p95Ms: this.calculatePercentile(this.compilerDurationsMs, 95),
      },
      endpoints,
    };
  }

  public getPrometheusText(): string {
    const lines: string[] = [
      '# HELP vas_uptime_seconds Total service uptime in seconds',
      '# TYPE vas_uptime_seconds gauge',
      `vas_uptime_seconds ${Math.floor((Date.now() - this.startTime) / 1000)}`,
      '',
      '# HELP vas_memory_heap_used_bytes Process heap memory used in bytes',
      '# TYPE vas_memory_heap_used_bytes gauge',
      `vas_memory_heap_used_bytes ${process.memoryUsage().heapUsed}`,
      '',
      '# HELP vas_compiler_validations_total Total schema compiler validations',
      '# TYPE vas_compiler_validations_total counter',
      `vas_compiler_validations_total{status="success"} ${this.compilerValidationsTotal - this.compilerValidationsFailed}`,
      `vas_compiler_validations_total{status="failed"} ${this.compilerValidationsFailed}`,
      '',
      '# HELP vas_http_requests_total Total HTTP requests handled',
      '# TYPE vas_http_requests_total counter',
    ];

    for (const [key, metric] of this.requestCounts.entries()) {
      const parts = key.split(' ');
      const method = parts[0];
      const route = parts.slice(1, -1).join(' ');
      const status = parts[parts.length - 1];
      lines.push(`vas_http_requests_total{method="${method}",route="${route}",status="${status}"} ${metric.count}`);
    }

    return lines.join('\n') + '\n';
  }

  public reset(): void {
    this.requestCounts.clear();
    this.compilerValidationsTotal = 0;
    this.compilerValidationsFailed = 0;
    this.compilerDurationsMs = [];
    this.startTime = Date.now();
  }
}

export const metrics = new MetricsRegistry();
