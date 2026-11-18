# VAS (Voxel Analytics Service) — Observability & Performance

Dit document beschrijft de architectuur, endpoints, logging-standaarden, faalmechanismen en Service Level Objectives (SLO's) voor monitoring en performance van **VAS (Voxel Analytics Service)**.

---

## 1. Observability Architectuur

VAS hanteert een non-intrusieve, zero-external-agent benadering voor observability. Alle telemetrie is direct via standaard HTTP- en Prometheus-protocollen uit te lezen, compatibel met Prometheus, Grafana, Datadog en cloud health probes (Kubernetes, AWS ALB, GCP Cloud Run).

```
                      ┌────────────────────────────────────────┐
                      │      Prometheus / Datadog / ALB        │
                      └──────────────────┬─────────────────────┘
                                         │ Scrape / Health Poll
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ VAS (Voxel Analytics Service)                                                │
│                                                                             │
│  ┌─────────────────────────┐   ┌─────────────────┐   ┌───────────────────┐  │
│  │ Health Check Engine     │   │ MetricsRegistry │   │ Structured Logger │  │
│  │ - /health               │   │ - Prometheus txt│   │ - AsyncContext    │  │
│  │ - /health/live          │   │ - JSON summary  │   │ - Redaction mask  │  │
│  │ - /health/ready         │   │ - p50, p95, p99 │   │ - JSON in prod    │  │
│  └───────────┬─────────────┘   └────────┬────────┘   └─────────┬─────────┘  │
│              │                          │                      │            │
│              └──────────────────────────┼──────────────────────┘            │
│                                         ▼                                   │
│                        ┌─────────────────────────────────┐                  │
│                        │ PostgreSQL Metadata & Data Pool │                  │
│                        │ max: 20, timeouts: 5s/30s       │                  │
│                        └─────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Health Check & Probe Endpoints

VAS biedt drie niveaus van health checks volgens cloud-native standaarden:

### 2.1 Deep Diagnostic Health (`GET /management/v1/health`)
Voert een actieve verificatie uit op alle subsystemen:
1. **Database Connectiviteit**: Voert een ping-query (`SELECT 1`) uit en meet de roundtrip latentie in milliseconden.
2. **Connection Pool Status**: Evalueert actieve (`totalCount`), beschikbare (`idleCount`) en wachtende (`waitingCount`) verbindingen.
3. **Model Runtime Status**: Telt het aantal actieve semantische modellen in de metadata database en rapporteert de actieve `schemaVersion`.

**Succes Response (HTTP 200 OK):**
```json
{
  "status": "ok",
  "timestamp": "2026-11-18T14:52:23.419Z",
  "uptimeSeconds": 8,
  "schemaVersion": "v29_584c460fc4f54c5f1643ff0c3144ce53_1795013535478",
  "database": {
    "connected": true,
    "latencyMs": 2,
    "pool": {
      "totalCount": 1,
      "idleCount": 1,
      "waitingCount": 0
    }
  },
  "models": {
    "activeCount": 3
  }
}
```

**Fout Response (HTTP 503 Service Unavailable):**
Wanneer de metadata database onbereikbaar is of de pool uitgeput is:
```json
{
  "status": "unhealthy",
  "timestamp": "2026-11-18T14:55:00.000Z",
  "uptimeSeconds": 45,
  "database": {
    "connected": false,
    "latencyMs": 5002,
    "error": "Connection timeout after 5000ms"
  }
}
```

### 2.2 Liveness Probe (`GET /management/v1/health/live`)
Lichtgewicht check die uitsluitend bevestigt dat het Node.js proces en de event loop responsief zijn.
- **HTTP 200 OK**: `{"status": "ok", "uptimeSeconds": 12}`

### 2.3 Readiness Probe (`GET /management/v1/health/ready`)
Geschikt voor load balancers en Kubernetes traffic routing. Keert pas `HTTP 200` terug als de database actief is en verbindingen accepteert.
- **HTTP 200 OK**: `{"ready": true, "status": "ok", ...}`
- **HTTP 503 Service Unavailable**: `{"ready": false, "status": "unhealthy", ...}`

---

## 3. Metrics & Prometheus Exporter (`GET /management/v1/metrics`)

VAS beschikt over een in-memory rolling histogram registry. Er worden geen externe zware afhankelijkheden gebruikt.

### 3.1 Content Negotiation
- **`Accept: application/json`** (of default browser): Retourneert een gestructureerde JSON-samenvatting met geheugengebruik, compiler-statistieken en rolling latenties (`avg`, `p50`, `p95`, `p99`) per endpoint.
- **`Accept: text/plain`** (of `?format=prometheus`): Retourneert officiële Prometheus / OpenMetrics compliant data voor directe scraping.

### 3.2 Voorbeeld Prometheus Scrape Output
```text
# HELP vas_uptime_seconds Total service uptime in seconds
# TYPE vas_uptime_seconds gauge
vas_uptime_seconds 48

# HELP vas_memory_heap_used_bytes Process heap memory used in bytes
# TYPE vas_memory_heap_used_bytes gauge
vas_memory_heap_used_bytes 68010496

# HELP vas_compiler_validations_total Total schema compiler validations
# TYPE vas_compiler_validations_total counter
vas_compiler_validations_total{status="success"} 14
vas_compiler_validations_total{status="failed"} 0

# HELP vas_http_requests_total Total HTTP requests handled
# TYPE vas_http_requests_total counter
vas_http_requests_total{method="GET",route="/management/v1/health",status="200"} 25
vas_http_requests_total{method="POST",route="/cubejs-api/v1/load",status="200"} 30
```

---

## 4. Gestructureerde Logging & Sensitive Data Redaction

### 4.1 Request Correlation & Tracing
Elk inkomend HTTP-verzoek wordt voorzien van een correlation ID:
- Leest `X-Request-Id` of `X-Correlation-Id` uit de request headers.
- Indien afwezig genereert VAS een cryptografische UUID v4 (`crypto.randomUUID()`).
- Stelt het antwoord-header `X-Request-Id` in voor client-side traceerbaarheid.
- Koppelt de trace ID automatisch aan alle interne logregels via `AsyncLocalStorage`.

### 4.2 Automatische Gegevensmaskering (Redaction)
Om data- en beveiligingslekken in logaggregators (zoals Datadog, CloudWatch, Loki) te voorkomen, maskeert VAS recursief:
- Velden met namen zoals `password`, `secret`, `token`, `jwt`, `authorization`, `cookie`, `apiKey`.
- Connection string credentials: `postgres://user:geheim@host:5432/db` wordt automatisch gemaskeerd naar `postgres://user:[REDACTED]@host:5432/db`.
- Bearer tokens: `Bearer eyJ...` wordt vervangen door `Bearer [REDACTED]`.

### 4.3 Logformaten
- **In Productie (`NODE_ENV=production`)**: Strikte single-line JSON (`{"timestamp":"...","level":"info","message":"...","context":{...}}`).
- **In Ontwikkeling**: Geformatteerde ANSI-gekleurde console logs.

---

## 5. Betrouwbaarheid & Faalgedrag

### 5.1 Bescherming tegen Silent Model Wipe
In upstream Cube Core leidt een databasefout in `repositoryFactory.dataSchemaFiles` tot een lege array (`[]`) als er fouten optreden. Hierdoor compileerde Cube voorheen een leeg schema en verdwenen alle modellen geruisloos uit het geheugen.

**VAS Beveiliging:**
In `runtime/cube.js` werpt `repositoryFactory.dataSchemaFiles` nu een kritieke exception op bij database-uitval:
```javascript
repositoryFactory: (context) => ({
  dataSchemaFiles: async () => {
    try {
      const models = await getActiveModels(pool);
      return models.map(m => ({ fileName: `${m.name}.yml`, content: m.content }));
    } catch (err) {
      console.error('[VAS FATAL] Failed to fetch semantic models from metadata database:', err.message);
      // Kritieke fout: werp exception zodat Cube het vorige geldige gecompileerde schema behoudt
      throw new Error(`[VAS FATAL] Metadata store failure: ${err.message}`);
    }
  }
})
```
Hierdoor blijft het bestaande geldige semantische schema in-memory beschikbaar en worden actieve BI-clients niet abrupt geconfronteerd met ontbrekende tabellen.

### 5.2 Timeouts & Resource Limieten
Om resource-uitputting (DoS) en hung transactions te voorkomen, zijn de volgende limieten strikt geconfigureerd:
- **Connection Timeout**: 5.000 ms (`connectionTimeoutMillis: 5000`).
- **Idle Client Timeout**: 30.000 ms (`idleTimeoutMillis: 30000`).
- **Database Statement Timeout**: 30.000 ms (`statement_timeout = 30000`).
- **Maximum Connection Pool Size**: 20 verbindingen per VAS-instantie.
- **Batch Import Limiet**: Maximaal 50 tabellen per batch (`HTTP 400 - Importlimiet overschreden`).
- **Request Body Limiet**: 10 MB per JSON request payload.

---

## 6. Empirische Benchmarks & Service Level Objectives (SLO's)

### 6.1 Benchmark Resultaten (Metingen op representatieve containerinfrastructuur)

| Component | Meting | Resultaat (avg) | p50 | p95 |
|---|---|---|---|---|
| **Deep Health Check** | DB Ping + Pool Stats + Model Count | **1.94 ms** | 1.01 ms | 19.05 ms |
| **Cube Query Latency** | Multi-measure aggregatie (Orders by status) | **3.44 ms** | 3.14 ms | 5.51 ms |
| **Compiler Pre-validatie** | In-memory validatie van complex YAML model | **12.5 ms** | 11.0 ms | 18.2 ms |
| **Geheugengebruik** | RSS / Heap na compile & queries | **Heap: ~65 MB** | RSS: ~205 MB | Stabiel |

### 6.2 Vastgestelde Service Level Objectives (SLO's)

1. **Beschikbaarheid (Availability):**
   - **Doel:** 99.9% uptime voor de Semantic Query Layer en Management API.
   - **Meetmethode:** Succespercentage op `/management/v1/health/ready` (drempelwaarde HTTP 200).
2. **Schema Compilatie & Validatie Latentie:**
   - **Doel:** p95 < 500 ms voor individuele modelvalidatie; p95 < 2.000 ms voor batch imports tot 50 modellen.
   - **Meetmethode:** `vas_compiler_validations_duration_ms` histogram.
3. **Query Latentie (Semantic Layer):**
   - **Doel:** p95 < 250 ms voor in-cache geaggregeerde queries; p95 < 2.000 ms voor cold queries op de relationele PostgreSQL opslag.
   - **Meetmethode:** Prometheus HTTP histogram `vas_http_requests_total` op `/cubejs-api/v1/load`.
4. **Database Connection Pool Verzadiging:**
   - **Doel:** `waitingCount` permanent 0; actieve pool utilization < 75% onder nominale belasting.
   - **Meetmethode:** Prometheus gauge `vas_database_pool_waiting_clients`.
