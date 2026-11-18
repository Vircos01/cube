"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemorySchemaRepository = void 0;
exports.validateSchemaContent = validateSchemaContent;
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
//# sourceMappingURL=validator.js.map