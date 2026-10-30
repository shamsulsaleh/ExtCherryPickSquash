import * as fs from 'fs';
import * as path from 'path';
import { runGit } from './gitRunner';

export interface GitCommit {
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    relativeDate: string;
    isoDate: string;
    parents: string[];
    /** position in log, 0 = newest */
    index: number;
}

export interface GitBranch {
    /** short name e.g. main, origin/main */
    name: string;
    isRemote: boolean;
    current: boolean;
}

export type CherryPickResult =
    | { status: 'ok' }
    | { status: 'conflict'; files: string[] }
    | { status: 'empty' }
    | { status: 'error'; message: string };

const FIELD = '\x1f';

export class GitService {
    constructor(readonly repoRoot: string) {}

    async getCurrentBranch(): Promise<string | undefined> {
        const { code, stdout } = await runGit(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (code !== 0) {
            return undefined;
        }
        const name = stdout.trim();
        return name === 'HEAD' || name === '' ? undefined : name;
    }

    async getBranches(): Promise<GitBranch[]> {
        const { code, stdout } = await runGit(this.repoRoot, [
            'for-each-ref',
            `--format=%(refname)${FIELD}%(refname:short)${FIELD}%(HEAD)`,
            'refs/heads',
            'refs/remotes',
        ]);
        if (code !== 0) {
            return [];
        }
        const branches: GitBranch[] = [];
        for (const line of stdout.split('\n')) {
            if (!line.trim()) {
                continue;
            }
            const [refname, short, head] = line.split(FIELD);
            const isRemote = refname.startsWith('refs/remotes/');
            if (isRemote && short.endsWith('/HEAD')) {
                continue; // symbolic ref like origin/HEAD
            }
            branches.push({ name: short, isRemote, current: head.trim() === '*' });
        }
        return branches;
    }

    async getCommits(ref?: string, maxCount = 200): Promise<GitCommit[]> {
        const args = [
            'log',
            `--format=%H${FIELD}%h${FIELD}%an${FIELD}%ar${FIELD}%aI${FIELD}%P${FIELD}%s`,
            '-n',
            String(maxCount),
        ];
        if (ref) {
            args.push(ref);
        }
        const { code, stdout } = await runGit(this.repoRoot, args);
        if (code !== 0) {
            return [];
        }
        const commits: GitCommit[] = [];
        let index = 0;
        for (const line of stdout.split('\n')) {
            if (!line.trim()) {
                continue;
            }
            const [hash, shortHash, author, relativeDate, isoDate, parents, subject] = line.split(FIELD);
            commits.push({
                hash,
                shortHash,
                subject: subject ?? '',
                author,
                relativeDate,
                isoDate,
                parents: parents ? parents.trim().split(/\s+/).filter(Boolean) : [],
                index: index++,
            });
        }
        return commits;
    }

    async isWorkingTreeClean(): Promise<boolean> {
        const { code, stdout } = await runGit(this.repoRoot, ['status', '--porcelain']);
        return code === 0 && stdout.trim() === '';
    }

    async stash(message: string): Promise<void> {
        const { code, stderr } = await runGit(this.repoRoot, ['stash', 'push', '-u', '-m', message]);
        if (code !== 0) {
            throw new Error(`git stash failed: ${stderr.trim()}`);
        }
    }

    async stashPop(): Promise<void> {
        const { code, stderr } = await runGit(this.repoRoot, ['stash', 'pop']);
        if (code !== 0) {
            throw new Error(`git stash pop failed: ${stderr.trim()}`);
        }
    }

    async checkoutBranch(branch: GitBranch): Promise<string> {
        if (!branch.isRemote) {
            const { code, stderr } = await runGit(this.repoRoot, ['checkout', branch.name]);
            if (code !== 0) {
                throw new Error(`git checkout ${branch.name} failed: ${stderr.trim()}`);
            }
            return branch.name;
        }
        // Remote branch like origin/feat -> local feat
        const localName = branch.name.slice(branch.name.indexOf('/') + 1);
        const local = (await this.getBranches()).find((b) => !b.isRemote && b.name === localName);
        if (local) {
            const { code, stderr } = await runGit(this.repoRoot, ['checkout', localName]);
            if (code !== 0) {
                throw new Error(`git checkout ${localName} failed: ${stderr.trim()}`);
            }
            return localName;
        }
        const { code, stderr } = await runGit(this.repoRoot, [
            'checkout',
            '-b',
            localName,
            '--track',
            branch.name,
        ]);
        if (code !== 0) {
            throw new Error(`git checkout -b ${localName} --track ${branch.name} failed: ${stderr.trim()}`);
        }
        return localName;
    }

    async isValidBranchName(name: string): Promise<boolean> {
        const { code } = await runGit(this.repoRoot, ['check-ref-format', '--branch', name]);
        return code === 0;
    }

    /** Create `name` from `base` (any ref, e.g. HEAD, main, origin/main) and check it out, without upstream tracking. */
    async createBranch(name: string, base: string): Promise<void> {
        const { code, stderr } = await runGit(this.repoRoot, ['checkout', '--no-track', '-b', name, base]);
        if (code !== 0) {
            throw new Error(`git checkout -b ${name} ${base} failed: ${stderr.trim()}`);
        }
    }

    async revParse(ref: string): Promise<string> {
        const { code, stdout, stderr } = await runGit(this.repoRoot, ['rev-parse', '--verify', ref]);
        if (code !== 0) {
            throw new Error(`git rev-parse ${ref} failed: ${stderr.trim()}`);
        }
        return stdout.trim();
    }

    async resetSoft(ref: string): Promise<void> {
        await this.mustRun(['reset', '--soft', ref]);
    }

    async resetHard(ref: string): Promise<void> {
        await this.mustRun(['reset', '--hard', ref]);
    }

    async hasStagedChanges(): Promise<boolean> {
        const { code } = await runGit(this.repoRoot, ['diff', '--cached', '--quiet']);
        return code === 1;
    }

    /** Commit the index with `message` (multi-line allowed) and return the new HEAD hash. */
    async commitWithMessage(message: string): Promise<string> {
        const { stdout } = await runGit(this.repoRoot, ['rev-parse', '--git-path', 'GITCHERRYPICK_SQUASH_MSG']);
        const msgFile = path.resolve(this.repoRoot, stdout.trim());
        await fs.promises.writeFile(msgFile, message, 'utf8');
        try {
            await this.mustRun(['commit', '-F', msgFile]);
        } finally {
            await fs.promises.rm(msgFile, { force: true });
        }
        return this.revParse('HEAD');
    }

    private async mustRun(args: string[]): Promise<void> {
        const { code, stderr, stdout } = await runGit(this.repoRoot, args);
        if (code !== 0) {
            throw new Error(`git ${args[0]} failed: ${(stderr || stdout).trim()}`);
        }
    }

    private async gitPathExists(name: string): Promise<boolean> {
        const { code, stdout } = await runGit(this.repoRoot, ['rev-parse', '--git-path', name]);
        if (code !== 0) {
            return false;
        }
        const p = path.resolve(this.repoRoot, stdout.trim());
        return fs.existsSync(p);
    }

    async getOperationInProgress(): Promise<'cherry-pick' | 'merge' | 'rebase' | 'revert' | undefined> {
        if (await this.gitPathExists('CHERRY_PICK_HEAD')) {
            return 'cherry-pick';
        }
        if (await this.gitPathExists('MERGE_HEAD')) {
            return 'merge';
        }
        if (await this.gitPathExists('REVERT_HEAD')) {
            return 'revert';
        }
        if ((await this.gitPathExists('rebase-merge')) || (await this.gitPathExists('rebase-apply'))) {
            return 'rebase';
        }
        return undefined;
    }

    async cherryPick(hash: string, opts: { mainline?: number; appendX?: boolean }): Promise<CherryPickResult> {
        const args = ['cherry-pick'];
        if (opts.appendX) {
            args.push('-x');
        }
        if (opts.mainline !== undefined) {
            args.push('-m', String(opts.mainline));
        }
        args.push(hash);
        const { code, stderr } = await runGit(this.repoRoot, args);
        if (code === 0) {
            return { status: 'ok' };
        }
        const files = await this.getConflictedFiles();
        if (files.length > 0) {
            return { status: 'conflict', files };
        }
        if (await this.gitPathExists('CHERRY_PICK_HEAD')) {
            // Commit became empty (changes already present).
            return { status: 'empty' };
        }
        return { status: 'error', message: stderr.trim() || `git cherry-pick exited with code ${code}` };
    }

    async getConflictedFiles(): Promise<string[]> {
        const { code, stdout } = await runGit(this.repoRoot, ['diff', '--name-only', '--diff-filter=U']);
        if (code !== 0) {
            return [];
        }
        return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    }

    async filesWithConflictMarkers(files: string[]): Promise<string[]> {
        const marked: string[] = [];
        for (const f of files) {
            const p = path.join(this.repoRoot, f);
            let content: string;
            try {
                content = await fs.promises.readFile(p, 'utf8');
            } catch {
                continue;
            }
            const has = content.split(/\r?\n/).some(
                (line) => line.startsWith('<<<<<<< ') || line.startsWith('>>>>>>> ') || line === '======='
            );
            if (has) {
                marked.push(f);
            }
        }
        return marked;
    }

    async stageFiles(files: string[]): Promise<void> {
        if (files.length === 0) {
            return;
        }
        const { code, stderr } = await runGit(this.repoRoot, ['add', '--', ...files]);
        if (code !== 0) {
            throw new Error(`git add failed: ${stderr.trim()}`);
        }
    }

    async continueCherryPick(): Promise<{ status: 'ok' } | { status: 'error'; message: string }> {
        const { code, stderr } = await runGit(this.repoRoot, ['cherry-pick', '--continue'], {
            env: { GIT_EDITOR: 'true' },
        });
        if (code === 0) {
            return { status: 'ok' };
        }
        return { status: 'error', message: stderr.trim() || `git cherry-pick --continue exited with code ${code}` };
    }

    async skipCherryPick(): Promise<void> {
        const { code, stderr } = await runGit(this.repoRoot, ['cherry-pick', '--skip']);
        if (code !== 0) {
            throw new Error(`git cherry-pick --skip failed: ${stderr.trim()}`);
        }
    }

    async abortCherryPick(): Promise<void> {
        const { code, stderr } = await runGit(this.repoRoot, ['cherry-pick', '--abort']);
        if (code !== 0) {
            throw new Error(`git cherry-pick --abort failed: ${stderr.trim()}`);
        }
    }
}
