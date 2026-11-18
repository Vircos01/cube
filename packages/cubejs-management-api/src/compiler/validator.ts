import yaml from 'js-yaml';
import { prepareCompiler } from '@cubejs-backend/schema-compiler';
import { SchemaFileRepository, FileContent } from '@cubejs-backend/shared';
import { ValidationResult, ValidationErrorItem } from '../types';

export class MemorySchemaRepository implements SchemaFileRepository {
  public constructor(
    protected readonly files: FileContent[],
    protected readonly pathStr: string = '/virtual'
  ) {}

  public localPath(): string {
    return this.pathStr;
  }

  public async dataSchemaFiles(): Promise<FileContent[]> {
    return this.files;
  }
}

export async function validateSchemaContent(
  content: string,
  fileName: string = 'model.cube.yml',
  existingFiles: FileContent[] = [],
  dialect: string = 'postgres'
): Promise<ValidationResult> {
  const errors: ValidationErrorItem[] = [];
  const warnings: string[] = [];

  // Step 1: YAML Syntax Check
  if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) {
    try {
      yaml.load(content);
    } catch (yamlErr: any) {
      const line = yamlErr.mark?.line != null ? yamlErr.mark.line + 1 : undefined;
      const column = yamlErr.mark?.column != null ? yamlErr.mark.column + 1 : undefined;
      const snippet = yamlErr.mark?.snippet;

      return {
        valid: false,
        errors: [{
          message: `YAML Syntax Error: ${yamlErr.reason || yamlErr.message}`,
          line,
          column,
          snippet,
          code: 'YAML_SYNTAX_ERROR',
        }],
        warnings: [],
      };
    }
  }

  // Step 2: Semantic Compiler Check using @cubejs-backend/schema-compiler
  try {
    const filesToCompile: FileContent[] = [
      ...existingFiles.filter(f => f.fileName !== fileName),
      { fileName, content, readOnly: false },
    ];

    const repo = new MemorySchemaRepository(filesToCompile);
    const compilers = prepareCompiler(repo, { adapter: dialect });

    await compilers.compile();

    const allCubes = (compilers.metaTransformer.cubes || []).map(tc => tc.config);
    const cubes = allCubes.filter(c => c.type !== 'view');
    const views = allCubes.filter(c => c.type === 'view');

    return {
      valid: true,
      cubes,
      views,
      warnings,
    };
  } catch (compileErr: any) {
    const message: string = compileErr.message || String(compileErr);

    // Parse line and column from compiler error if present
    let line: number | undefined;
    let column: number | undefined;
    const matchLine = message.match(/line\s*([0-9]+)/i) || message.match(/:([0-9]+):([0-9]+)/);
    if (matchLine) {
      line = parseInt(matchLine[1], 10);
      if (matchLine[2]) {
        column = parseInt(matchLine[2], 10);
      }
    }

    errors.push({
      message,
      line,
      column,
      code: 'SCHEMA_COMPILE_ERROR',
    });

    return {
      valid: false,
      errors,
      warnings,
    };
  }
}
