import { Client } from 'pg';
import http from 'http';
import jwt from 'jsonwebtoken';

const CUBE_SQL_PORT = 15432;
const CUBE_REST_PORT = 4000;
const API_SECRET = process.env.CUBEJS_API_SECRET || 'mysecretkey123';

function isServerListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new (require('net').Socket)();
    socket.setTimeout(800);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

function executeRestQuery(token: string, query: Record<string, any>): Promise<{ status: number; data?: any; error?: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query });
    const req = http.request(`http://127.0.0.1:${CUBE_REST_PORT}/cubejs-api/v1/load`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      let buffer = '';
      res.on('data', (c) => (buffer += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(buffer);
          resolve({ status: res.statusCode || 200, data: parsed.data, error: parsed.error });
        } catch {
          resolve({ status: res.statusCode || 200, error: buffer });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('Fase 6: BI-compatibiliteit, Verificatie & Interface Parity (SQL & REST)', () => {
  let isSqlUp = false;
  let isRestUp = false;

  beforeAll(async () => {
    isSqlUp = await isServerListening(CUBE_SQL_PORT);
    isRestUp = await isServerListening(CUBE_REST_PORT);
  });

  const runIfLive = (name: string, fn: () => Promise<void>) => {
    it(name, async () => {
      if (!isSqlUp || !isRestUp) {
        console.warn(`[SKIP] Live Cube servers niet bereikbaar op port ${CUBE_SQL_PORT} of ${CUBE_REST_PORT}`);
        return;
      }
      await fn();
    });
  };

  describe('1. Metadata Discovery (BI Tools Catalog Introspection)', () => {
    runIfLive('SQL API: information_schema.tables rapporteert semantische modellen als tabellen', async () => {
      const client = new Client({
        host: '127.0.0.1',
        port: CUBE_SQL_PORT,
        user: 'admin',
        password: 'admin',
        database: 'cube',
      });
      await client.connect();
      const res = await client.query('SELECT table_name FROM information_schema.tables ORDER BY table_name ASC;');
      await client.end();

      const tableNames = res.rows.map((r) => r.table_name);
      expect(tableNames).toContain('Orders');
      expect(tableNames).toContain('Products');
      expect(tableNames).toContain('Users');
    });

    runIfLive('SQL API: information_schema.columns toont alle measures en dimensions met types', async () => {
      const client = new Client({
        host: '127.0.0.1',
        port: CUBE_SQL_PORT,
        user: 'admin',
        password: 'admin',
        database: 'cube',
      });
      await client.connect();
      const res = await client.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'Orders';
      `);
      await client.end();

      const colNames = res.rows.map((r) => r.column_name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('status');
      expect(colNames).toContain('count');
      expect(colNames).toContain('total_amount');
      expect(colNames).toContain('avg_order_value');
    });

    runIfLive('REST API: /cubejs-api/v1/meta levert identieke kubusstructuur', async () => {
      const meta = await new Promise<{ cubes: Array<{ name: string }> }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${CUBE_REST_PORT}/cubejs-api/v1/meta`, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
      });

      const cubeNames = meta.cubes.map((c) => c.name);
      expect(cubeNames).toContain('Orders');
      expect(cubeNames).toContain('Products');
      expect(cubeNames).toContain('Users');
    });
  });

  describe('2. Datatype Mapping, Aggregaties en Null Handling', () => {
    runIfLive('SQL API levert numerieke aggregaties en strings correct af', async () => {
      const client = new Client({
        host: '127.0.0.1',
        port: CUBE_SQL_PORT,
        user: 'admin',
        password: 'admin',
        database: 'cube',
      });
      await client.connect();
      const res = await client.query(`
        SELECT status, count, total_amount 
        FROM "Orders" 
        WHERE status = 'completed'
        LIMIT 1;
      `);
      await client.end();

      expect(res.rows.length).toBe(1);
      const row = res.rows[0];
      expect(row.status).toBe('completed');
      expect(Number(row.count)).toBeGreaterThan(0);
      expect(Number(row.total_amount)).toBeGreaterThan(0);
    });

    runIfLive('SQL API: Filter op niet-bestaande status resulteert in 0 rijen zonder fout', async () => {
      const client = new Client({
        host: '127.0.0.1',
        port: CUBE_SQL_PORT,
        user: 'admin',
        password: 'admin',
        database: 'cube',
      });
      await client.connect();
      const res = await client.query(`
        SELECT count FROM "Orders" WHERE status = 'non_existent_status_123';
      `);
      await client.end();

      expect(res.rows.length).toBe(0);
    });

    runIfLive('SQL API: Paginering via LIMIT en OFFSET werkt voorspelbaar', async () => {
      const client = new Client({
        host: '127.0.0.1',
        port: CUBE_SQL_PORT,
        user: 'admin',
        password: 'admin',
        database: 'cube',
      });
      await client.connect();
      const res1 = await client.query('SELECT id, status FROM "Orders" ORDER BY id ASC LIMIT 2 OFFSET 0;');
      const res2 = await client.query('SELECT id, status FROM "Orders" ORDER BY id ASC LIMIT 2 OFFSET 1;');
      await client.end();

      expect(res1.rows.length).toBe(2);
      expect(res2.rows.length).toBe(2);
      expect(res1.rows[1].id).toBe(res2.rows[0].id);
    });
  });

  describe('3. Beveiligings- en Resultaatconsistentie tussen SQL en REST (Parity)', () => {
    const adminToken = jwt.sign({ u: { username: 'admin', role: 'admin', isAdmin: true } }, API_SECRET);
    const amsToken = jwt.sign({ u: { username: 'sales_amsterdam', role: 'sales_rep', claims: { city: 'Amsterdam' } } }, API_SECRET);
    const rtdToken = jwt.sign({ u: { username: 'sales_rotterdam', role: 'sales_rep', claims: { city: 'Rotterdam' } } }, API_SECRET);

    runIfLive('Admin ziet alle orders consistent over SQL en REST', async () => {
      // SQL
      const client = new Client({
        host: '127.0.0.1',
        port: CUBE_SQL_PORT,
        user: 'admin',
        password: 'admin',
        database: 'cube',
      });
      await client.connect();
      const sqlRes = await client.query('SELECT count, total_amount FROM "Orders";');
      await client.end();

      // REST
      const restRes = await executeRestQuery(adminToken, {
        measures: ['Orders.count', 'Orders.total_amount'],
      });

      const totalSqlAmount = sqlRes.rows.reduce((acc, r) => acc + Number(r.total_amount), 0);
      const totalRestAmount = restRes.data?.reduce((acc: number, r: any) => acc + Number(r['Orders.total_amount']), 0);

      expect(Math.round(totalSqlAmount)).toBe(Math.round(totalRestAmount));
    });

    runIfLive('Amsterdam Sales Rep: RLS claim filter levert identieke subset op SQL en REST', async () => {
      // SQL
      const client = new Client({
        host: '127.0.0.1',
        port: CUBE_SQL_PORT,
        user: 'sales_amsterdam',
        password: 'amsterdam123',
        database: 'cube',
      });
      await client.connect();
      const sqlRes = await client.query('SELECT count, total_amount, status FROM "Orders";');
      await client.end();

      // REST
      const restRes = await executeRestQuery(amsToken, {
        measures: ['Orders.count', 'Orders.total_amount'],
        dimensions: ['Orders.status'],
      });

      const sqlSum = sqlRes.rows.reduce((acc, r) => acc + Number(r.total_amount), 0);
      const restSum = restRes.data?.reduce((acc: number, r: any) => acc + Number(r['Orders.total_amount']), 0);

      expect(sqlRes.rows.length).toBe(2);
      expect(Math.round(sqlSum)).toBe(399); // 349.5 + 49.99 = 399.49
      expect(Math.round(restSum)).toBe(399);
    });

    runIfLive('Rotterdam Sales Rep: RLS levert alleen Rotterdamse orders op SQL en REST', async () => {
      // SQL
      const client = new Client({
        host: '127.0.0.1',
        port: CUBE_SQL_PORT,
        user: 'sales_rotterdam',
        password: 'rotterdam123',
        database: 'cube',
      });
      await client.connect();
      const sqlRes = await client.query('SELECT count, total_amount, status FROM "Orders";');
      await client.end();

      // REST
      const restRes = await executeRestQuery(rtdToken, {
        measures: ['Orders.count', 'Orders.total_amount'],
        dimensions: ['Orders.status'],
      });

      const sqlSum = sqlRes.rows.reduce((acc, r) => acc + Number(r.total_amount), 0);
      const restSum = restRes.data?.reduce((acc: number, r: any) => acc + Number(r['Orders.total_amount']), 0);

      expect(sqlRes.rows.length).toBe(2);
      expect(Math.round(sqlSum)).toBe(329); // 199.99 + 129.00 = 328.99
      expect(Math.round(restSum)).toBe(329);
    });

    runIfLive('Object-Level Security (OLS): Verboden maatstaf wordt op BEIDE interfaces geweigerd met duidelijke foutmelding', async () => {
      // SQL OLS Check
      const client = new Client({
        host: '127.0.0.1',
        port: CUBE_SQL_PORT,
        user: 'sales_amsterdam',
        password: 'amsterdam123',
        database: 'cube',
      });
      await client.connect();

      let sqlError: Error | null = null;
      try {
        await client.query('SELECT avg_order_value FROM "Orders";');
      } catch (err: any) {
        sqlError = err;
      } finally {
        await client.end();
      }

      expect(sqlError).not.toBeNull();
      expect(sqlError!.message).toContain('Orders.avg_order_value');
      expect(sqlError!.message).toContain('afgeschermd (Object-Level Security)');

      // REST OLS Check
      const restRes = await executeRestQuery(amsToken, {
        measures: ['Orders.avg_order_value'],
      });

      expect(restRes.status).toBe(500);
      expect(restRes.error).toContain('Orders.avg_order_value');
      expect(restRes.error).toContain('afgeschermd (Object-Level Security)');
    });
  });

  describe('4. Foutafhandeling en Onbestaande Objecten', () => {
    runIfLive('SQL API: Query op onbestaande tabel werpt een gestructureerde fout op', async () => {
      const client = new Client({
        host: '127.0.0.1',
        port: CUBE_SQL_PORT,
        user: 'admin',
        password: 'admin',
        database: 'cube',
      });
      await client.connect();

      let error: any = null;
      try {
        await client.query('SELECT * FROM "NonExistentTableXYZ";');
      } catch (err: any) {
        error = err;
      } finally {
        await client.end();
      }

      expect(error).not.toBeNull();
      expect(error.message).toContain('NonExistentTableXYZ');
    });

    runIfLive('SQL API: Foutieve inloggegevens worden direct geweigerd', async () => {
      const client = new Client({
        host: '127.0.0.1',
        port: CUBE_SQL_PORT,
        user: 'sales_amsterdam',
        password: 'verkeerd_wachtwoord_123',
        database: 'cube',
      });

      let authError: any = null;
      try {
        await client.connect();
      } catch (err: any) {
        authError = err;
      }

      expect(authError).not.toBeNull();
      expect(authError.message).toContain('password authentication failed');
    });
  });
});
