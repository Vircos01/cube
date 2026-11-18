import { exec } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { Pool } from 'pg';
import { exportModelsToDirectory, importModelsFromDirectory } from '../repository/fileMigrator';

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface GitStatusResult {
  branch: string;
  isClean: boolean;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  ahead: number;
  behind: number;
  latestCommit?: GitCommitInfo | null;
}

export interface GitDiffResult {
  diff: string;
  filesChanged: number;
}

export class GitService {
  public constructor(
    protected readonly repoDir: string = process.env.GIT_REPO_DIR || path.resolve(process.cwd(), '../..'),
    protected readonly modelsSubDir: string = process.env.GIT_MODELS_DIR || 'model'
  ) {}

  public getModelsPath(): string {
    return path.resolve(this.repoDir, this.modelsSubDir);
  }

  protected async execGit(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, { cwd: this.repoDir }, (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr.trim() || error.message));
        }
        resolve(stdout.trim());
      });
    });
  }

  public async isGitAvailable(): Promise<boolean> {
    try {
      await this.execGit('git rev-parse --is-inside-work-tree');
      return true;
    } catch {
      return false;
    }
  }

  public async getStatus(pool?: Pool): Promise<GitStatusResult> {
    // If pool is provided, sync active DB models to disk first so diff is real
    if (pool) {
      await exportModelsToDirectory(pool, this.getModelsPath());
    }

    const branch = await this.getCurrentBranch();
    const statusOutput = await this.execGit('git status --porcelain=v1');

    const stagedFiles: string[] = [];
    const unstagedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    const lines = statusOutput.split('\n').filter(Boolean);
    for (const line of lines) {
      const x = line[0];
      const y = line[1];
      const file = line.slice(3).trim();

      // We focus on model files or all tracked repo changes
      if (x !== ' ' && x !== '?') stagedFiles.push(file);
      if (y !== ' ' && y !== '?') unstagedFiles.push(file);
      if (x === '?' && y === '?') untrackedFiles.push(file);
    }

    let ahead = 0;
    let behind = 0;
    try {
      const counts = await this.execGit(`git rev-list --left-right --count origin/${branch}...${branch}`);
      const [b, a] = counts.split('\t').map(n => parseInt(n, 10));
      behind = b || 0;
      ahead = a || 0;
    } catch {
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

  public async getCurrentBranch(): Promise<string> {
    try {
      return await this.execGit('git branch --show-current');
    } catch {
      return 'master';
    }
  }

  public async getDiff(staged: boolean = false): Promise<GitDiffResult> {
    const cmd = staged ? 'git diff --staged' : 'git diff';
    const diff = await this.execGit(cmd);
    const filesChanged = (diff.match(/^diff --git/gm) || []).length;
    return { diff, filesChanged };
  }

  public async getLog(limit: number = 20): Promise<GitCommitInfo[]> {
    const format = '%H|%h|%an|%ae|%ad|%s';
    const output = await this.execGit(`git log -n ${limit} --pretty=format:"${format}" --date=iso`);
    if (!output) return [];

    return output.split('\n').filter(Boolean).map(line => {
      const [hash, shortHash, author, email, date, message] = line.split('|');
      return { hash, shortHash, author, email, date, message };
    });
  }

  public async getLatestCommit(): Promise<GitCommitInfo | null> {
    const log = await this.getLog(1);
    return log.length > 0 ? log[0] : null;
  }

  public async listBranches(): Promise<{ current: string; branches: string[] }> {
    const current = await this.getCurrentBranch();
    const output = await this.execGit('git branch --list');
    const branches = output.split('\n')
      .map(b => b.replace(/^\*?\s+/, '').trim())
      .filter(Boolean);
    return { current, branches };
  }

  public async checkoutBranch(
    branchName: string,
    createNew: boolean = false,
    pool?: Pool
  ): Promise<{ branch: string; importedCount?: number }> {
    const cmd = createNew ? `git checkout -b ${branchName}` : `git checkout ${branchName}`;
    await this.execGit(cmd);

    let importedCount = 0;
    if (pool && await fs.pathExists(this.getModelsPath())) {
      const importResult = await importModelsFromDirectory(pool, this.getModelsPath(), 'git-checkout');
      importedCount = importResult.imported.length;
    }

    return { branch: branchName, importedCount };
  }

  public async commitChanges(
    pool: Pool,
    params: {
      message: string;
      author?: string;
      push?: boolean;
    }
  ): Promise<{ commitHash: string; message: string; pushed: boolean }> {
    // 1. Export active PostgreSQL models to Git models directory
    const modelsPath = this.getModelsPath();
    await exportModelsToDirectory(pool, modelsPath);

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
      } catch (err: any) {
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

  public async pullChanges(
    pool: Pool,
    params: { remote?: string; branch?: string } = {}
  ): Promise<{ pulled: boolean; importedCount: number }> {
    const remote = params.remote || 'origin';
    const branch = params.branch || (await this.getCurrentBranch());

    try {
      await this.execGit(`git pull ${remote} ${branch}`);
    } catch (e: any) {
      console.warn('git pull note:', e.message);
    }

    // Sync pulled files into PostgreSQL
    const modelsPath = this.getModelsPath();
    let importedCount = 0;
    if (await fs.pathExists(modelsPath)) {
      const result = await importModelsFromDirectory(pool, modelsPath, 'git-pull');
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
