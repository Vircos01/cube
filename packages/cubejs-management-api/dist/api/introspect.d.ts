import { Pool, Client } from 'pg';
import { IntrospectResult, IntrospectTable, DatabaseConnectionConfig } from '../types';
export declare function toCubeName(tableName: string): string;
export declare function testDatabaseConnection(config: DatabaseConnectionConfig): Promise<{
    success: boolean;
    version?: string;
    schemas?: string[];
    latencyMs?: number;
    error?: string;
}>;
export declare function introspectPostgresDatabase(poolOrClient: Pool | Client, schema?: string): Promise<IntrospectResult>;
export declare function generateCubeDef(table: IntrospectTable, allSelectedTables?: IntrospectTable[], options?: {
    autoJoins?: boolean;
    autoMeasures?: boolean;
}): {
    cubeName: string;
    fileName: string;
    yaml: string;
    parsed: any;
};
//# sourceMappingURL=introspect.d.ts.map