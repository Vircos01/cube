# VAS — Plan van Aanpak richting productiegeschikte semantic layer

## Doel

VAS ontwikkelen van een werkend prototype naar een betrouwbare, beheerbare semantic layer voor productiegebruik en BI-consumptie. De scope is een gefaseerde SSAS-alternatief voor afgesproken use-cases; volledige feature-pariteit met SSAS is geen doel van dit plan.

Een fase is pas afgerond wanneer de acceptatiecriteria zijn gehaald, inclusief geautomatiseerde tests en bijgewerkte documentatie. De huidige claims “Voltooid” en “Geverifieerd” in `architectuur_en_plan.md` worden pas gebruikt nadat die criteria aantoonbaar zijn gehaald.

## Uitgangspunten

- Behoud de Cube query- en compilatie-engine; bouw VAS-functionaliteit in management- en metadata-lagen.
- Behandel modelwijzigingen als versiebeheerbare, gevalideerde transacties.
- Gebruik geen ingebouwde demo-accounts, standaardgeheimen of voorbeeldbeleid als productiebeveiliging.
- Houd metadata-opslag en analytische brondata logisch gescheiden.
- Maak iedere fase klein genoeg om afzonderlijk te implementeren, reviewen en terug te draaien.

## Fase 0 — Scope en huidige staat vastleggen

**Doel:** vaststellen welke productie-use-cases VAS eerst moet ondersteunen en de documentatie laten overeenkomen met de code.

**Werk:**

- Kies de eerste ondersteunde database-driver(s), BI-clients en queryprotocollen.
- Leg vast wie modellen mag beheren, wie data mag opvragen en welke tenant-/regio-isolatie nodig is.
- Maak onderscheid tussen metadata-database, standaard analytics-database en externe databronnen.
- Controleer architectuurdiagram, beveiligingsclaims en fasestatussen in `architectuur_en_plan.md` tegen de implementatie.
- Noteer expliciet wat buiten de eerste release valt, zoals SSAS-specifieke multidimensionale functies die niet door Cube worden geleverd.

**Acceptatiecriteria:**

- Een goedgekeurde lijst met use-cases, databronnen, BI-clients en beveiligingsregels bestaat.
- Elk onderdeel uit de architectuur heeft een status: aanwezig, gedeeltelijk, ontbreekt of buiten scope.
- Er zijn geen onbewezen claims van productievalidatie in de documentatie.

## Fase 1 — Databronnen als eerste-klas configuratie

**Doel:** zorgen dat een geïnspecteerde bron ook de bron is waaruit Cube-query’s lezen.

**Werk:**

- Ontwerp metadata voor databronnen, met stabiele ID, driver/type, host, database, schema, SSL-instellingen en geheimreferentie.
- Bewaar wachtwoorden niet als gewone metadata of in modeldefinities; gebruik secrets uit deployment/configuratie en scherm waarden af in API-responses en logs.
- Bouw beheer-endpoints voor aanmaken, bijwerken, testen, activeren en verwijderen van databronnen, met expliciete autorisatie.
- Koppel een gegenereerd model aan een `dataSource`-ID en laat `driverFactory` uitsluitend een bestaande, toegestane configuratie oplossen.
- Gebruik dezelfde bronconfiguratie voor testverbinding, introspectie en modelquery’s.
- Valideer schema-, tabel- en kolomnamen aan de serverkant; vertrouw geen door de browser aangeleverde introspectieresultaten.

**Acceptatiecriteria:**

- Een model uit een externe PostgreSQL-bron kan via REST en SQL worden bevraagd en leest aantoonbaar uit die externe bron.
- Een bronwissel verandert niet stilzwijgend de betekenis of resultaten van bestaande modellen.
- Geheimen verschijnen niet in responses, client-side logs of applicatielogs.
- Een gebruiker zonder bronbeheerrecht kan geen bronconfiguratie aanmaken of uitlezen.

## Fase 2 — Veilige en atomische modelimport

**Doel:** batchimport als één consistente modelwijziging publiceren.

