# Cube Core Management API & Web-UI

Een volwaardige Web-UI en modulaire Management REST API bovenop **Cube Core**, waarmee de volledige semantische laag (cubes, views, dimensions, measures, joins en pre-aggregations) dynamisch in een PostgreSQL metadata-database wordt beheerd, gevalideerd en live herladen — zonder handmatig YAML-bestanden te bewerken of containers te herstarten.

---

## 🚀 Snelle Start (Docker Compose)

Start de volledige stack met één commando:

```bash
docker compose up -d
```

### Beschikbare Interfaces & Poorten:
| Service | URL / Poort | Beschrijving |
| :--- | :--- | :--- |
| **Web-UI (Beheeromgeving)** | `http://localhost:4001/admin` | Visuele Cube Editor, Live Monaco Split-View, Versiegeschiedenis & Database Introspectie |
| **Management REST API** | `http://localhost:4001/management/v1` | REST endpoints voor modellen, validatie, rollback en introspectie |
| **Cube Developer Playground** | `http://localhost:4000` | Standaard Cube Playground & REST API (`/cubejs-api/v1`) |
| **Cube SQL-API (Superset)** | `localhost:15432` | PostgreSQL wire protocol interface voor Apache Superset |
| **PostgreSQL Metadata & Data** | `localhost:5433` | Metadata (`semantic_models`, `model_revisions`) + brondata (`sample_orders`, `sample_users`, etc.) |

---

## 🏛️ Architectuur & Principes

1. **Minimale impact op Cube Core:**  
   Geen enkele wijziging aan de upstream compiler (`packages/cubejs-schema-compiler`), server-core (`packages/cubejs-server-core`) of Rust Cube Store engine. Alles is ondergebracht in een modulair package (`packages/cubejs-management-api`).
2. **Database-gedreven opslag (PostgreSQL):**  
   Datamodellen worden opgeslagen in `semantic_models` en `model_revisions`. Elke wijziging creëert een nieuwe revisie met audit-logging.
3. **Zero-Downtime Hot Reloading:**  
   - `repositoryFactory`: Laadt alle actieve YAML-definities rechtstreeks uit PostgreSQL.
   - `schemaVersion`: Ziet direct dat de revisie is verhoogd en triggert een atomaire hercompilatie in-memory.
4. **Apache Superset Koppeling:**  
   Superset verbindt via de Cube SQL-API op poort 15432:
   - **Database Type:** PostgreSQL
   - **Host:** `localhost` (of container name `cube`)
   - **Port:** `15432`
   - **Database Name:** `cubedb`
   - **User:** `admin`
   - **Password:** `admin`

---

## 📡 Management REST API Endpoints

Alle endpoints ondersteunen Bearer token authenticatie (`Authorization: Bearer <CUBEJS_API_SECRET>`):

- `GET /management/v1/health` — Status en actuele schema-versie
- `GET /management/v1/models` — Lijst van alle modellen met actieve revisie
- `GET /management/v1/models/:id` — Details van één model inclusief volledige revisiegeschiedenis
- `POST /management/v1/models/validate` — In-memory compilatie en validatie met `@cubejs-backend/schema-compiler`
- `POST /management/v1/models` — Nieuw model opslaan en hot-reloaden
- `PUT /management/v1/models/:id` — Model bijwerken (nieuwe revisie) en hot-reloaden
- `DELETE /management/v1/models/:id` — Model deactiveren
- `POST /management/v1/models/:id/rollback/:revisionNumber` — Rollback naar een eerdere revisie
- `GET /management/v1/datasources/introspect` — Tabellen en kolommen ophalen uit de verbonden brondatabase
- `POST /management/v1/models/import` — Bestaande YAML/JS bestanden importeren naar PostgreSQL
- `POST /management/v1/models/export` — Actieve modellen exporteren naar YAML-bestanden op schijf

---

## 🧪 Tests Uitvoeren

Voer de unit- en integratietests uit:

```bash
yarn --cwd packages/cubejs-management-api test
```
