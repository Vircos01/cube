# VAS (Voxel Analytics Service) — Deployment & Operatie Handleiding

Dit document beschrijft de operationele standaarden voor uitrol, configuratie, migratie, beveiliging en incidentherstel van **VAS (Voxel Analytics Service)** in productieomgevingen.

---

## 1. Productie Architectuur & Container Topologie

In productie draait VAS als een container-gebaseerde multi-service stack.

```
                  ┌──────────────────────────────────────────────┐
                  │   Reverse Proxy / Ingress / Load Balancer    │
                  │   (TLS Termination, Port 443 / 80)           │
                  └───────┬──────────────────────────────┬───────┘
                          │                              │
                          │ :4000 (Cube REST/GraphQL)     │ :4001 (VAS Management API & UI)
                          ▼                              ▼
                 ┌───────────────────────────────────────────────┐
                 │       VAS Container (cube-core-server)        │
                 │   - Cube Semantic Engine (Rust + Node.js)     │
                 │   - VAS Management API (Express)              │
                 │   - SQL API (Postgres wire on port 15432)     │
                 └───────┬───────────────────────────────┬───────┘
                         │                               │
       SQL Queries / ETL │                               │ Metadata & Auditing
                         ▼                               ▼
                 ┌───────────────┐               ┌───────────────┐
                 │  Data Source  │               │   PostgreSQL  │
                 │  Postgres/DWH │               │ Metadata Repo │
                 └───────────────┘               └───────────────┘
```

### Poorten en Netwerkisolatie
- **Port 4000**: Cube REST API (`/cubejs-api/v1/load`, `/meta`) voor frontend dashboards en applicaties.
- **Port 4001**: VAS Management API (`/management/v1/*`) en Web-UI (`/admin`). **Alleen toegankelijk voor geautoriseerde data engineers via VPN of IP-whitelisting.**
- **Port 15432**: Cube SQL API (Postgres Wire Protocol) voor BI-tools (PowerBI, Tableau, Superset, Excel).
- **Port 5432 / 5433**: PostgreSQL Metadata Database. **Nooit publiek exposen; uitsluitend intern containernetwerk.**

---

## 2. Omgevingsvariabelen & Secrets Management

In productieomgevingen (`NODE_ENV=production`) weigert VAS op te starten als er onveilige standaardwaarden of ontbrekende geheimen worden gedetecteerd.

### 2.1 Verplichte Productievariabelen

| Variabele | Voorbeeld | Beschrijving |
|---|---|---|
| `NODE_ENV` | `production` | Activeert strikte validatie, JSON logging en blokkeert default dev tokens |
| `VAS_MANAGEMENT_SECRET` | *32+ random hex/base64* | Geheim voor het genereren en valideren van VAS Management JWTs |
| `CUBEJS_API_SECRET` | *32+ random hex/base64* | Geheim voor Cube Core query authenticatie |
| `METADATA_DB_HOST` | `postgres-meta.internal` | Hostnaam van de metadata database |
| `METADATA_DB_PORT` | `5432` | Poort van de metadata database |
| `METADATA_DB_NAME` | `cube_metadata` | Database naam voor modellen, revisies en rollen |
| `METADATA_DB_USER` | `cube_vas_svc` | Service account met strikte DDL/DML rechten |
| `METADATA_DB_PASSWORD`| *Sterk gegenereerd geheim* | Wachtwoord voor de metadata database |
| `METADATA_DB_SSL` | `true` | Schakelt SSL/TLS in voor databaseverbindingen |
| `CUBEJS_DEV_MODE` | `false` | **Verplicht false** in productie; schakelt authenticatiecontroles in |

### 2.2 Productie Veiligheidscontrole
Bij de start van de Management API voert `src/api/auth.ts` de volgende check uit:
```typescript
if (isProduction && (!secret || secret === 'vas_production_secret_token_change_me_immediately')) {
  throw new Error('[FATAL SECURITY] In production (NODE_ENV=production), VAS_MANAGEMENT_SECRET must be explicitly set to a strong secret!');
}
```

---

## 3. Database Migraties & Schema Versioning

### 3.1 Automatische Idempotente Migratie
Bij het opstarten controleert VAS de PostgreSQL metadata database en voert ontbrekende DDL-migraties automatisch en idempotent uit (`src/db/migrator.ts`):
- `data_sources`: Dynamische connecties naar relationele bronnen.
- `semantic_models`: Modellen in YAML-formaat inclusief optimistic locking `version`.
- `model_revisions`: Volledige onveranderlijke revisiegeschiedenis met `git_commit_hash`.
- `audit_logs`: Verplichte enterprise audit trail met actor, bron en actieresultaat.
- `user_accounts`, `security_roles`, `access_policies`: Gecentraliseerde RLS/OLS rechten.

### 3.2 Handmatige Migratie Verificatie
Controleer de migratiestatus via het container-entrypoint:
```bash
docker exec -it cube-core-server node -e '
  const { pool, initializeDatabase } = require("./packages/cubejs-management-api/dist/index.js");
  initializeDatabase(pool).then(() => {
    console.log("Migraties succesvol!");
    process.exit(0);
  }).catch(err => {
    console.error("Migratiefout:", err);
    process.exit(1);
  });
'
```

