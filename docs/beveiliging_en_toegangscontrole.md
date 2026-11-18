# VAS (Voxel Analytics Service) — Beveiliging en Toegangscontrole (RBAC / RLS / OLS)

Dit document beschrijft de architectuur, implementatie en operationele procedures voor identiteitsbeheer, authenticatie en autorisatie binnen VAS (Voxel Analytics Service).

---

## 1. Architectuur & Beveiligingsmodel

VAS fungeert als de centrale semantische laag voor datawarehouses en BI-tools (zoals Apache Superset, PowerBI, Tableau). De beveiligingsregels worden **centraal en server-side** afgedwongen. Zowel de REST API (poort 4000/4001) als de SQL-API (PostgreSQL Wire Protocol op poort 15432) delen exact hetzelfde autorisatiemodel.

```
       +-------------------------------------------------------------+
       |                  BI Client / Superset / psql                 |
       +-------------------------------------------------------------+
                                      |
                      Port 15432 (Postgres Wire Protocol)
                                      v
       +-------------------------------------------------------------+
       |                  VAS SQL-API (Cube Core)                    |
       |  checkSqlAuth: Verifieert credentials via 'user_accounts'   |
       |                Bouwt 'securityContext' met claims & rollen  |
       +-------------------------------------------------------------+
                                      |
                                      v
       +-------------------------------------------------------------+
       |           VAS Query Engine (runtime/cube.js)                |
       |  queryRewrite:                                              |
       |  - Haalt actieve 'access_policies' op uit PostgreSQL        |
       |  - OLS: Blokkeert verboden maatstaven & dimensies          |
       |  - RLS: Injecteert dynamische rijfilters o.b.v. claims      |
       |  - Deny-by-default: Fout bij ontbrekende claims/policies   |
       +-------------------------------------------------------------+
                                      |
                                      v
       +-------------------------------------------------------------+
       |               PostgreSQL Data Warehouse / DWH               |
       +-------------------------------------------------------------+
```

---

## 2. Componenten

### A. Gebruikersidentiteiten (`user_accounts`)
- **Tabel**: `user_accounts` in de metadata PostgreSQL database.
- **Wachtwoorden**: Worden gehasht opgeslagen met behulp van Node.js native `crypto.scrypt` met een unieke 16-byte random salt per gebruiker (`scrypt:<salt>:<hash>`).
- **Verificatie**: Loopt via `crypto.timingSafeEqual` ter voorkoming van timing attacks.
- **Geheimhouding**: Wachtwoordhashes worden nooit geretourneerd door de management-API endpoints (`listUsers`, `upsertUser`).
- **Claims**: Gestructureerd JSONB-veld (bijv. `{"city": "Amsterdam"}`) dat dynamisch wordt gekoppeld aan de sessie (`securityContext.claims`).

### B. Rollen & Rechten (`security_roles`)
- **Tabel**: `security_roles`.
- **Rollen**:
  - `admin`: Superuser. Volledige ongefilterde toegang tot alle data en het beheer van modellen en databronnen.
  - `sales_rep`: Reguliere gebruiker met dynamische RLS en OLS restricties.
  - `viewer`: Analist met alleen-lezen toegang tot geaggregeerde rapportages.

### C. Toegangsbeleid (`access_policies`)
- **Tabel**: `access_policies`.
- **Typen Beleid**:
  1. **RLS (Row-Level Security)**:
     - Definieert welk veld in de semantische laag wordt gefilterd (`member`: bijv. `Users.city`).
     - Bepaalt welke claim van de ingelogde gebruiker de filterwaarde levert (`claimField`: bijv. `city`).
     - **Deny-by-default**: Indien een gebruiker een rol heeft waarvoor een claim-gebaseerde policy geldt, maar de vereiste claim ontbreekt in het profiel, wordt de query direct geweigerd (`Access Denied: vereiste beveiligingsclaim '...' ontbreekt`).
  2. **OLS (Object-Level Security)**:
     - Definieert welke maatstaven (`denyMeasures`) of dimensies (`denyDimensions`) niet toegankelijk zijn voor een rol (bijv. `Orders.avg_amount`).
     - Indien een client een query indient die een afgeschermde kolom bevat, breekt VAS de query direct af vóórdat er SQL naar de database wordt gestuurd.

---

## 3. Productiebeveiliging & Secrets

1. **Standaard Secret Blokkade**:
   Indien `NODE_ENV === 'production'`, controleert VAS bij het opstarten of `CUBEJS_API_SECRET` is ingesteld en niet gelijk is aan de bekende standaardwaarde `mysecretkey123`. Als het standaard geheim wordt gedetecteerd, weigert de service te starten met een foutmelding.
2. **SQL Tester Veiligheidslimiet**:
   Het interactieve test-endpoint `/security/test-sql` dwingt automatisch een `LIMIT 100` af op alle uitgevoerde queries, vereist server-side authenticatie tegen `user_accounts`, en maskeert wachtwoorden en gevoelige verbindingsstrings in foutmeldingen. In productieomgevingen is dit endpoint uitgeschakeld voor niet-beheerders.

---

## 4. Operationele Procedures

### A. Sleutelrotatie (API Secret)
1. Genereer een veilige random sleutel:
   ```bash
   openssl rand -base64 32
   ```
2. Update de omgevingsvariabele `CUBEJS_API_SECRET` in de deployment-configuratie / Docker compose secret / `.env`.
3. Herstart de VAS service (`docker compose restart cube`).

### B. Accountintrekking & Deactivatie
Wanneer een medewerker de organisatie verlaat of de toegang direct moet worden ingetrokken:
1. Voer een soft-delete uit via de Management API:
   ```bash
   curl -X DELETE -H "Authorization: Bearer <API_SECRET>" \
     http://localhost:4001/management/v1/security/users/<username_of_id>
   ```
2. De gebruiker wordt gemarkeerd als `is_active = false`. Alle opvolgende pogingen om te verbinden via SQL-API of REST API worden direct afgewezen met `Gebruiker is inactief`.

### C. Aanpassen van Toegangsbeleid (Zero Downtime)
Omdat het beleid centraal in PostgreSQL staat opgeslagen, zijn beleidswijzigingen direct actief:
```bash
# Voorbeeld: RLS toevoegen voor rol 'marketing' op 'Campaigns'
curl -X POST -H "Content-Type: application/json" -H "Authorization: Bearer <API_SECRET>" \
  -d '{
    "role_id": "marketing",
    "cube_name": "Campaigns",
    "policy_type": "RLS",
    "definition": {"member": "Campaigns.country", "operator": "equals", "claimField": "country"}
  }' \
  http://localhost:4001/management/v1/security/policies
```
Alle nieuwe queries via SQL-API of REST hanteren direct het nieuwe beleid zonder dat VAS opnieuw opgestart hoeft te worden.
