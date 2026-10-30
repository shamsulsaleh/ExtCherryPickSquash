import { GitService } from '../git/gitService';
import { CherryPickMode, CherryPickSession, SessionStore, StepResult, orderOldestFirst } from './types';

export { orderOldestFirst };

export class CherryPickEngine {
    private session: CherryPickSession | undefined;

    constructor(
        private readonly git: GitService,
        private readonly store: SessionStore
    ) {
        const existing = store.get();
        if (existing && existing.repoRoot === git.repoRoot) {
            this.session = existing;
        }
    }

    getSession(): CherryPickSession | undefined {
        return this.session;
    }

    private async persist(): Promise<void> {
        await this.store.set(this.session);
    }

    private async clear(): Promise<void> {
        this.session = undefined;
        await this.store.set(undefined);
    }

    async start(opts: {
        targetBranch: string;
        /** already oldest-first */
        commits: string[];
        mainline?: number;
        appendX: boolean;
        stashed: boolean;
        mode?: CherryPickMode;
        /** required for squash mode */
        squashMessage?: string;
    }): Promise<StepResult> {
        const mode = opts.mode ?? 'pick';
        this.session = {
            mode,
            origHead: mode === 'squash' ? await this.git.revParse('HEAD') : undefined,
            squashMessage: opts.squashMessage,
            repoRoot: this.git.repoRoot,
            targetBranch: opts.targetBranch,
            queue: opts.commits,
            currentIndex: 0,
            state: 'running',
            mainline: opts.mainline,
            appendX: opts.appendX,
            stashed: opts.stashed,
            applied: [],
            skipped: [],
        };
        await this.persist();
        return this.runQueue();
    }

    async continue(): Promise<StepResult> {
        const s = this.session;
        if (!s) {
            return { kind: 'error', commit: '', message: 'No cherry-pick session in progress.' };
        }
        if (s.currentIndex >= s.queue.length) {
            // Queue already applied; only the squash commit is left (e.g. it failed before).
            return this.runQueue();
        }

        const inProgress = await this.hasCherryPickHead();
        if (inProgress) {
            const unmerged = await this.git.getConflictedFiles();
            const markers = await this.git.filesWithConflictMarkers(unmerged);
            if (markers.length > 0) {
                return { kind: 'unresolved', files: markers };
            }
            if (unmerged.length > 0) {
                // Resolved in the working tree but not yet staged.
                await this.git.stageFiles(unmerged);
            }
            const res = await this.git.continueCherryPick();
            if (res.status === 'error') {
                if (/nothing to commit|previous cherry-pick is now empty|no changes added/i.test(res.message)) {
                    // Resolution made the commit empty — skip it.
                    try {
                        await this.git.skipCherryPick();
                    } catch {
                        // already gone; fall through
                    }
                    s.skipped.push(s.queue[s.currentIndex]);
                } else {
                    s.state = 'paused_conflict';
                    await this.persist();
                    return { kind: 'error', commit: s.queue[s.currentIndex], message: res.message };
                }
            } else {
                s.applied.push(s.queue[s.currentIndex]);
            }
        } else {
            // User already committed the resolution themselves.
            s.applied.push(s.queue[s.currentIndex]);
        }

        s.currentIndex++;
        s.state = 'running';
        await this.persist();
        return this.runQueue();
    }

    async skip(): Promise<StepResult> {
        const s = this.session;
        if (!s) {
            return { kind: 'error', commit: '', message: 'No cherry-pick session in progress.' };
        }
        if (s.currentIndex >= s.queue.length) {
            return this.runQueue();
        }
        if (await this.hasCherryPickHead()) {
            await this.git.skipCherryPick();
        }
        s.skipped.push(s.queue[s.currentIndex]);
        s.currentIndex++;
        s.state = 'running';
        await this.persist();
        return this.runQueue();
    }

    async abort(): Promise<{ stashed: boolean }> {
        const s = this.session;
        if (s && (await this.hasCherryPickHead())) {
            await this.git.abortCherryPick();
        }
        if (s?.mode === 'squash' && s.origHead) {
            // Squash is all-or-nothing: drop every commit applied by this session.
            await this.git.resetHard(s.origHead);
        }
        const stashed = s?.stashed ?? false;
        await this.clear();
        return { stashed };
    }

    private async hasCherryPickHead(): Promise<boolean> {
        return (await this.git.getOperationInProgress()) === 'cherry-pick';
    }

    private async runQueue(): Promise<StepResult> {
        const s = this.session;
        if (!s) {
            return { kind: 'error', commit: '', message: 'No cherry-pick session in progress.' };
        }
        while (s.currentIndex < s.queue.length) {
            const hash = s.queue[s.currentIndex];
            await this.persist();
            const res = await this.git.cherryPick(hash, { mainline: s.mainline, appendX: s.appendX });
            switch (res.status) {
                case 'ok':
                    s.applied.push(hash);
                    s.currentIndex++;
                    break;
                case 'empty':
                    try {
                        await this.git.skipCherryPick();
                    } catch {
                        // nothing to skip; treat as skipped anyway
                    }
                    s.skipped.push(hash);
                    s.currentIndex++;
                    break;
                case 'conflict':
                    s.state = 'paused_conflict';
                    await this.persist();
                    return {
                        kind: 'conflict',
                        commit: hash,
                        files: res.files,
                        index: s.currentIndex + 1,
                        total: s.queue.length,
                    };
                case 'error':
                    s.state = 'paused_conflict';
                    await this.persist();
                    return { kind: 'error', commit: hash, message: res.message };
            }
        }
        const mode = s.mode ?? 'pick';
        let squashedInto: string | undefined;
        if (mode === 'squash' && s.origHead && s.applied.length > 0) {
            try {
                await this.git.resetSoft(s.origHead);
                if (await this.git.hasStagedChanges()) {
                    squashedInto = await this.git.commitWithMessage(s.squashMessage || 'Squashed commits');
                }
            } catch (err) {
                s.state = 'paused_conflict';
                await this.persist();
                return { kind: 'error', commit: '', message: `Squash commit failed: ${String(err)}` };
            }
        }
        const result: StepResult = {
            kind: 'completed',
            applied: [...s.applied],
            skipped: [...s.skipped],
            stashed: s.stashed,
            mode,
            squashedInto,
        };
        await this.clear();
        return result;
    }
}
