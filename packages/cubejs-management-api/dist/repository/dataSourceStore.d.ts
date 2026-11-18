import { Pool } from 'pg';
import { DataSourceRecord, CreateDataSourceInput } from '../types';
export declare function upsertDataSource(pool: Pool, input: CreateDataSourceInput): Promise<DataSourceRecord>;
export declare function getDataSource(pool: Pool, idOrName: string): Promise<DataSourceRecord | null>;
export declare function getSafeDataSource(pool: Pool, idOrName: string): Promise<Omit<DataSourceRecord, 'password'> & {
    hasPassword: boolean;
} | null>;
export declare function listDataSources(pool: Pool): Promise<DataSourceRecord[]>;
export declare function deleteDataSource(pool: Pool, idOrName: string): Promise<boolean>;
//# sourceMappingURL=dataSourceStore.d.ts.map