**Werk:**

- Laat de server bron, schema, tabellen en relaties ophalen of verifieer ze tegen de server-side introspectie; accepteer geen willekeurige modeldefinities als vertrouwde input.
- Detecteer naamconflicten tussen schema’s, tabellen, bestaande handgemaakte modellen en gegenereerde modellen. Bied expliciete keuze: nieuw model, gecontroleerde update of afbreken.
- Genereer joins alleen naar cubes die al bestaan of in dezelfde batch worden aangemaakt; controleer relatie, join-kolommen en doelmodel vóór opslag.
- Valideer alle gegenereerde definities samen met de bestaande actieve modellen via de compiler.
- Schrijf alle revisies, auditrecords en één schema-version-update in één database-transactie. Bij een fout wordt de volledige batch teruggedraaid.
- Publiceer de nieuwe modelsnapshot pas nadat de transactie volledig is gecommit.
- Geef per tabel duidelijke validatie- en conflictresultaten terug zonder gedeeltelijke commit.

**Acceptatiecriteria:**

- Een fout in één tabel laat geen gedeeltelijk geïmporteerde batch achter.
- Een gegenereerde join verwijst nooit naar een ontbrekend cube-model.
- Een succesvolle batch produceert één consistente actieve modelsnapshot en één versie-update.
- Een mislukte compiler-validatie wijzigt geen actieve modellen.
- Een opnieuw uitgevoerde import heeft een voorspelbaar resultaat en maakt geen onbedoelde duplicaten of revisions.

## Fase 3 — Productiewaardige identiteit en toegangscontrole [VOLTOOID]

**Doel:** demo-authenticatie vervangen door centraal, controleerbaar beveiligingsbeleid.

