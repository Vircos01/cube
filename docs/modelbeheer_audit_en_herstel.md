# VAS (Voxel Analytics Service) — Modelbeheer, Audit en Herstel

Dit document beschrijft de architectuur en werking van versiebeheer, concurrency control, compliancelogging en herstelmechanismen binnen VAS.

---

## 1. Concurrency-Model & Optimistic Locking

Om te voorkomen dat gelijktijdige wijzigingen door verschillende gebruikers of API-aanroepen elkaars werk overschrijven ("lost updates"), hanteert VAS een strikt **Optimistic Concurrency Control (OCC)** mechanisme, ondersteund door transactionele row-level locks in PostgreSQL.

### 1.1 Werking
1. **Revisienummer & Versieteller**:
   - Elk semantisch model heeft een `version` integer (monotoon stijgend) in tabel `semantic_models`.
   - Elke inhoudelijke revisie heeft een sequentieel `revision_number` (1, 2, 3...) in `model_revisions`.
2. **Optimistische verificatie bij opslaan (`PUT /models/:id`)**:
   - De client (Web-UI of externe tooling) stuurt bij een update de verwachte actieve revisie mee:
     ```json
     {
       "content": "cubes:\n  ...",
       "expectedRevisionNumber": 4,
       "source": "web_ui"
     }
     ```
   - De backend start een database-transactie en lockt de modelrij met `SELECT * FROM semantic_models WHERE id = $1 FOR UPDATE`.
   - De backend vergelijkt de huidige actieve revisie met `expectedRevisionNumber`.
   - **Match**: De update wordt gevalideerd via `@cubejs-backend/schema-compiler`, de oude revisie wordt gearchiveerd, een nieuwe revisie wordt aangemaakt, `version` wordt verhoogd en de schema-versie voor hot-reload wordt geüpdatet.
   - **Mismatch (Versieconflict)**: De transactie wordt onmiddellijk afgebroken (rollback van de lock), er wordt buiten de transactie een `FAILED` audit record geschreven en de API retourneert **HTTP 409 Conflict** met foutcode `VERSION_CONFLICT`:
     ```json
     {
       "error": "Versieconflict gedetecteerd",
       "code": "VERSION_CONFLICT",
       "modelId": "2506bcda-197c-4591-b3af-652ea01512ef",
       "expectedRevision": 1,
       "currentRevision": 4,
       "currentChangeSummary": "Updated via Web-UI",
       "currentUpdatedBy": "admin",
       "message": "Versieconflict op model ... de verwachte revisie (1) komt niet overeen met de huidige actieve revisie (4)."
     }
     ```
3. **Web-UI Conflictresolutie**:
   - De Web-UI toont een duidelijke waarschuwingsbanner met de naam/acteur van degene die tussentijds heeft gewijzigd.
   - De lokale bewerkingen van de gebruiker blijven in de editor bewaard. De gebruiker kan kiezen om de nieuwste revisie te inspecteren of zijn wijzigingen bewust opnieuw toe te passen.

---

## 2. Onweerlegbare Audit Trail (`audit_logs`)

Elke bewerking op modellen, databronnen of git-synchronisaties wordt geregistreerd in de tabel `audit_logs` conform ISO 27001 en SOC-2 richtlijnen.

