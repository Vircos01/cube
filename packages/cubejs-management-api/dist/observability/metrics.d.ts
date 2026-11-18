export interface RequestMetric {
    count: number;
    totalDurationMs: number;
    durations: number[];
}
export declare class MetricsRegistry {
    private requestCounts;
    private compilerValidationsTotal;
    private compilerValidationsFailed;
    private compilerDurationsMs;
    private startTime;
    recordRequest(method: string, route: string, statusCode: number, durationMs: number): void;
    recordCompilerValidation(success: boolean, durationMs: number): void;
    private calculatePercentile;
    getSummaryJson(): Record<string, any>;
    getPrometheusText(): string;
    reset(): void;
}
export declare const metrics: MetricsRegistry;
//# sourceMappingURL=metrics.d.ts.map