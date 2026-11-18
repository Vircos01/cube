# VAS — Voxel Analytics Service: Architectuur & Implementatieplan

## 1. Overzicht en Doelstelling
**VAS (Voxel Analytics Service)** is een containerized, opensource semantische laag en metrics engine — ontworpen als het moderne, cloud-native alternatief voor **SSAS (SQL Server Analysis Services)**. 

VAS combineert de robuuste multidimensionale query- en compilatie-engine met een database-gedreven metadata-architectuur (PostgreSQL), een interactieve Web-UI, Git-versiebeheer en dynamische Row-Level (RLS) en Object-Level Security (OLS).

Belangrijke uitgangspunten:
- **100% Royalty-Free & Merkvrij:** Onafhankelijk van handelsmerken van derden onder de merknaam **VAS (Voxel Analytics Service)**.
- **Minimale impact op Core:** Geen wijzigingen in de upstream compiler- en enginebestanden; alles is gemodulariseerd in `packages/cubejs-management-api`.
- **Zero-Downtime Hot Reload:** Native `repositoryFactory` en `schemaVersion` mechanismen zorgen voor automatische en atomaire hercompilatie zodra een model via de API of UI wordt bijgewerkt.
- **Koppeling met Superset & BI-tools:** VAS SQL-API (PostgreSQL wire protocol op poort 15432) ziet wijzigingen direct na opslag.

---

## 2. Systeemarchitectuur

```mermaid
flowchart TD
    subgraph Client["Clients & Consumers"]
        UI["Web-UI (React + Monaco Editor)"]
        Superset["Apache Superset (BI)"]
        ExternalApp["Externe API Consumers"]
    end

    subgraph CubeContainer["Cube Server Runtime (Docker)"]
        Proxy["Express Server / Gateway (Poort 4000)"]
        MgmtAPI["Management API (/management/v1)"]
        CubeREST["Cube REST API (/cubejs-api/v1)"]
        CubeSQL["Cube SQL API (Poort 15432)"]
        Compiler["@cubejs-backend/schema-compiler"]
        CustomRepo["Custom repositoryFactory & schemaVersion"]
    end

    subgraph Postgres["PostgreSQL Container (Metadata & Data)"]
        MetaDB[("Metadata Tabellen:\n- semantic_models\n- model_revisions\n- audit_logs\n- schema_version_tracker")]
        SourceDB[("Brondata Tabellen (optioneel ecom data)")]
    end

    UI -->|REST + JWT/Secret| MgmtAPI
    ExternalApp -->|REST / GraphQL| CubeREST
    Superset -->|Postgres Wire: 15432| CubeSQL

    MgmtAPI -->|Valideer schema in-memory| Compiler
    MgmtAPI -->|Lees & Schrijf revisies| MetaDB
    MgmtAPI -->|Bump version tracker| MetaDB

    CustomRepo -->|Haal actieve YAML op| MetaDB
    CustomRepo -->|Haal huidige versie op| MetaDB
    Proxy --> MgmtAPI
    Proxy --> CubeREST
    CubeSQL --> CustomRepo
    CubeREST --> CustomRepo
```

---

## 3. Database Model (PostgreSQL Metadata)

### 3.1 `semantic_models`
Basisregistratie van elk semantisch model (cube of view).
- `id` (UUID, Primary Key)
- `name` (VARCHAR(128), UNIQUE): Unieke naam van de cube/view (bijv. `Orders`, `Users`)
- `model_type` (VARCHAR(32)): `cube` of `view`
- `file_name` (VARCHAR(255)): Bestandsnaam (bijv. `orders.cube.yml`)
- `description` (TEXT, optioneel)
- `is_active` (BOOLEAN, default `true`): Zachte verwijdering / activatiestatus
- `created_at` (TIMESTAMPTZ, default `NOW()`)
- `updated_at` (TIMESTAMPTZ, default `NOW()`)

