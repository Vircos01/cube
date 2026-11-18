export type ModelType = 'cube' | 'view';

export type RevisionStatus = 'active' | 'draft' | 'archived';

export interface SemanticModel {
  id: string;
  name: string;
  model_type: ModelType;
  file_name: string;
  description?: string | null;
  is_active: boolean;
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
  model_name?: string | null;
  revision_id?: string | null;
  details?: Record<string, any> | null;
  actor?: string | null;
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
}

export interface IntrospectResult {
  tables: IntrospectTable[];
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
}