### 2.1 Databasestructuur
```sql
CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    action VARCHAR(64) NOT NULL,            -- CREATE_MODEL, UPDATE, ROLLBACK, DELETE, RESTORE, BATCH_IMPORT, GIT_COMMIT, GIT_PULL
    model_id UUID REFERENCES semantic_models(id) ON DELETE SET NULL,
    model_name VARCHAR(128),
    previous_revision_id UUID,
    revision_id UUID,
    actor VARCHAR(128) NOT NULL,            -- Identiteit (API key, gebruikersnaam of service)
    source VARCHAR(64) DEFAULT 'management_api', -- web_ui, cli, git_sync, api
    result VARCHAR(32) DEFAULT 'SUCCESS',   -- SUCCESS of FAILED
    error_message TEXT,                     -- Foutmelding bij FAILED
    details JSONB,                          -- Aanvullende metadata (revisienummers, commit hashes, etc.)
    ip_address VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 2.2 Audit Regels
- **Non-Destructief**: Audit logs kunnen nooit worden overschreven of verwijderd via de Management API.
- **Failures Logging**: Ook mislukte acties (validatiefouten, autorisatieweigereringen en versieconflicten) worden gelogd met `result: 'FAILED'` en de exacte `error_message`.
- **Filtering**: Het endpoint `GET /management/v1/audit-logs` ondersteunt filters op `action`, `result`, `actor`, `source`, `model_name` en paginering (`limit`).

---

## 3. Git Traceability & Synchronisatieregels

VAS biedt volledige twee-weg traceerbaarheid tussen de runtime database (PostgreSQL) en een Git-repository.

### 3.1 Bron van Waarheid
- **Runtime Source-of-Truth**: De PostgreSQL metadata database (`semantic_models`, `model_revisions`) is de actieve runtime bron die realtime schema hot-reloads aanstuurt.
- **VCS Source-of-Truth**: Git fungeert als version control system (VCS), code review platform en audit archief.

### 3.2 Commit Hash Koppeling
- Bij `POST /management/v1/git/commit` worden alle gewijzigde YAML-modellen naar disk geschreven en gecommit.
- De resulterende Git commit hash (SHA-1) wordt direct gestempeld op alle actieve revisies in `model_revisions.git_commit_hash`.
- In de Web-UI toont het revisieoverzicht een 🌿 `git: <hash>` badge naast de revisie.
- In `audit_logs` wordt een record `GIT_COMMIT` gelogd met de commit hash, branch en auteur.

### 3.3 Git Pull & Conflictpreventie
- Bij `POST /management/v1/git/pull` worden modellen uit Git ingelezen en getoetst via `@cubejs-backend/schema-compiler`.
- Alleen bij geldige syntaxis worden nieuwe revisies in PostgreSQL ingevoegd en wordt de schemaversie atomair verhoogd.

---

## 4. Validated Rollback, Soft-Delete en Herstel

### 4.1 Validated Rollback (`POST /models/:id/rollback/:revNumber`)
- Rollback naar een eerdere revisie overschrijft nooit de historie. In plaats daarvan wordt een **nieuwe actieve revisie** aangemaakt met de inhoud van de doelrevisie (bijv. revisie 5 met als samenvatting `"Rollback to revision 2"`).
- **Pre-Validatie**: Voordat de rollback wordt gecommit, compileert de backend de doelinhoud in-memory met de overige actieve modellen. Als een tussenliggende wijziging (bijv. een hernoemde dimensie of verwijderde gerelateerde cube) de compilatie zou breken, wordt de rollback geweigerd met **HTTP 422**.

### 4.2 Soft-Delete (`DELETE /models/:id`)
- Modellen worden niet fysiek verwijderd (`is_active = false`), en actieve revisies krijgen status `archived`.
- Hierdoor blijven alle historische rapporten en auditverwijzingen intact.
- Gedeactiveerde modellen worden standaard uitgesloten van de actieve schema-compilatie en de Web-UI, maar kunnen worden getoond via `?includeDeleted=true`.

### 4.3 Herstel (`POST /models/:id/restore`)
- Een soft-deleted model kan worden hersteld. De meest recente revisie wordt opnieuw gevalideerd tegen het huidige actieve schema.
- Bij succes wordt `is_active = true` gezet, de revisie op `active` gezet, het versienummer verhoogd en Cube ge-hot-reloaded.

---

## 5. Retentiebeleid Revisies (`cleanupArchivedRevisions`)

Voor compliance en database-hygiëne biedt VAS een configureerbaar retentiebeleid via `POST /management/v1/models/cleanup-revisions`:
- **Minimale Historie**: Ongeacht de leeftijd worden altijd minimaal $N$ revisies per model bewaard (standaard 5).
- **Ouderdom**: Alleen gearchiveerde revisies ouder dan de retentieperiode (standaard 90 dagen) die buiten de top $N$ vallen, worden opgeruimd.
- Actieve revisies worden nooit verwijderd.
