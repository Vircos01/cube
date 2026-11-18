import { Pool } from 'pg';
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
export declare class GitService {
    protected readonly repoDir: string;
    protected readonly modelsSubDir: string;
    constructor(repoDir?: string, modelsSubDir?: string);
    getModelsPath(): string;
    protected execGit(command: string): Promise<string>;
    isGitAvailable(): Promise<boolean>;
    getStatus(pool?: Pool): Promise<GitStatusResult>;
    getCurrentBranch(): Promise<string>;
    getDiff(staged?: boolean): Promise<GitDiffResult>;
    getLog(limit?: number): Promise<GitCommitInfo[]>;
    getLatestCommit(): Promise<GitCommitInfo | null>;
    listBranches(): Promise<{
        current: string;
        branches: string[];
    }>;
    checkoutBranch(branchName: string, createNew?: boolean, pool?: Pool): Promise<{
        branch: string;
        importedCount?: number;
    }>;
    commitChanges(pool: Pool, params: {
        message: string;
        author?: string;
        push?: boolean;
    }): Promise<{
        commitHash: string;
        message: string;
        pushed: boolean;
    }>;
    pullChanges(pool: Pool, params?: {
        remote?: string;
        branch?: string;
    }): Promise<{
        pulled: boolean;
        importedCount: number;
    }>;
}
//# sourceMappingURL=gitService.d.ts.map