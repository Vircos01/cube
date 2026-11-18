"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitService = void 0;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const fileMigrator_1 = require("../repository/fileMigrator");
class GitService {
    repoDir;
    modelsSubDir;
    constructor(repoDir = process.env.GIT_REPO_DIR || path_1.default.resolve(process.cwd(), '../..'), modelsSubDir = process.env.GIT_MODELS_DIR || 'model') {
        this.repoDir = repoDir;
        this.modelsSubDir = modelsSubDir;
    }
    getModelsPath() {
        return path_1.default.resolve(this.repoDir, this.modelsSubDir);
    }
    async execGit(command) {
        return new Promise((resolve, reject) => {
            (0, child_process_1.exec)(command, { cwd: this.repoDir }, (error, stdout, stderr) => {
                if (error) {
                    return reject(new Error(stderr.trim() || error.message));
                }
                resolve(stdout.trim());
            });
        });
    }
    async isGitAvailable() {
        try {
            await this.execGit('git rev-parse --is-inside-work-tree');
            return true;
        }
        catch {
            return false;
        }
    }
    async getStatus(pool) {
        // If pool is provided, sync active DB models to disk first so diff is real
        if (pool) {
            await (0, fileMigrator_1.exportModelsToDirectory)(pool, this.getModelsPath());
        }
        const branch = await this.getCurrentBranch();
        const statusOutput = await this.execGit('git status --porcelain=v1');
        const stagedFiles = [];
        const unstagedFiles = [];
        const untrackedFiles = [];
        const lines = statusOutput.split('\n').filter(Boolean);
        for (const line of lines) {
            const x = line[0];
            const y = line[1];
            const file = line.slice(3).trim();
            // We focus on model files or all tracked repo changes
            if (x !== ' ' && x !== '?')
                stagedFiles.push(file);
            if (y !== ' ' && y !== '?')
                unstagedFiles.push(file);
            if (x === '?' && y === '?')
                untrackedFiles.push(file);
        }
        let ahead = 0;
        let behind = 0;
        try {
            const counts = await this.execGit(`git rev-list --left-right --count origin/${branch}...${branch}`);
            const [b, a] = counts.split('\t').map(n => parseInt(n, 10));
            behind = b || 0;
            ahead = a || 0;
        }
        catch {
            // Remote branch may not exist yet or no network
        }
        const latestCommit = await this.getLatestCommit();
        return {
            branch,
            isClean: lines.length === 0,
            stagedFiles,
            unstagedFiles,
            untrackedFiles,
            ahead,
            behind,
            latestCommit,
        };
    }
    async getCurrentBranch() {
        try {
            return await this.execGit('git branch --show-current');
        }
        catch {
            return 'master';
        }
    }
    async getDiff(staged = false) {
        const cmd = staged ? 'git diff --staged' : 'git diff';
        const diff = await this.execGit(cmd);
        const filesChanged = (diff.match(/^diff --git/gm) || []).length;
        return { diff, filesChanged };
    }
    async getLog(limit = 20) {
        const format = '%H|%h|%an|%ae|%ad|%s';
        const output = await this.execGit(`git log -n ${limit} --pretty=format:"${format}" --date=iso`);
        if (!output)
            return [];
        return output.split('\n').filter(Boolean).map(line => {
            const [hash, shortHash, author, email, date, message] = line.split('|');
            return { hash, shortHash, author, email, date, message };
        });
    }
    async getLatestCommit() {
        const log = await this.getLog(1);
        return log.length > 0 ? log[0] : null;
    }
    async listBranches() {
        const current = await this.getCurrentBranch();
        const output = await this.execGit('git branch --list');
        const branches = output.split('\n')
            .map(b => b.replace(/^\*?\s+/, '').trim())
            .filter(Boolean);
        return { current, branches };
    }
    async checkoutBranch(branchName, createNew = false, pool) {
        const cmd = createNew ? `git checkout -b ${branchName}` : `git checkout ${branchName}`;
        await this.execGit(cmd);
        let importedCount = 0;
        if (pool && await fs_extra_1.default.pathExists(this.getModelsPath())) {
            const importResult = await (0, fileMigrator_1.importModelsFromDirectory)(pool, this.getModelsPath(), 'git-checkout');
            importedCount = importResult.imported.length;
        }
        return { branch: branchName, importedCount };
    }
    async commitChanges(pool, params) {
        // 1. Export active PostgreSQL models to Git models directory
        const modelsPath = this.getModelsPath();
        await (0, fileMigrator_1.exportModelsToDirectory)(pool, modelsPath);
        // 2. Stage models directory
        await this.execGit(`git add ${modelsPath}`);
        // Check if there are changes staged
        const status = await this.execGit('git status --porcelain');
        if (!status) {
            const latest = await this.getLatestCommit();
            return {
                commitHash: latest?.shortHash || 'unchanged',
                message: 'No changes detected to commit',
                pushed: false,
            };
        }
        // 3. Commit with explicit inline committer config
        const authorName = params.author || 'Cube Web-UI';
        const authorEmail = `${authorName.toLowerCase().replace(/[^a-z0-9]/g, '')}@cube.dev`;
        const safeMsg = params.message.replace(/"/g, '\\"');
        const gitUserConfig = `-c user.name="${authorName}" -c user.email="${authorEmail}"`;
        await this.execGit(`git ${gitUserConfig} commit -m "${safeMsg}"`);
        const latest = await this.getLatestCommit();
        let pushed = false;
        // 4. Optional Push
        if (params.push) {
            try {
                const branch = await this.getCurrentBranch();
                await this.execGit(`git push origin ${branch}`);
                pushed = true;
            }
            catch (err) {
                console.warn('Git push failed or remote not configured:', err.message);
            }
        }
        // 5. Audit log
        await pool.query(`
      INSERT INTO audit_logs (action, details, actor)
      VALUES ('GIT_COMMIT', $1, $2)
    `, [JSON.stringify({ commitHash: latest?.hash, message: params.message, pushed }), params.author || 'system']);
        return {
            commitHash: latest?.hash || '',
            message: params.message,
            pushed,
        };
    }
    async pullChanges(pool, params = {}) {
        const remote = params.remote || 'origin';
        const branch = params.branch || (await this.getCurrentBranch());
        try {
            await this.execGit(`git pull ${remote} ${branch}`);
        }
        catch (e) {
            console.warn('git pull note:', e.message);
        }
        // Sync pulled files into PostgreSQL
        const modelsPath = this.getModelsPath();
        let importedCount = 0;
        if (await fs_extra_1.default.pathExists(modelsPath)) {
            const result = await (0, fileMigrator_1.importModelsFromDirectory)(pool, modelsPath, 'git-pull');
            importedCount = result.imported.length;
        }
        // Audit log
        await pool.query(`
      INSERT INTO audit_logs (action, details, actor)
      VALUES ('GIT_PULL', $1, 'system')
    `, [JSON.stringify({ remote, branch, importedCount })]);
        return {
            pulled: true,
            importedCount,
        };
    }
}
exports.GitService = GitService;
//# sourceMappingURL=gitService.js.map