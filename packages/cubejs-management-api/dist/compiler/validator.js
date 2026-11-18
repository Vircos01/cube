"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemorySchemaRepository = void 0;
exports.validateSchemaContent = validateSchemaContent;
exports.validateBatchSchemas = validateBatchSchemas;
const js_yaml_1 = __importDefault(require("js-yaml"));
const schema_compiler_1 = require("@cubejs-backend/schema-compiler");
class MemorySchemaRepository {
    files;
    pathStr;
    constructor(files, pathStr = '/virtual') {
        this.files = files;
        this.pathStr = pathStr;
    }
    localPath() {
        return this.pathStr;
    }
    async dataSchemaFiles() {
        return this.files;
    }
}
exports.MemorySchemaRepository = MemorySchemaRepository;
async function validateSchemaContent(content, fileName = 'model.cube.yml', existingFiles = [], dialect = 'postgres') {
    const errors = [];
    const warnings = [];
    // Step 1: YAML Syntax Check
    if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) {
        try {
            js_yaml_1.default.load(content);
        }
        catch (yamlErr) {
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
        const filesToCompile = [
            ...existingFiles.filter(f => f.fileName !== fileName),
            { fileName, content, readOnly: false },
        ];
        const repo = new MemorySchemaRepository(filesToCompile);
        const compilers = (0, schema_compiler_1.prepareCompiler)(repo, { adapter: dialect });
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
    }
    catch (compileErr) {
        const message = compileErr.message || String(compileErr);
        // Parse line and column from compiler error if present
        let line;
        let column;
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
async function validateBatchSchemas(newFiles, existingFiles = [], dialect = 'postgres') {
    const errors = [];
    const warnings = [];
    // Step 1: YAML Syntax Check for all new files
    for (const file of newFiles) {
        if (file.fileName.endsWith('.yml') || file.fileName.endsWith('.yaml')) {
            try {
                js_yaml_1.default.load(file.content);
            }
            catch (yamlErr) {
                return {
                    valid: false,
                    errors: [{
                            message: `[${file.fileName}] YAML Syntax Error: ${yamlErr.reason || yamlErr.message}`,
                            line: yamlErr.mark?.line != null ? yamlErr.mark.line + 1 : undefined,
                            column: yamlErr.mark?.column != null ? yamlErr.mark.column + 1 : undefined,
                            snippet: yamlErr.mark?.snippet,
                            code: 'YAML_SYNTAX_ERROR',
                        }],
                    warnings: [],
                };
            }
        }
    }
    // Step 2: Semantic Compiler Check of the entire set of models
    try {
        const newFileNames = new Set(newFiles.map(f => f.fileName));
        const combinedFiles = [
            ...existingFiles.filter(f => !newFileNames.has(f.fileName)),
            ...newFiles.map(f => ({ fileName: f.fileName, content: f.content, readOnly: false })),
        ];
        const repo = new MemorySchemaRepository(combinedFiles);
        const compilers = (0, schema_compiler_1.prepareCompiler)(repo, { adapter: dialect });
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
    }
    catch (compileErr) {
        const message = compileErr.message || String(compileErr);
        let line;
        let column;
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
//# sourceMappingURL=validator.js.map