### 3.2 `model_revisions`
Volledig versiebeheer per model met rollback-mogelijkheid.
- `id` (UUID, Primary Key)
- `model_id` (UUID, Foreign Key naar `semantic_models(id)` ON DELETE CASCADE)
- `revision_number` (INT): Oplopend versienummer per model (1, 2, 3...)
- `content` (TEXT): De actuele YAML-definitie
- `content_format` (VARCHAR(16), default `'yaml'`): `'yaml'` of `'json'`
- `parsed_json` (JSONB, optioneel): Geïndexeerde representatie voor snelle bevraging
- `change_summary` (VARCHAR(255), optioneel): Beschrijving van de wijziging
- `status` (VARCHAR(32), default `'active'`): `'active'`, `'draft'`, `'archived'`
- `created_by` (VARCHAR(128), default `'system'`)
- `created_at` (TIMESTAMPTZ, default `NOW()`)

### 3.3 `audit_logs`
Audit-trail voor compliance en monitoring.
- `id` (BIGSERIAL, Primary Key)
- `action` (VARCHAR(64)): `CREATE`, `UPDATE`, `ROLLBACK`, `DELETE`, `VALIDATE`, `IMPORT`, `EXPORT`
- `model_name` (VARCHAR(128))
- `revision_id` (UUID, Foreign Key naar `model_revisions(id)`, optioneel)
- `details` (JSONB): Details van het verzoek, inclusief eventuele validatie-uitkomsten
- `actor` (VARCHAR(128)): Gebruiker of API-key identifier
- `ip_address` (VARCHAR(64))
- `created_at` (TIMESTAMPTZ, default `NOW()`)

### 3.4 `schema_version_tracker`
Globale versie/timestamp-teller voor Cube's `schemaVersion` hook.
- `id` (INT, Primary Key, altijd 1)
- `version` (BIGINT, autoincrement bij elke mutatie)
- `version_hash` (VARCHAR(64), MD5/SHA256 van alle actieve modellen)
- `updated_at` (TIMESTAMPTZ, default `NOW()`)

---

## 4. Fasering & Roadmap

| Fase | Onderdelen | Status |
| :--- | :--- | :--- |
| **Fase 1** | - PostgreSQL migratiescript (`001_initial_schema.sql`)<br>- Custom `repositoryFactory` implementation (`PostgresSchemaRepository`)<br>- `schemaVersion` tracker integratie in `cube.js`<br>- Import / Export utility voor lokale YAML/JS modellen<br>- Unit- en integratietests (15/15 geslaagd) | **✓ Voltooid** |
| **Fase 2** | - Real-time validatie-engine met `@cubejs-backend/schema-compiler`<br>- Management REST API (`GET /models`, `POST /models/validate`, `POST /models`, `PUT /models/:id`, `POST /models/:id/rollback`, `GET /datasources/introspect`)<br>- Beveiliging met JWT / `CUBEJS_API_SECRET`<br>- API documentatie & tests | **✓ Voltooid** |
| **Fase 3** | - Web-UI applicatie (React + Tailwind + Monaco Editor)<br>- Schema explorer, visuele formulieren en live split-view<br>- Versiebeheer & diff-viewer<br>- Ingebouwde SQL-API & Cube query tester | **✓ Voltooid** |
| **Git Integratie** | - `GitService` (`git status`, `git diff`, `git log`, `git commit`, `git pull`, `git checkout`)<br>- REST API endpoints onder `/management/v1/git/...`<br>- Web-UI Git tabblad met live diff-viewer, branch switcher en commit/push modal<br>- Automatische synchronisatie tussen Git repository (`model/`) en PostgreSQL | **✓ Voltooid & Live** |
| **Docker** | - `docker-compose.yml` met PostgreSQL (metadata) + Cube server (API + UI + SQL-API 15432)<br>- Hot-reload geverifieerd in live container | **✓ Voltooid & Live** |
| **Beveiliging (SSAS/RBAC)** | - `checkSqlAuth` in `cube.js` voor authenticatie van BI-tools (Superset, PowerBI, Tableau)<br>- `queryRewrite` voor server-side Row-Level Security (RLS) en Object-Level Security (OLS)<br>- Interactief Security Dashboard & Live SQL Tester in Web-UI op `/admin` | **✓ Voltooid & Geverifieerd** |
| **Data Sources & Schema Explorer** | - Brondatabase configurator (Default VAS DB of Externe PostgreSQL/DWH)<br>- Live verbindingstester met latency & schema detectie (`/datasources/test-connection`)<br>- Introspectie met automatische Foreign Key (relatie) detectie (`/datasources/introspect`)<br>- Batch Table Importer: selecteer tabellen en neem ze met 1 klik op in VAS met auto-dimensions, auto-measures en auto-joins (`/datasources/generate-cubes`) | **✓ Voltooid & Geverifieerd** |

