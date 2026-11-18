import {
  logger,
  redactSensitiveData,
} from '../../src/observability/logger';
import { MetricsRegistry } from '../../src/observability/metrics';
import { performHealthCheck } from '../../src/observability/health';
import { Pool } from 'pg';

describe('Fase 5 — Observability, Structured Logging & Redaction', () => {
  it('redactSensitiveData should redact passwords, secrets, tokens, and authorization', () => {
    const input = {
      username: 'admin',
      password: 'super-secret-password-123',
      api_secret: 'secret-token-value',
      authorization: 'Bearer eyJhbGciOiJIUzI1Ni...',
      connectionString: 'postgres://admin:secret123@db.example.com:5432/cubedb',
      nested: {
        dbPassword: 'nested-pass',
        normalField: 'hello',
      },
      list: [
        { secretKey: 'key-1' },
        'normal',
      ],
    };

    const redacted = redactSensitiveData(input);

    expect(redacted.username).toBe('admin');
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.api_secret).toBe('[REDACTED]');
    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted.connectionString).toBe('postgres://admin:[REDACTED]@db.example.com:5432/cubedb');
    expect(redacted.nested.dbPassword).toBe('[REDACTED]');
    expect(redacted.nested.normalField).toBe('hello');
    expect(redacted.list[0].secretKey).toBe('[REDACTED]');
    expect(redacted.list[1]).toBe('normal');
  });

  it('logger should run with context and capture requestId in store', () => {
    logger.runWithContext({ requestId: 'test-req-12345', actor: 'test-user' }, () => {
      const ctx = logger.getContext();
      expect(ctx?.requestId).toBe('test-req-12345');
      expect(ctx?.actor).toBe('test-user');
    });
  });
});

describe('Fase 5 — Metrics Collection & Prometheus Export', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  it('records HTTP requests and calculates percentile latencies', () => {
    registry.recordRequest('GET', '/management/v1/models', 200, 10);
    registry.recordRequest('GET', '/management/v1/models', 200, 20);
    registry.recordRequest('GET', '/management/v1/models', 200, 30);
    registry.recordRequest('POST', '/management/v1/models', 201, 15);

    const summary = registry.getSummaryJson();

    expect(summary.service).toBe('voxel-analytics-service');
    expect(summary.endpoints['GET /management/v1/models 200']).toBeDefined();
    expect(summary.endpoints['GET /management/v1/models 200'].requestsCount).toBe(3);
    expect(summary.endpoints['GET /management/v1/models 200'].avgDurationMs).toBe(20);
    expect(summary.endpoints['GET /management/v1/models 200'].p50Ms).toBe(20);
  });

  it('records compiler validation metrics', () => {
    registry.recordCompilerValidation(true, 45);
    registry.recordCompilerValidation(true, 55);
    registry.recordCompilerValidation(false, 30);

    const summary = registry.getSummaryJson();

    expect(summary.compiler.totalValidations).toBe(3);
    expect(summary.compiler.failedValidations).toBe(1);
    expect(summary.compiler.avgDurationMs).toBeCloseTo(43.33, 1);
  });

  it('exports metrics in Prometheus plain text format', () => {
    registry.recordRequest('GET', '/management/v1/models', 200, 15);
    registry.recordCompilerValidation(true, 50);

    const prom = registry.getPrometheusText();

    expect(prom).toContain('# HELP vas_uptime_seconds');
    expect(prom).toContain('vas_compiler_validations_total{status="success"} 1');
    expect(prom).toContain('vas_compiler_validations_total{status="failed"} 0');
    expect(prom).toContain('vas_http_requests_total{method="GET",route="/management/v1/models",status="200"} 1');
  });
});

describe('Fase 5 — Deep Health Check & Failure State', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
      totalCount: 10,
      idleCount: 8,
      waitingCount: 0,
    };
  });

  it('performHealthCheck returns ok status when database is healthy', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // SELECT 1
      .mockResolvedValueOnce({ rows: [{ count: '3' }] }) // count models
      .mockResolvedValueOnce({ rows: [{ version: 5, version_hash: 'abc', updated_at: '2026-11-18T10:00:00Z' }] }); // schema_version_tracker

    const result = await performHealthCheck(mockPool as Pool);

    expect(result.status).toBe('ok');
    expect(result.database.connected).toBe(true);
    expect(result.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.database.pool.totalCount).toBe(10);
    expect(result.database.pool.idleCount).toBe(8);
    expect(result.models?.activeCount).toBe(3);
    expect(result.schemaVersion).toMatch(/^v5_abc_\d+$/);
  });

  it('performHealthCheck returns unhealthy (503) when database connection fails', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('Connection terminated'));

    const result = await performHealthCheck(mockPool as Pool);

    expect(result.status).toBe('unhealthy');
    expect(result.database.connected).toBe(false);
    expect(result.database.error).toBe('Connection terminated');
  });
});
