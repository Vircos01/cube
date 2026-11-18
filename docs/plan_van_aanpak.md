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

## Fase 3 — Productiewaardige identiteit en toegangscontrole

**Doel:** demo-authenticatie vervangen door centraal, controleerbaar beveiligingsbeleid.

**Werk:**

- Verwijder hardcoded gebruikers en wachtwoorden; verwijder standaard API-secrets of laat de service zonder expliciete secret niet productie starten.
- Integreer met een afgesproken identity provider of valideer ondertekende tokens met issuer, audience, expiratie en sleutelrotatie.
- Definieer rollen en rechten voor modelbeheer, databronbeheer, querygebruik, auditinzage en beheer.
- Maak RLS- en OLS-beleid configuratiegestuurd, met server-side validatie en deny-by-default gedrag.
- Pas tenant-/rijfilters toe op basis van geverifieerde claims en voorkom dat query-input die context kan overschrijven.
- Beperk of verwijder de willekeurige SQL-uitvoerfunctie uit de beheer-API; als de tester blijft bestaan, alleen in development of met expliciete beheerrechten en querylimieten.
- Redigeer credentials, tokens en gevoelige querywaarden in logs en foutmeldingen.

**Acceptatiecriteria:**

- Ongeautoriseerde toegang tot beheer- en query-endpoints wordt getest en geweigerd.
- RLS blijft gelden bij REST, SQL en andere ondersteunde querypaden.
- OLS blokkeert zowel directe als indirecte toegang tot verboden members.
- Geen endpoint retourneert wachtwoorden, tokens of andere secrets.
- Er is een gedocumenteerd proces voor sleutelrotatie, accountintrekking en beleidswijziging.

## Fase 4 — Modelbeheer, audit en herstel

**Doel:** wijzigingen traceerbaar en herstelbaar maken voor beheerders.

**Werk:**

- Maak actor, tijdstip, bron, model, revision en resultaat verplicht in auditrecords voor mutaties.
- Definieer versieconflictgedrag voor gelijktijdige edits; voorkom stil overschrijven met optimistic concurrency/version checks.
- Maak rollback een gevalideerde, auditbare wijziging met dezelfde atomische publicatieregels als normale updates.
- Leg de relatie tussen Git-revisie en metadatarevision vast; specificeer welke opslag leidend is en hoe synchronisatieconflicten worden opgelost.
- Definieer soft-delete, herstel, bewaartermijnen en export-/backup-procedures.

**Acceptatiecriteria:**

- Iedere wijziging is terug te leiden naar een actor en vorige/nieuwe revision.
- Twee gelijktijdige updates verliezen geen wijziging zonder expliciet conflict.
- Rollback herstelt een eerder geldige versie en publiceert deze als nieuwe revision.
- Een backup kan in een schone omgeving worden hersteld volgens een geteste runbook-procedure.

## Fase 5 — Betrouwbaarheid, observability en performance

**Doel:** fouten detecteerbaar maken en operationeel herstel ondersteunen.

**Werk:**

- Voeg gestructureerde logs, request/correlation-ID’s, metrics en health checks toe voor management-API, metadata-database, databronnen en compiler.
- Maak compileerfouten en schema-version-status zichtbaar zonder gevoelige details te lekken.
- Stel timeouts, connection pooling, querylimieten en importlimieten in.
- Definieer gedrag bij metadata-database-uitval: geen lege schemafallback die modellen stil verbergt; geef een duidelijke niet-beschikbare toestand.
- Documenteer deployment, migrations, secrets, TLS, upgrades, backup en incidentherstel.
- Meet compileertijd en querylatentie met representatieve modellen en datasets.

**Acceptatiecriteria:**

- Een operator kan onderscheid maken tussen database-uitval, ongeldige modellen, compilerfouten en queryfouten.
- Een storing leidt niet tot onbedoelde publicatie van een leeg of gedeeltelijk schema.
- SLO’s voor beschikbaarheid, compileertijd en querylatentie zijn afgesproken en meetbaar.
- Deployment en herstel zijn reproduceerbaar vanuit de documentatie.

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