---

## 6. Data Sources & Schema Explorer Functionaliteit

### 1. Brondatabase Verbinding & Multi-Database Orchestratie
- **Default VAS Database:** Maakt direct verbinding met de actieve database via de container environment.
- **Custom / Externe Database:** Configureer Host, Poort, Database, Gebruikersnaam, Wachtwoord, Schema, SSL en **VAS Data Source ID** (bijv. `remote_dwh`). Bevat een `Test Verbinding` knop die live de latentie en beschikbare schema's teruggeeft.
- **Runtime `driverFactory`:** Externe databaseverbindingen worden persistent opgeslagen in de tabel `data_sources` in de PostgreSQL metadatadatabase. Cube's runtime `driverFactory` in `runtime/cube.js` herkent het `data_source` attribuut van de cube en routeert analytics queries dynamisch naar de juiste externe database host/poort/credentials.

### 2. Tabellen & Veilige Relaties Introspectie
- Leest `information_schema.columns` en `table_constraints` uit.
- Detecteert automatisch **Primary Keys** (`id`, etc.) en **Foreign Keys** (bijv. `sample_orders.user_id ➔ sample_users.id`).
- **Veilige Join Filter:** Voorkomt gebroken schemacompilatie door foreign key joins alleen te genereren als de doelcube daadwerkelijk bestaat in VAS of onderdeel uitmaakt van de huidige importbatch. Joins naar niet-geïmporteerde tabellen worden veilig overgeslagen (`skippedJoins`).

### 3. Atomaire Batch Table Importer & Schema Validatie
- **Pre-validatie (`validateBatchSchemas`):** De gehele batch wordt vooraf virtueel gecompileerd met de bestaande modellen vóórdat er iets naar de database geschreven wordt. Syntax- of compilatieproblemen worden vroegtijdig geblokkeerd.
- **Auto-Measures:** Maakt `count`, en genereert automatisch `sum` en `avg` maatstaven voor numerieke kolommen (zoals `amount`, `price`).
- **Atomaire Publicatie (`batchUpsertModels`):** Alle tabellen in een batch worden weggeschreven binnen **één enkele database transactie**. Pas nadat alle modellen succesvol zijn opgeslagen, wordt de `schemaVersion` tracker **exact één keer verhoogd**. Dit garandeert atomaire hot-reload zonder tussenliggende inconsistente toestanden.

---

## 5. Beveiligingsarchitectuur (SSAS-stijl RBAC, RLS & OLS)

### Geconfigureerde Identiteiten & Rechten

| Gebruikersnaam | Wachtwoord | Rol | RLS Beleid (Row-Level Security) | OLS Beleid (Object-Level Security) | Verwacht resultaat (`SELECT * FROM Orders`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`admin`** | `admin` | `admin` (Superuser) | Geen beperking (ziet alle rijen wereldwijd) | Alle maatstaven toegestaan (`count`, `total_amount`, `avg_order_value`) | 7 bestellingen ($2.056,46) |
| **`sales_amsterdam`** | `amsterdam123` | `sales_rep` | `Users.city = 'Amsterdam'` | `Orders.avg_order_value` **geblokkeerd** (`Access Denied`) | 2 bestellingen ($399,49) |
| **`sales_rotterdam`** | `rotterdam123` | `sales_rep` | `Users.city = 'Rotterdam'` | Standaard verkoopmaatstaven toegestaan | 2 bestellingen ($328,99) |

### Verbinding via Apache Superset / BI Tools
- **Host:** `localhost` (of `cube-core-server` binnen Docker network)
- **Poort:** `15432`
- **Database:** `cubedb`
- **Protocol:** PostgreSQL Wire Protocol v3
