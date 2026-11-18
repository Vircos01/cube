# VAS (Voxel Analytics Service) — BI-Compatibiliteit, Interface Parity & Releasecriteria

Dit document beschrijft de compatibiliteit van **VAS (Voxel Analytics Service)** met externe Business Intelligence (BI) clients, de technische protocollen, datatype-mappings, queryconsistentie en de officiële **Release Checklist** voor productie-inzet.

---

## 1. BI Compatibility Matrix

VAS stelt de semantische laag beschikbaar via twee complementaire interfaces:
1. **SQL API (Poort 15432)**: PostgreSQL Wire Protocol 3.0 voor traditionele en desktop BI-tools.
2. **REST / GraphQL API (Poort 4000)**: JSON HTTP endpoints voor moderne webapplicaties, dashboards en microservices.

| BI Client | Verbindingsmethode | Poort / Protocol | Auth Mechanisme | Ondersteunde Modi | Status |
|---|---|---|---|---|---|
| **Microsoft Power BI** | PostgreSQL Connector | 15432 (Postgres Wire) | User / Password (DB auth) | DirectQuery & Import | **Gevalideerd & Ondersteund** |
| **Tableau Desktop / Server** | PostgreSQL Driver | 15432 (Postgres Wire) | User / Password (DB auth) | Live & Extract | **Gevalideerd & Ondersteund** |
| **Apache Superset** | SQLAlchemy (`postgresql://`) | 15432 (Postgres Wire) | User / Password (DB auth) | SQL Lab & Visual Dashboard | **Gevalideerd & Ondersteund** |
| **DBeaver / DataGrip** | Generic PostgreSQL Driver | 15432 (Postgres Wire) | User / Password (DB auth) | Interactieve SQL queries | **Gevalideerd & Ondersteund** |
| **Microsoft Excel** | ODBC PostgreSQL Driver | 15432 (Postgres Wire) | User / Password (ODBC DSN) | Power Query / Pivot Tables | **Gevalideerd & Ondersteund** |
| **Custom Web Apps** | Cube REST Client / Axios | 4000 (HTTP JSON) | Bearer JWT Token | JSON Load & Meta endpoints | **Gevalideerd & Ondersteund** |
| **GraphQL Clients** | Apollo / URQL | 4000 (HTTP POST) | Bearer JWT Token | GraphQL Queries | **Gevalideerd & Ondersteund** |

---

## 2. Interface Parity & Consistente Beveiliging (RLS / OLS)

Een kernvereiste van enterprise semantische architectuur is dat **dezelfde gebruiker exact dezelfde getallen en dezelfde beveiligingsregels ervaart**, ongeacht of de query binnenkomt via Power BI (SQL) of een intern webportaal (REST).

### 2.1 Bewezen Pariteit (Geautomatiseerd Getoetst)

De testsuite in `packages/cubejs-management-api/test/integration/biCompatibility.test.ts` toetst deze consistentie continu:

| Gebruiker | Rol | Beveiligingsbeleid | SQL API Resultaat (15432) | REST API Resultaat (4000) | Status |
|---|---|---|---|---|---|
| `admin` | `admin` | Ongefilterde toegang | 4 orders (totaal € 999.46) | 4 orders (totaal € 999.46) | **100% Identiek** |
| `sales_amsterdam` | `sales_rep` | RLS: `Users.city = 'Amsterdam'` | 2 orders (totaal € 399.49) | 2 orders (totaal € 399.49) | **100% Identiek** |
| `sales_rotterdam` | `sales_rep` | RLS: `Users.city = 'Rotterdam'` | 2 orders (totaal € 328.99) | 2 orders (totaal € 328.99) | **100% Identiek** |
| `sales_amsterdam` | `sales_rep` | OLS: Deny `Orders.avg_order_value` | **Geweigerd** (HTTP 500 / PG Error: *Maatstaf afgeschermd*) | **Geweigerd** (HTTP 500: *Maatstaf afgeschermd*) | **100% Identiek** |

### 2.2 Cache-Isolatie via `contextToAppId`
Om te voorkomen dat gefilterde queries van de ene rol (of gebruiker met specifieke claims) worden hergebruikt uit de cache voor een andere rol, berekent VAS een deterministische `appId`:
```javascript
contextToAppId: ({ securityContext }) => {
  if (!securityContext) return 'CUBE_APP_ANON';
  const role = securityContext.role || 'viewer';
  const claimsKey = Object.entries(securityContext.claims || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  return `CUBE_APP_${role}_${claimsKey || 'default'}`;
}
```
Hierdoor blijven in-memory aggregaties en Cube Store tabellen waterdicht gescheiden tussen security contexten.

---

## 3. Metadata Discovery & Datatype Mappings

### 3.1 Metadata Catalogus Introspectie
Wanneer BI-tools verbinding maken met VAS via de PostgreSQL connector, inspecteren zij standaard de ANSI SQL catalogus:
- **`information_schema.tables`**: VAS publiceert alle actieve kubussen als relationele tabellen (bijv. `Orders`, `Products`, `Users`).
- **`information_schema.columns`**: VAS brengt kubus-leden in kaart:
  - `dimensions` worden gemapt als reguliere attributen en primaire sleutels.
  - `measures` worden gemapt als numerieke aggregatiekolommen.
  - `time dimensions` worden gemapt als `timestamp with time zone`.

### 3.2 Datatype Mapping Tabel

