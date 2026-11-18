export type ModelType = 'cube' | 'view';
export type RevisionStatus = 'active' | 'draft' | 'archived';
export declare class VersionConflictError extends Error {
    modelId: string;
    expectedRevision: number | string;
    currentRevision: number | string;
    currentChangeSummary?: string | undefined;
    currentUpdatedBy?: string | undefined;
    modelName?: string | undefined;
    currentRevisionId?: string | undefined;
    constructor(modelId: string, expectedRevision: number | string, currentRevision: number | string, currentChangeSummary?: string | undefined, currentUpdatedBy?: string | undefined, modelName?: string | undefined, currentRevisionId?: string | undefined);
}
export interface SemanticModel {
    id: string;
    name: string;
    model_type: ModelType;
    file_name: string;
    description?: string | null;
    is_active: boolean;
    version: number;
    created_at: Date | string;
    updated_at: Date | string;
}
export interface ModelRevision {
    id: string;
    model_id: string;
    revision_number: number;
    content: string;
    content_format: 'yaml' | 'json';
    parsed_json?: any;
    change_summary?: string | null;
    git_commit_hash?: string | null;
    status: RevisionStatus;
    created_by: string;
    created_at: Date | string;
}
export interface SemanticModelWithActiveRevision extends SemanticModel {
    active_revision?: ModelRevision | null;
}
export interface SemanticModelDetail extends SemanticModel {
    revisions: ModelRevision[];
    active_revision?: ModelRevision | null;
}
export interface AuditLogEntry {
    id: number | string;
    action: string;
    model_id?: string | null;
    model_name?: string | null;
    previous_revision_id?: string | null;
    revision_id?: string | null;
    details?: Record<string, any> | null;
    actor: string;
    source: string;
    result: 'SUCCESS' | 'FAILED';
    error_message?: string | null;
    ip_address?: string | null;
    created_at: Date | string;
}
export interface ValidationSuccess {
    valid: true;
    cubes: any[];
    views: any[];
    warnings: string[];
}
export interface ValidationErrorItem {
    message: string;
    line?: number;
    column?: number;
    snippet?: string;
    code?: string;
}
export interface ValidationFailure {
    valid: false;
    errors: ValidationErrorItem[];
    warnings: string[];
}
export type ValidationResult = ValidationSuccess | ValidationFailure;
export interface TableForeignKey {
    column: string;
    foreignSchema: string;
    foreignTable: string;
    foreignColumn: string;
}
export interface IntrospectColumn {
    name: string;
    type: string;
    nullable: boolean;
    isPrimaryKey?: boolean;
}
export interface IntrospectTable {
    schema: string;
    name: string;
    columns: IntrospectColumn[];
    foreignKeys?: TableForeignKey[];
}
export interface DatabaseConnectionConfig {
    type?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    schema?: string;
    ssl?: boolean;
}
export interface IntrospectResult {
    tables: IntrospectTable[];
    schemas?: string[];
    databaseVersion?: string;
}
export interface FileContent {
    fileName: string;
    content: string;
    readOnly?: boolean;
    isModule?: boolean;
}
export interface SchemaFileRepository {
    localPath: () => string;
    dataSchemaFiles: (includeDependencies?: boolean) => Promise<FileContent[]>;
}
export interface DatabaseConfig {
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    ssl?: boolean | any;
    max?: number;
    connectionTimeoutMillis?: number;
    idleTimeoutMillis?: number;
    statement_timeout?: number;
}
export interface DataSourceRecord {
    id: string;
    name: string;
    db_type: string;
    host: string;
    port: number;
    database_name: string;
    username: string;
    password?: string;
    schema_name?: string;
    ssl: boolean;
    created_at: Date;
    updated_at: Date;
}
export interface CreateDataSourceInput {
    name: string;
    db_type?: string;
    host: string;
    port: number;
    database_name: string;
    username: string;
    password?: string;
    schema_name?: string;
    ssl?: boolean;
}
export interface SecurityRole {
    id: string;
    name: string;
    display_name: string;
    description?: string;
    is_admin: boolean;
    can_manage_models: boolean;
    can_manage_datasources: boolean;
    created_at: Date;
    updated_at: Date;
    policies?: AccessPolicy[];
}
export interface UserAccount {
    id: string;
    username: string;
    password_hash?: string;
    display_name: string;
    email?: string;
    role_id: string;
    claims: Record<string, any>;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}
export interface AccessPolicy {
    id: string;
    role_id: string;
    cube_name: string;
    policy_type: 'RLS' | 'OLS';
    definition: Record<string, any>;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}
//# sourceMappingURL=types.d.ts.map