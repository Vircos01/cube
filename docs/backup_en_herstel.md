# VAS (Voxel Analytics Service) — Backup & Herstel Runbook

Dit runbook bevat operationele instructies voor het maken van consistente back-ups en het uitvoeren van een volledig herstel (disaster recovery) van de VAS metadata database.

---

## 1. Doel en Bereik

De metadata database van VAS (PostgreSQL) bevat alle bedrijfskritische configuratie van de semantische laag:
- **`semantic_models` & `model_revisions`**: De volledige semantische modellen, dimensies, maatstaven en revisiehistorie.
- **`user_accounts`, `security_roles` & `access_policies`**: Centraal identiteitsbeheer, scrypt-wachtwoordhashes, RLS- en OLS-beleid.
- **`audit_logs`**: De volledige compliancelog en audithistorie van alle bewerkingen.
- **`data_sources`**: Verbindingsparameters naar externe databases en DWH-bronnen.
- **`schema_version_tracker`**: Versiebeheer voor atomaire hot-reloads.

---

## 2. Backup Procedure (`pg_dump`)

### 2.1 Handmatige Backup
Voer de backup uit met het `custom` (`-F c`) archiefformaat van PostgreSQL. Dit formaat ondersteunt compressie, integriteitschecks en selectief herstel.

#### Binnen de Docker container:
```bash
docker exec cube-metadata-postgres pg_dump \
  -U postgres \
  -d cubedb \
  -F c \
  -b \
  -v \
  -f /tmp/cubedb_backup_$(date +%Y%m%d_%H%M%S).dump
```

#### Kopieer de dump naar de host:
```bash
docker cp cube-metadata-postgres:/tmp/cubedb_backup_$(date +%Y%m%d_%H%M%S).dump ./backups/
```

#### Rechtstreeks vanaf de host (poort 5433):
```bash
PGPASSWORD=postgres pg_dump \
  -h localhost \
  -p 5433 \
  -U postgres \
  -d cubedb \
  -F c \
  -b \
  -f ./backups/cubedb_backup_$(date +%Y%m%d_%H%M%S).dump
```

### 2.2 Geautomatiseerde Dagelijkse Backup (Cronjob)
Plaats onderstaand script in `/etc/cron.daily/vas_metadata_backup.sh`:

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/var/backups/vas"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/cubedb_${TIMESTAMP}.dump"

mkdir -p "${BACKUP_DIR}"

# Maak backup via Docker container
docker exec cube-metadata-postgres pg_dump \
  -U postgres \
  -d cubedb \
  -F c \
  -b \
  -f "/tmp/cubedb_${TIMESTAMP}.dump"

# Verplaats naar veilige hostopslag
docker cp "cube-metadata-postgres:/tmp/cubedb_${TIMESTAMP}.dump" "${BACKUP_FILE}"
docker exec cube-metadata-postgres rm -f "/tmp/cubedb_${TIMESTAMP}.dump"

# Bewaar back-ups maximaal 30 dagen
find "${BACKUP_DIR}" -name "cubedb_*.dump" -mtime +30 -delete

echo "VAS backup succesvol voltooid: ${BACKUP_FILE}"
```

---

## 3. Herstelprocedure (`pg_restore`)

### 3.1 Scenario A: Herstel in een Nieuwe / Schone Omgeving
1. **Start de metadata container**:
   ```bash
   docker compose up -d postgres
   ```
2. **Kopieer het backupbestand naar de container**:
   ```bash
   docker cp ./backups/cubedb_backup.dump cube-metadata-postgres:/tmp/cubedb_backup.dump
   ```
3. **Voer herstel uit**:
   ```bash
   docker exec cube-metadata-postgres pg_restore \
     -U postgres \
     -d cubedb \
     --clean \
     --if-exists \
     --verbose \
     /tmp/cubedb_backup.dump
   ```
4. **Verwijder het tijdelijke dumpbestand**:
   ```bash
   docker exec cube-metadata-postgres rm -f /tmp/cubedb_backup.dump
   ```

### 3.2 Scenario B: Disaster Recovery (Bestaande database corrupt of herstel naar specifiek punt)
Als de database `cubedb` overschreven moet worden:
```bash
# 1. Stop de Cube runtime container om actieve verbindingen te verbreken
docker stop cube-core-server

# 2. Drop en hermaak de database
docker exec cube-metadata-postgres dropdb -U postgres --if-exists cubedb
docker exec cube-metadata-postgres createdb -U postgres cubedb

# 3. Herstel data en schema
docker exec cube-metadata-postgres pg_restore \
  -U postgres \
  -d cubedb \
  -v \
  /tmp/cubedb_backup.dump

# 4. Start Cube runtime container weer op
docker start cube-core-server
```

---

## 4. Validatie na Herstel

Controleer na het herstellen altijd de integriteit en werking:

### 4.1 Database Telling Verifiëren
```bash
docker exec cube-metadata-postgres psql -U postgres -d cubedb -c "
  SELECT 'semantic_models' AS table_name, count(*) FROM semantic_models
  UNION ALL
  SELECT 'model_revisions', count(*) FROM model_revisions
  UNION ALL
  SELECT 'user_accounts', count(*) FROM user_accounts
  UNION ALL
  SELECT 'access_policies', count(*) FROM access_policies
  UNION ALL
  SELECT 'audit_logs', count(*) FROM audit_logs;
"
```

### 4.2 Management API Health Check
```bash
curl -s http://localhost:4001/management/v1/health | jq .
```
Verwachte output:
```json
{
  "status": "ok",
  "schemaVersion": "v..."
}
```

### 4.3 Cube Query Smoke Test
Voer een testquery uit via de SQL-API (poort 15432):
```bash
PGPASSWORD=admin psql -h localhost -p 15432 -U admin -d cubedb -c "SELECT count, total_amount FROM Orders LIMIT 5;"
```