---

## 4. TLS/SSL Termination & Reverse Proxy

Exposeer VAS containers nooit rechtstreeks aan het publieke internet. Plaats altijd een reverse proxy met TLS 1.3 terminatie.

### 4.1 Nginx Productie Configuratie (Voorbeeld)
```nginx
server {
    listen 443 ssl http2;
    server_name analytics.bedrijf.nl;

    ssl_certificate /etc/ssl/certs/vas_bundle.crt;
    ssl_certificate_key /etc/ssl/private/vas.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Security Headers
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Cube Client Query API
    location /cubejs-api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # VAS Management API & Web-UI (Beperkt tot bedrijfs-VPN)
    location /management/ {
        allow 10.0.0.0/8;
        allow 192.168.1.0/24;
        deny all;

        proxy_pass http://127.0.0.1:4001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /admin {
        allow 10.0.0.0/8;
        allow 192.168.1.0/24;
        deny all;

        proxy_pass http://127.0.0.1:4001;
        proxy_set_header Host $host;
    }
}
```

---

## 5. Backup & Disaster Recovery

Zie voor de complete geteste stap-voor-stap procedures het document [docs/backup_en_herstel.md](file:///Users/remcovisser/Dev/Cube/docs/backup_en_herstel.md).

### 5.1 Dagelijkse Geautomatiseerde Snapshot
```bash
docker exec cube-metadata-postgres pg_dump \
  -U cube_user \
  -d cube_metadata \
  -F c \
  -b \
  -v \
  -f /tmp/vas_backup_$(date +%Y%m%d_%H%M%S).dump
```

### 5.2 Herstelprocedure (RTO < 5 minuten)
```bash
docker exec -i cube-metadata-postgres pg_restore \
  -U cube_user \
  -d cube_metadata \
  --clean \
  --if-exists \
  -v /tmp/vas_backup_recente.dump
```

---

## 6. Incident Response & Troubleshooting Playbook

### Incident 1: Metadata Database Uitval
- **Symptoom:** `/management/v1/health` geeft HTTP 503; logs tonen `[VAS FATAL] Failed to fetch semantic models`.
- **Gedrag van VAS:** VAS schakelt **niet** over op een leeg schema. Het bestaande in-memory gecompileerde schema blijft actief zodat BI-queries op bestaande modellen blijven werken.
- **Herstelactie:**
  1. Controleer de PostgreSQL container/cluster status: `docker ps` of `systemctl status postgresql`.
  2. Controleer database resources (disk space, max_connections):
     `SELECT count(*) FROM pg_stat_activity;`
  3. Zodra de database herstelt, pakt VAS automatisch de verbinding weer op zonder containerherstart.

### Incident 2: Ongeldige Modeldefinitie & Compileerfout
- **Symptoom:** Operator probeert een syntax-fout of ontbrekende join te saven.
- **Gedrag van VAS:** De compiler pre-validatie onderschept de fout (`HTTP 400 Bad Request` met exact schema-foutbericht). De database wordt niet aangeraakt, de revisie wordt niet gepubliceerd, en de fout wordt als `FAILED` gelogd in de audit trail.
- **Herstelactie:**
  1. De data engineer corrigeert de YAML-fout direct in de Web-UI editor of API payload.
  2. Indien een foutief model reeds via externe import is binnengekomen: gebruik `POST /management/v1/models/:id/rollback/:revNumber` om direct terug te keren naar de vorige werkende revisie.

### Incident 3: Versieconflict (Lost Update)
- **Symptoom:** `PUT /management/v1/models/:id` retourneert HTTP 409 met code `VERSION_CONFLICT`.
- **Oorzaak:** Een andere engineer heeft intussen een nieuwere revisie gepubliceerd.
- **Herstelactie:**
  1. De Web-UI toont de waarschuwing: "Model is gewijzigd door een andere gebruiker".
  2. Klik op "Laad Nieuwste Revisie" om de nieuwste inhoud in te laden en de wijzigingen samen te voegen.

### Incident 4: Beheerder Wachtwoord Vergeten / Lockout
- **Symptoom:** Beheerder kan niet inloggen op de Web-UI.
- **Herstelactie:**
  Reset het beheerderswachtwoord direct via Node.js scrypt in de container:
  ```bash
  docker exec -it cube-core-server node -e '
    const { pool } = require("./packages/cubejs-management-api/dist/index.js");
    const { hashPassword } = require("./packages/cubejs-management-api/dist/security/password.js");
    async function reset() {
      const hash = await hashPassword("NieuwVeiligWachtwoord123!");
      await pool.query("UPDATE user_accounts SET password_hash = $1 WHERE username = $2", [hash, "admin"]);
      console.log("Admin wachtwoord succesvol hersteld!");
      process.exit(0);
    }
    reset();
  '
  ```