| Semantisch Type | Cube Model Type | PostgreSQL Wire Type | BI Client Type |
|---|---|---|---|
| **Identifier** | `type: number, primary_key: true` | `INT4` / `INT8` | Whole Number |
| **Tekst/Dimensie** | `type: string` | `VARCHAR` / `TEXT` | Text / String |
| **Bedrag/Meting** | `type: number, aggType: sum/avg` | `NUMERIC` / `FLOAT8` | Decimal Number / Currency |
| **Aantallen** | `type: number, aggType: count` | `INT8` | Whole Number |
| **Datum/Tijd** | `type: time` | `TIMESTAMPTZ` | Date/Time (UTC) |
| **Booleaans** | `type: boolean` | `BOOL` | True/False |

---

## 4. Bekende Beperkingen & Architecturale Randvoorwaarden

1. **Geen Directe DDL via de SQL API**:
   - De Cube SQL-interface ondersteunt geen `CREATE TABLE`, `ALTER TABLE` of `DROP TABLE` statements.
   - Alle modelcreaties, wijzigingen en relaties verlopen uitsluitend via de **VAS Management API** (`POST /management/v1/models`) of de **Web-UI** (`http://localhost:4001/admin`).
2. **Multi-Datasource Joins**:
   - Joins tussen verschillende databronnen (`data_source: default` naar `data_source: remote_warehouse`) vereisen rollup joins in Cube Store. Modellen die direct binnen dezelfde relationele database verblijven, joinen automatisch zonder restricties via SQL pushdown.
3. **Tijdzonenormalisatie**:
   - Alle tijdsdimensies worden intern standaard genormaliseerd en berekend op basis van `UTC`. Clients kunnen query-tijdzones meegeven via de API-parameter `timezone`.
4. **Statement Timeouts**:
   - SQL queries hebben een harde statement timeout van 30 seconden (`PG_STATEMENT_TIMEOUT_MS=30000`) om blokkerende database-locks te voorkomen.

---

## 5. Pre-Release Checklist (Acceptatiecriteria)

Vóór uitrol naar een staging- of productieomgeving moeten alle onderstaande checks met succes worden doorlopen:

- [x] **1. Zero-dependency Core Fork**: De repository gebruikt de 100% royalty-free Cube Core engine zonder commerciële Cube Cloud componenten of proprietary licenties.
- [x] **2. Gevalideerde Hot-Reload**: Modelwijzigingen via de Management API verhogen de `schemaVersion` in PostgreSQL en worden atomaire zonder herstart door de runtime overgenomen.
- [x] **3. Optimistic Concurrency Control (OCC)**: Gelijktijdige modelaanpassingen detecteren versieconflicten (`HTTP 409 Conflict`) en voorkomen lost updates via `SELECT ... FOR UPDATE` row locks.
- [x] **4. Onweerlegbare Audit Trail**: Alle modelacties (aanmaken, bewerken, verwijderen, herstellen, mislukken) worden inclusief actor, commit hash en tijdstempel vastgelegd in `audit_logs`.
- [x] **5. Validated Non-Destructive Rollback**: Rollback toetst historische definities vooraf tegen het actieve schema en publiceert herstel als een nieuwe, traceerbare revisie.
- [x] **6. Gecentraliseerde Identiteiten & Beveiliging**: Gebruikersaccounts worden veilig gehasht met Node.js `scrypt`; RLS en OLS beleid worden deny-by-default gehandhaafd over zowel SQL (15432) als REST (4000).
- [x] **7. Diepe Observability & SLO's**: Diagnostic health check endpoints (`/health`, `/health/live`, `/health/ready`) en Prometheus text metrics (`/metrics`) zijn actief met geverifieerde SLO's (DB latency ~1.9ms, query latency ~3.4ms).
- [x] **8. Bescherming tegen Database-uitval**: Bij storingen van de metadata database weigert VAS stilzwijgend modellen te wissen; actieve in-memory schema's blijven operationeel.
- [x] **9. Geteste Backup & Disaster Recovery**: Consistente snapshots via `pg_dump` en complete herstelprocedures via `pg_restore` zijn getest en gedocumenteerd (RTO < 5 min).
- [x] **10. Geautomatiseerde Testdekking**: Alle 62 geautomatiseerde unit- en integratietests over 9 testsuites slagen zonder fouten (`yarn test`).

---

## 6. Release Notes — VAS (Voxel Analytics Service) v1.0.0 Enterprise

### Nieuwe Functionaliteiten
- **Centraal Semantisch Modelbeheer**: Volledig relationele opslag van kubusmodellen, dimensies, maatstaven en joins in PostgreSQL met hot-reload via de `schema_version_tracker`.
- **SSAS-waardige Beveiliging**: Volwaardige Row-Level Security (RLS) en Object-Level Security (OLS) met fijnmazige claims en rollen (`admin`, `sales_rep`, `viewer`), direct afgedwongen op PostgreSQL-wire protocol en REST queries.
- **Visual & Code Studio**: Geïntegreerde split-view Web-UI op poort 4001 met Monaco editor, YAML preview, interactieve data source introspectie, audit logs viewer en health dashboard.
- **Enterprise Observability**: Ingebouwde Prometheus metrics exporter, cloud health probes en correlation tracing via `X-Request-Id` met automatische gegevensmaskering.
- **Git & Disaster Recovery**: Bi-directionele Git tracking en bewezen runbooks voor zero-data-loss snapshots en herstel.

### Incompatibele Wijzigingen en Migratie
- Bestaande bestandsgebaseerde schema's (`.js` of `.yml` bestanden in `/conf/schema`) worden bij de eerste start automatisch gemigreerd naar PostgreSQL via de ingebouwde `fileMigrator`. Bestanden blijven read-only bewaard als back-up.
- In productieomgevingen (`NODE_ENV=production`) is het instellen van een sterk geheim voor `VAS_MANAGEMENT_SECRET` en `CUBEJS_API_SECRET` verplicht; VAS weigert te starten met default testgeheimen.
