import { Pool, Client } from 'pg';
import jsyaml from 'js-yaml';
import {
  IntrospectResult,
  IntrospectTable,
  TableForeignKey,
  DatabaseConnectionConfig
} from '../types';

export function toCubeName(tableName: string): string {
  // Strip common table prefixes: sample_, tbl_, dim_, fact_
  const clean = tableName.replace(/^(sample_|tbl_|dim_|fact_)/i, '');
  const parts = clean.split(/[_-]+/);
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

export async function testDatabaseConnection(config: DatabaseConnectionConfig): Promise<{
  success: boolean;
  version?: string;
  schemas?: string[];
  latencyMs?: number;
  error?: string;
}> {
  const client = new Client({
    host: config.host || process.env.CUBEJS_DB_HOST || 'localhost',
    port: config.port || parseInt(process.env.CUBEJS_DB_PORT || '5432', 10),
    user: config.user || process.env.CUBEJS_DB_USER || 'postgres',
    password: config.password || process.env.CUBEJS_DB_PASS || 'postgres',
    database: config.database || process.env.CUBEJS_DB_NAME || 'cubedb',
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000
  });

  const start = Date.now();
  try {
    await client.connect();
    const verRes = await client.query('SELECT version()');
    const schemasRes = await client.query(`
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
      ORDER BY schema_name;
    `);
    const latencyMs = Date.now() - start;

    return {
      success: true,
      version: verRes.rows[0]?.version || 'PostgreSQL',
      schemas: schemasRes.rows.map(r => r.schema_name),
      latencyMs
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function introspectPostgresDatabase(
  poolOrClient: Pool | Client,
  schema: string = 'public'
): Promise<IntrospectResult> {
  const tablesQuery = `
    SELECT 
      table_schema,
      table_name,
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name NOT IN ('spatial_ref_sys', 'semantic_models', 'model_revisions', 'audit_logs', 'schema_version_tracker')
    ORDER BY table_schema, table_name, ordinal_position;
  `;

  const pkQuery = `
    SELECT
      tc.table_schema,
      tc.table_name,
      kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = $1;
  `;

  const fkQuery = `
    SELECT
      tc.table_schema, 
      tc.table_name, 
      kcu.column_name, 
      ccu.table_schema AS foreign_table_schema,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name 
    FROM information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = $1;
  `;

  const [colsRes, pkRes, fkRes] = await Promise.all([
    poolOrClient.query(tablesQuery, [schema]),
    poolOrClient.query(pkQuery, [schema]),
    poolOrClient.query(fkQuery, [schema]),
  ]);

  const pks = new Set<string>();
  for (const row of pkRes.rows) {
    pks.add(`${row.table_schema}.${row.table_name}.${row.column_name}`);
  }

  const fksMap = new Map<string, TableForeignKey[]>();
  for (const row of fkRes.rows) {
    const key = `${row.table_schema}.${row.table_name}`;
    if (!fksMap.has(key)) {
      fksMap.set(key, []);
    }
    fksMap.get(key)!.push({
      column: row.column_name,
      foreignSchema: row.foreign_table_schema,
      foreignTable: row.foreign_table_name,
      foreignColumn: row.foreign_column_name,
    });
  }

  const tableMap = new Map<string, IntrospectTable>();

  for (const row of colsRes.rows) {
    const key = `${row.table_schema}.${row.table_name}`;
    if (!tableMap.has(key)) {
      tableMap.set(key, {
        schema: row.table_schema,
        name: row.table_name,
        columns: [],
        foreignKeys: fksMap.get(key) || [],
      });
    }

    const isPrimaryKey = pks.has(`${row.table_schema}.${row.table_name}.${row.column_name}`);

    tableMap.get(key)!.columns.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      isPrimaryKey,
    });
  }

  return {
    tables: Array.from(tableMap.values()),
  };
}

export interface GenerateCubeOptions {
  autoJoins?: boolean;
  autoMeasures?: boolean;
  dataSource?: string;
  existingCubeNames?: string[] | Set<string>;
}

export function generateCubeDef(
  table: IntrospectTable,
  allSelectedTables: IntrospectTable[] = [],
  options: GenerateCubeOptions = {}
): {
  cubeName: string;
  fileName: string;
  yaml: string;
  parsed: any;
  skippedJoins?: string[];
} {
  const cubeName = toCubeName(table.name);
  const autoJoins = options.autoJoins !== false;
  const autoMeasures = options.autoMeasures !== false;

  // Determine which target cube names exist or will exist after this import
  const selectedCubeNames = new Set(allSelectedTables.map(t => toCubeName(t.name)));
  const existingCubeNames = options.existingCubeNames instanceof Set
    ? options.existingCubeNames
    : new Set(options.existingCubeNames || []);

  const availableCubeNames = new Set([...selectedCubeNames, ...existingCubeNames]);

  // 1. Dimensions
  const dimensions = table.columns.map(col => {
    let type = 'string';
    const lowerType = col.type.toLowerCase();
    if (
      lowerType.includes('int') ||
      lowerType.includes('num') ||
      lowerType.includes('float') ||
      lowerType.includes('double') ||
      lowerType.includes('decimal') ||
      lowerType.includes('real')
    ) {
      type = 'number';
    } else if (
      lowerType.includes('time') ||
      lowerType.includes('date')
    ) {
      type = 'time';
    } else if (lowerType.includes('bool')) {
      type = 'boolean';
    }

    const dim: any = {
      name: col.name,
      sql: col.name,
      type,
    };
    if (col.isPrimaryKey) {
      dim.primary_key = true;
    }
    return dim;
  });

  // 2. Measures
  const measures: any[] = [
    { name: 'count', type: 'count' }
  ];

  if (autoMeasures) {
    for (const col of table.columns) {
      const lower = col.name.toLowerCase();
      const lowerType = col.type.toLowerCase();
      const isNumeric =
        lowerType.includes('int') ||
        lowerType.includes('num') ||
        lowerType.includes('float') ||
        lowerType.includes('double') ||
        lowerType.includes('decimal');

      if (
        isNumeric &&
        !col.isPrimaryKey &&
        !lower.endsWith('_id') &&
        lower !== 'id'
      ) {
        measures.push({
          name: `total_${col.name}`,
          sql: col.name,
          type: 'sum',
        });
        measures.push({
          name: `avg_${col.name}`,
          sql: col.name,
          type: 'avg',
        });
      }
    }
  }

  // 3. Joins from Foreign Keys (safely filtered by available cubes)
  const joins: any[] = [];
  const skippedJoins: string[] = [];

  if (autoJoins && table.foreignKeys && table.foreignKeys.length > 0) {
    for (const fk of table.foreignKeys) {
      const targetCubeName = toCubeName(fk.foreignTable);
      // Avoid self-joins
      if (targetCubeName === cubeName) {
        continue;
      }

      // CRITICAL: Only generate joins to cubes that are in the import batch OR already exist in VAS
      if (availableCubeNames.has(targetCubeName)) {
        joins.push({
          name: targetCubeName,
          sql: `{CUBE}.${fk.column} = {${targetCubeName}.${fk.foreignColumn}}`,
          relationship: 'many_to_one',
        });
      } else {
        skippedJoins.push(
          `Join for ${table.name}.${fk.column} -> ${fk.foreignTable}.${fk.foreignColumn} skipped because target cube '${targetCubeName}' is not in the import batch or existing models.`
        );
      }
    }
  }

  const cubeObj: any = {
    name: cubeName,
  };

  // Add data_source property if targeting an external data source
  if (options.dataSource && options.dataSource !== 'default') {
    cubeObj.data_source = options.dataSource;
  }

  cubeObj.sql_table = `${table.schema}.${table.name}`;

  if (joins.length > 0) {
    cubeObj.joins = joins;
  }

  cubeObj.dimensions = dimensions;
  cubeObj.measures = measures;

  const fullDefinition = {
    cubes: [cubeObj],
  };

  const yaml = jsyaml.dump(fullDefinition, { indent: 2, lineWidth: -1 });
  return {
    cubeName,
    fileName: `${cubeName}.cube.yml`,
    yaml,
    parsed: fullDefinition,
    skippedJoins: skippedJoins.length > 0 ? skippedJoins : undefined,
  };
}
