import { Pool } from 'pg';
import { DataSourceRecord, CreateDataSourceInput } from '../types';
export declare function upsertDataSource(pool: Pool, input: CreateDataSourceInput): Promise<DataSourceRecord>;
export declare function getDataSource(pool: Pool, name: string): Promise<DataSourceRecord | null>;
export declare function listDataSources(pool: Pool): Promise<DataSourceRecord[]>;
export declare function deleteDataSource(pool: Pool, name: string): Promise<boolean>;
//# sourceMappingURL=dataSourceStore.d.ts.map