**Status:** Volledig geïmplementeerd en geverifieerd. Zie ook [`docs/beveiliging_en_toegangscontrole.md`](file:///Users/remcovisser/Dev/Cube/docs/beveiliging_en_toegangscontrole.md).

**Opgeleverd:**
- Centrale PostgreSQL metadata tabellen: `user_accounts`, `security_roles`, `access_policies`.
- Cryptografische wachtwoordhashing met Node.js `scrypt` en timing-veilige verificatie; wachtwoordhashes worden overal geredigeerd.
- Dynamische `checkSqlAuth` in `runtime/cube.js` zonder hardcoded credentials.
- Dynamische `queryRewrite` in `runtime/cube.js` met server-side handhaving van RLS (o.b.v. dynamische claims) en OLS (blokkeren van maatstaven en dimensies).
- Strikte deny-by-default afhandeling: query weigering wanneer vereiste claims ontbreken.
- Productiecheck: blokkeert startup indien `NODE_ENV=production` en het bekende standaard API-secret (`mysecretkey123`) actief is.
- Beveiligd SQL test-endpoint met automatische `LIMIT 100` en credential redactie.
- Volledige CRUD endpoints in Management API en interactieve Web-UI voor gebruikers-, rollen- en beleidsbeheer.
- 35/35 geautomatiseerde unit- en integratietests geslaagd.

## Fase 4 — Modelbeheer, audit en herstel [VOLTOOID]

**Doel:** wijzigingen traceerbaar en herstelbaar maken voor beheerders.

**Status:** Volledig geïmplementeerd en geverifieerd. Zie ook [`docs/modelbeheer_audit_en_herstel.md`](file:///Users/remcovisser/Dev/Cube/docs/modelbeheer_audit_en_herstel.md) en [`docs/backup_en_herstel.md`](file:///Users/remcovisser/Dev/Cube/docs/backup_en_herstel.md).

**Opgeleverd:**
- **Optimistic Concurrency Control (OCC)**: `semantic_models.version` en `expectedRevisionNumber` / `expectedVersion` checks bij `PUT /models/:id`. Voorkomt lost updates via transactionele `SELECT ... FOR UPDATE` row locks; bij conflict wordt onmiddellijk afgebroken met **HTTP 409 Conflict** (`code: 'VERSION_CONFLICT'`).
- **Verplichte Compliance Audit Trail**: `audit_logs` uitgebreid met `model_id`, `model_name`, `previous_revision_id`, `revision_id`, `actor`, `source`, `result` (`SUCCESS`/`FAILED`) en `error_message`. Foutieve pogingen en conflicten worden onafhankelijk gelogd.
- **Validated Rollback**: `POST /models/:id/rollback/:revNumber` valideert de historische YAML-syntaxis tegen het huidige actieve schema vóór commit. Publiceert de rollback non-destructief als een nieuwe revisie.
- **Soft-Delete & Herstel**: `DELETE /models/:id` markeert modellen als inactief (`is_active = false`) en archiveert actieve revisies. `POST /models/:id/restore` toetst en herstelt gedeactiveerde modellen.
- **Git Traceability**: `git_commit_hash` gestempeld op actieve `model_revisions`; bi-directionele traceerbaarheid met 🌿 git-badge in de UI en `GIT_COMMIT`/`GIT_PULL` compliancelogs.
- **Revisieretentiebeleid**: `POST /models/cleanup-revisions` schoont gearchiveerde revisies ouder dan de retentiedagen op met behoud van minimaal $N$ revisies per model.
- **Interactieve Web-UI**:
  - Versieconflictwaarschuwing met behoud van editor-inhoud en knop "Laad Nieuwste Revisie".
  - Specifiek tabblad "📜 Audit Trail & Logs" met dynamische filters (Actie, Resultaat) en responsive overzichtstabel.
  - Sidebar ondersteuning voor "Prullenbak" (gedeactiveerde modellen) en "Herstel Model".
  - Retentie-opschoonknop direct vanuit het audittabblad.
- **Geteste Backup & Restore Runbook**: Consistente back-ups via `pg_dump` en bewezen disaster recovery via `pg_restore` gedocumenteerd en geverifieerd in de containeromgeving.
- **Automatisering**: 42/42 geautomatiseerde unit- en integratietests geslaagd.

## Fase 5 — Betrouwbaarheid, observability en performance [VOLTOOID]

**Doel:** fouten detecteerbaar maken en operationeel herstel ondersteunen.

**Opgeleverd:**
- **Observability Engine & Endpoints**:
  - `GET /management/v1/health`: Diepe diagnose van metadata PostgreSQL verbinding, query latency (ms), connection pool statistieken (`totalCount`, `idleCount`, `waitingCount`) en aantal actieve modellen in runtime.
  - `GET /management/v1/health/live`: Liveness probe voor container health checks.
  - `GET /management/v1/health/ready`: Readiness probe voor load balancers en Kubernetes traffic routing.
  - `GET /management/v1/metrics`: In-memory rolling metrics en officiële Prometheus exporter (`Accept: text/plain` of `?format=prometheus`) met `vas_uptime_seconds`, `vas_memory_heap_used_bytes`, `vas_compiler_validations_total` en `vas_http_requests_total` inclusief p50, p95 en p99 latentieverdelingen.
- **Gestructureerde Logging & Redaction**:
  - `Logger` met `AsyncLocalStorage` voor automatische correlatie van `X-Request-Id` / `X-Correlation-Id`.
  - Single-line JSON logs in productie (`NODE_ENV=production`) en ANSI kleurformaat in ontwikkeling.
  - Recursieve gegevensmaskering (`redactSensitiveData`) van wachtwoorden, API tokens, database connection string credentials (`postgres://user:[REDACTED]@...`) en Bearer headers in logs en API responses.
- **Timeouts, Resource Limieten & Bescherming**:
  - PostgreSQL connection pool met `max: 20`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 5000` en `statement_timeout: 30000`.
  - Batch import beveiligd met maximale limiet van 50 tabellen per batch met duidelijke `HTTP 400 - Importlimiet overschreden`.
- **Faalgedrag Metadata Database (Anti-Silent Wipe)**:
  - `runtime/cube.js` werpt een kritieke exception op bij database-uitval in plaats van een lege array (`[]`) te retourneren. Hierdoor blijft het bestaande geldige gecompileerde schema in-memory beschikbaar en worden actieve BI-clients beschermd tegen een plotseling leeg schema.
- **Web-UI "📊 Metrics & Health" Dashboard**:
  - Real-time visualisatie van databaseverbinding, roundtrip-latentie, actieve modellen en actuele `schemaVersion`.
  - Systeemgeheugen (Heap used / RSS) en compiler validatietellers.
  - Endpoints latentietabel met request counters en p50/p95/p99 responsietijden.
  - Directe link naar `/management/v1/metrics` voor scraping.
- **Gedocumenteerde Standen & SLO's**:
  - [docs/observability_en_performance.md](file:///Users/remcovisser/Dev/Cube/docs/observability_en_performance.md): Volledig overzicht van health probes, Prometheus exporter, empirische benchmarks (DB latency ~1.94ms, query latency ~3.44ms, memory ~65MB) en vastgestelde 99.9% SLO's.
  - [docs/deployment_en_operatie.md](file:///Users/remcovisser/Dev/Cube/docs/deployment_en_operatie.md): Productiearchitectuur, containertopologie, secrets management, reverse proxy TLS configuratie en incident playbooks.
- **Automatisering**: 50/50 geautomatiseerde unit- en integratietests geslaagd.

## Fase 6 — BI-compatibiliteit en releasecriteria

**Doel:** aantonen dat de afgesproken BI-clients correct en veilig werken.

**Werk:**

- Test de afgesproken clients tegen REST- en/of SQL-interface, inclusief metadata discovery, datatype-mapping, tijdzones, nulls, pagination en foutafhandeling.
- Controleer queryresultaten en beveiligingsbeleid met representatieve datasets en rollen.
- Voeg migratie- en upgradecompatibiliteit toe voor metadata-schema en modeldefinities.
- Maak een releasechecklist met ondersteunde drivers, protocollen, bekende beperkingen en compatibility matrix.

**Acceptatiecriteria:**

- Elke ondersteunde BI-client doorloopt een geautomatiseerde smoke-/compatibility-suite.
- Resultaten en beveiligingsregels zijn voor dezelfde query consistent over de ondersteunde interfaces.
- Een upgrade behoudt modellen, revisies, toegangsbeleid en databronconfiguratie, of levert een gevalideerd migratiepad.
- Release notes noemen expliciet incompatibele wijzigingen en bekende beperkingen.

## Aanbevolen volgorde en besluitmomenten

1. Rond Fase 0 af en kies de eerste productie-use-case.
2. Implementeer Fase 1; externe bronnen zijn pas bruikbaar wanneer query-uitvoering dezelfde bron gebruikt als introspectie.
3. Implementeer Fase 2 vóór brede inzet van de importer.
4. Implementeer Fase 3 vóór gebruik met echte gebruikers of gevoelige data.
5. Voer Fase 4 en 5 parallel aan beperkte pilotvoorbereiding uit.
6. Start een pilot met één bron en één BI-client; ga pas daarna naar Fase 6 en bredere uitrol.

## Buiten scope totdat expliciet besloten

- Volledige functionele pariteit met SSAS, inclusief alle multidimensionale modellen en beheerconcepten.
- Ondersteuning voor iedere database-driver en BI-client.
- Multi-tenant hosting zonder expliciet tenant-isolatieontwerp en dreigingsmodel.
- Productiegebruik van demo-identiteiten, testdata of ontwikkelgeheimen.

## Web-UI verbeterpunten

De Web-UI moet de echte backendstatus tonen en gebruikers helpen risicovolle of onbedoelde wijzigingen te voorkomen. UI-werk volgt de backendcontracten uit Fase 1–3; de interface mag een backendgarantie zoals atomiciteit niet suggereren voordat die daadwerkelijk bestaat.

### Prioriteit 1 — Duidelijke databronstatus en veilige import

- Vervang de losse “Default / Custom” formulierstatus op termijn door een lijst met opgeslagen databronnen, herkenbare namen en status. Toon duidelijk welke databron en welk schema op dat moment worden geïnspecteerd en waaruit gegenereerde modellen zullen query’en.
- Maak de verbindingsteststatus ongeldig zodra host, poort, database, gebruiker, schema, SSL of geheim wijzigt. Toon bij introspectie en import de status van de actuele configuratie.
- Toon na een fout een blijvende foutmelding in de pagina met herstelactie; laat een toast alleen als extra korte bevestiging dienen. Wis of markeer eerder geladen tabellen wanneer een nieuwe introspectie mislukt, zodat oude resultaten niet voor de nieuwe bron worden aangezien.
- Selecteer na introspectie niet standaard alle tabellen. Start zonder selectie of bied een expliciete “selecteer alles” stap met een zichtbare impactwaarschuwing.
- Voeg vóór import een reviewstap toe met databron, schema, aantallen, geselecteerde tabellen, bestaande modelconflicten, relaties die niet kunnen worden gelegd en de gekozen auto-measure/auto-join opties.
- Maak updates aan bestaande modellen expliciet: toon welke modellen worden overschreven, laat diff/preview zien en vraag bevestiging. De huidige naamvergelijking alleen is niet genoeg om dezelfde bron en tabel vast te stellen.
- Toon importvoortgang en een blijvend eindrapport per tabel: aangemaakt, bijgewerkt, overgeslagen of mislukt. Bied links naar de betrokken modellen en validatiefouten.

### Prioriteit 2 — Betere schema-exploratie

- Toon selectie-aantallen los van het totaal en maak duidelijk of “selecteer alles” slaat op alle tabellen of alleen de huidige zoekresultaten.
- Voeg schemafiltering, sortering, kolomtypefiltering en paginering of virtualisatie toe voor grote databases.
- Toon relaties als navigabele modelnamen met bron- en doelschema, en markeer ontbrekende of niet-geselecteerde doeltabellen vóór import.
- Laat gebruikers gegenereerde cube-namen en measure/dimension-keuzes vooraf aanpassen; markeer naamconflicten en kolommen die niet veilig naar een Cube-member vertaald kunnen worden.
- Geef bij lege resultaten onderscheid tussen nog niet geladen, lege schema, onvoldoende rechten en mislukte verbinding.

### Prioriteit 3 — Consistente beheerervaring

- Breng de taal terug naar één gekozen locale; voeg een locale-instelling toe als Nederlands en Engels beide nodig zijn. Zet ook het document `lang`-attribuut overeenkomstig.
- Voeg toegankelijke veldlabels, toetsenbordbediening, focusweergave en statusmeldingen voor screenreaders toe; controleer de layout op smalle schermen.
- Toon onvervalste operationele status: API-verbinding, schema-versie, laatste succesvolle compile en validatiestatus. Vermijd succesmeldingen voordat de backend bevestigt dat de wijziging is opgeslagen én geladen.
- Bewaar niet-gevoelige formulierkeuzes waar dat helpt, maar sla databronwachtwoorden of API-secrets niet onversleuteld op in browseropslag.
- Voeg contextuele help toe voor termen als databron, schema, measure, join, RLS en OLS, plus een korte onboarding voor de eerste modelimport.

**Acceptatiecriteria voor de Web-UI:**

- De actieve databron en het schema zijn op elke stap van introspectie tot modelimport zichtbaar.
- Een mislukte of verouderde verbindingstest kan niet als actuele successtatus worden getoond.
- De gebruiker ziet vóór commit welke modellen worden aangemaakt of bijgewerkt en kan een destructieve update annuleren.
- Fouten en importresultaten blijven beschikbaar totdat de gebruiker ze sluit of een nieuwe actie start.
- Grote schema’s blijven bruikbaar en tabelselectie is eenduidig bij actieve filters.
- Geen scherm belooft atomische import, hot reload of beveiliging die de server niet aantoonbaar garandeert.

