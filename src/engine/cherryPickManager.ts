import * as path from 'path';
import * as vscode from 'vscode';
import { GitCommit, GitService } from '../git/gitService';
import { pickTarget } from '../ui/quickPickHelper';
import { CherryPickStatusBar } from '../ui/statusBar';
import { CommitTreeDataProvider } from '../views/commitTreeDataProvider';
import { CherryPickEngine } from './cherryPickEngine';
import { CherryPickMode, SessionStore, StepResult, orderOldestFirst } from './types';

export function buildSquashMessage(subject: string, orderedCommits: GitCommit[]): string {
    const body = orderedCommits.map((c) => `- ${c.shortHash} ${c.subject}`).join('\n');
    return `${subject}\n\nSquashed commits:\n${body}\n`;
}

type State = 'idle' | 'running' | 'paused';

export class CherryPickManager {
    private readonly engines = new Map<string, CherryPickEngine>();
    private lastTarget = 'target';
    private lastRepoRoot = '';

    constructor(
        private readonly store: SessionStore,
        private readonly statusBar: CherryPickStatusBar,
        private readonly tree: CommitTreeDataProvider
    ) {}

    private engineFor(repoRoot: string): CherryPickEngine {
        let e = this.engines.get(repoRoot);
        if (!e) {
            e = new CherryPickEngine(new GitService(repoRoot), this.store);
            this.engines.set(repoRoot, e);
        }
        return e;
    }

    private activeEngine(): { engine: CherryPickEngine; git: GitService } | undefined {
        const session = this.store.get();
        if (!session) {
            return undefined;
        }
        const engine = this.engines.get(session.repoRoot) ?? this.engineFor(session.repoRoot);
        return { engine, git: new GitService(session.repoRoot) };
    }

    private async setContextState(state: State): Promise<void> {
        await vscode.commands.executeCommand('setContext', 'gitCherryPick.state', state);
    }

    async cherryPickCommits(repoRoot: string, commits: GitCommit[], mode: CherryPickMode = 'pick'): Promise<void> {
        if (commits.length === 0) {
            return;
        }
        const git = new GitService(repoRoot);
        const verb = mode === 'squash' ? 'Squash' : 'Cherry-pick';

        if (this.store.get()) {
            void vscode.window.showErrorMessage('A cherry-pick session is already in progress.');
            return;
        }
        const op = await git.getOperationInProgress();
        if (op) {
            void vscode.window.showErrorMessage(`Cannot cherry-pick: a ${op} operation is already in progress.`);
            return;
        }

        let mainline: number | undefined;
        const merges = commits.filter((c) => c.parents.length > 1);
        if (merges.length > 0) {
            const choice = await vscode.window.showWarningMessage(
                `${merges.length} merge commit(s) selected; cherry-pick using mainline parent 1?`,
                { modal: true },
                'Use parent 1'
            );
            if (choice !== 'Use parent 1') {
                return;
            }
            mainline = 1;
        }

        const target = await pickTarget(git, `${verb} ${commits.length} commit(s) to...`);
        if (!target) {
            return;
        }

        const ordered = orderOldestFirst(commits);
        let squashMessage: string | undefined;
        if (mode === 'squash') {
            const subject = await vscode.window.showInputBox({
                title: `Squash ${commits.length} commit(s): commit message`,
                prompt: 'Subject of the squash commit. The squashed commits are listed in the body automatically.',
                value: ordered.length === 1 ? ordered[0].subject : `Squash of ${ordered.length} commits`,
                validateInput: (v) => (v.trim() ? undefined : 'Commit message is required.'),
            });
            if (!subject) {
                return;
            }
            squashMessage = buildSquashMessage(subject.trim(), ordered);
        }

        let stashed = false;
        if (!(await git.isWorkingTreeClean())) {
            const choice = await vscode.window.showWarningMessage(
                'Working tree has uncommitted changes.',
                { modal: true },
                'Stash & Continue'
            );
            if (choice !== 'Stash & Continue') {
                return;
            }
            try {
                await git.stash('gitcherrypick auto-stash');
            } catch (err) {
                void vscode.window.showErrorMessage(String(err));
                return;
            }
            stashed = true;
        }

        let targetName: string;
        try {
            if (target.kind === 'new') {
                await git.createBranch(target.name, target.base);
                targetName = target.name;
            } else {
                targetName = target.branch.name;
                const current = await git.getCurrentBranch();
                if (target.branch.isRemote || target.branch.name !== current) {
                    targetName = await git.checkoutBranch(target.branch);
                }
            }
        } catch (err) {
            void vscode.window.showErrorMessage(String(err));
            return;
        }

        const appendX = vscode.workspace
            .getConfiguration('gitCherryPick')
            .get<boolean>('appendCherryPickedFrom', false);
        const hashes = ordered.map((c) => c.hash);
        const engine = this.engineFor(repoRoot);

        this.lastTarget = targetName;
        this.lastRepoRoot = repoRoot;
        await this.setContextState('running');
        this.statusBar.showRunning(1, hashes.length);
        let result: StepResult;
        try {
            result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.SourceControl,
                    title: `${mode === 'squash' ? 'Squashing' : 'Cherry-picking'} ${hashes.length} commit(s) to ${targetName}`,
                },
                () =>
                    engine.start({
                        targetBranch: targetName,
                        commits: hashes,
                        mainline,
                        appendX,
                        stashed,
                        mode,
                        squashMessage,
                    })
            );
        } catch (err) {
            result = { kind: 'error', commit: '', message: String(err) };
        }
        await this.handleResult(engine, result);
    }

    async continue(): Promise<void> {
        const active = this.activeEngine();
        if (!active) {
            return;
        }
        this.rememberSession();
        await this.setContextState('running');
        const session = active.engine.getSession();
        this.statusBar.showRunning(
            (session?.currentIndex ?? 0) + 1,
            session?.queue.length ?? 0
        );
        let result: StepResult;
        try {
            result = await active.engine.continue();
        } catch (err) {
            result = { kind: 'error', commit: '', message: String(err) };
        }
        await this.handleResult(active.engine, result);
    }

    async skip(): Promise<void> {
        const active = this.activeEngine();
        if (!active) {
            return;
        }
        this.rememberSession();
        await this.setContextState('running');
        let result: StepResult;
        try {
            result = await active.engine.skip();
        } catch (err) {
            result = { kind: 'error', commit: '', message: String(err) };
        }
        await this.handleResult(active.engine, result);
    }

    async abort(): Promise<void> {
        const active = this.activeEngine();
        const session = active?.engine.getSession() ?? this.store.get();
        if (!active || !session) {
            return;
        }
        const applied = session.applied.length;
        const choice = await vscode.window.showWarningMessage(
            session.mode === 'squash'
                ? `Abort squash? All changes from this squash are discarded and ${session.targetBranch} is reset to where it started.`
                : `Abort current commit? Already applied commits (${applied}) stay on ${session.targetBranch}.`,
            { modal: true },
            'Abort'
        );
        if (choice !== 'Abort') {
            return;
        }
        const { stashed } = await active.engine.abort();
        await this.setContextState('idle');
        this.statusBar.hide();
        this.tree.refresh();
        void vscode.window.showInformationMessage('Cherry-pick aborted.');
        if (stashed) {
            void this.offerStashPop(session.repoRoot);
        }
    }

    async showActions(): Promise<void> {
        const picked = await vscode.window.showQuickPick(
            [
                { label: '$(debug-continue) Continue', action: 'continue' },
                { label: '$(debug-step-over) Skip', action: 'skip' },
                { label: '$(debug-stop) Abort', action: 'abort' },
            ],
            { title: 'Cherry-pick actions' }
        );
        if (!picked) {
            return;
        }
        switch (picked.action) {
            case 'continue':
                await this.continue();
                break;
            case 'skip':
                await this.skip();
                break;
            case 'abort':
                await this.abort();
                break;
        }
    }

    async restoreSession(): Promise<void> {
        const session = this.store.get();
        if (!session) {
            await this.setContextState('idle');
            return;
        }
        const git = new GitService(session.repoRoot);
        const engine = this.engineFor(session.repoRoot);
        const i = session.currentIndex + 1;
        const n = session.queue.length;
        if ((await git.getOperationInProgress()) === 'cherry-pick') {
            await this.setContextState('paused');
            this.statusBar.showPaused(i, n);
            void vscode.window
                .showWarningMessage(
                    `Cherry-pick is paused on a conflict (${i}/${n}). Resolve, then Continue.`,
                    'Continue',
                    'Skip',
                    'Abort'
                )
                .then((choice) => this.dispatchAction(choice));
        } else {
            const choice = await vscode.window.showInformationMessage(
                `An unfinished cherry-pick queue was found (${i}/${n}).`,
                'Resume',
                'Discard'
            );
            if (choice === 'Resume') {
                await this.continue();
            } else if (choice === 'Discard') {
                await engine.abort();
                await this.setContextState('idle');
                this.statusBar.hide();
            } else {
                await this.setContextState('paused');
                this.statusBar.showPaused(i, n);
            }
        }
    }

    private async dispatchAction(choice: string | undefined): Promise<void> {
        switch (choice) {
            case 'Continue':
                await this.continue();
                break;
            case 'Skip':
                await this.skip();
                break;
            case 'Abort':
                await this.abort();
                break;
        }
    }

    private async handleResult(engine: CherryPickEngine, result: StepResult): Promise<void> {
        const session = engine.getSession();
        if (session) {
            this.lastTarget = session.targetBranch;
            this.lastRepoRoot = session.repoRoot;
        }
        const i = (session?.currentIndex ?? 0) + 1;
        const n = session?.queue.length ?? 0;
        switch (result.kind) {
            case 'completed': {
                await this.setContextState('idle');
                this.statusBar.hide();
                const skippedNote = `(${result.skipped.length} skipped)`;
                void vscode.window.showInformationMessage(
                    result.mode !== 'squash'
                        ? `Cherry-picked ${result.applied.length} commit(s) to ${this.lastTarget} ${skippedNote}.`
                        : result.squashedInto
                          ? `Squashed ${result.applied.length} commit(s) into ${result.squashedInto.slice(0, 7)} on ${this.lastTarget} ${skippedNote}.`
                          : `Nothing to squash: no changes left to commit on ${this.lastTarget} ${skippedNote}.`
                );
                if (result.stashed && this.lastRepoRoot) {
                    void this.offerStashPop(this.lastRepoRoot);
                }
                break;
            }
            case 'conflict': {
                await this.setContextState('paused');
                this.statusBar.showPaused(result.index, result.total);
                if (session && vscode.workspace.getConfiguration('gitCherryPick').get<boolean>('openConflictedFiles', true)) {
                    await this.openFiles(session.repoRoot, result.files);
                }
                const short = result.commit.slice(0, 7);
                void vscode.window
                    .showWarningMessage(
                        `Conflict cherry-picking ${short} (${result.index}/${result.total}): ${result.files.length} file(s). Resolve, then Continue.`,
                        'Continue',
                        'Skip',
                        'Abort'
                    )
                    .then((choice) => this.dispatchAction(choice));
                break;
            }
            case 'unresolved': {
                await this.setContextState('paused');
                this.statusBar.showPaused(i, n);
                if (session) {
                    await this.openFiles(session.repoRoot, result.files);
                }
                void vscode.window.showWarningMessage(
                    `Still unresolved conflict markers in: ${result.files.join(', ')}. Resolve them, then Continue.`
                );
                break;
            }
            case 'error': {
                await this.setContextState('paused');
                this.statusBar.showPaused(i, n);
                void vscode.window
                    .showErrorMessage(
                        `Cherry-pick failed on ${result.commit.slice(0, 7)}: ${result.message}`,
                        'Skip',
                        'Abort'
                    )
                    .then((choice) => this.dispatchAction(choice));
                break;
            }
        }
        this.tree.refresh();
    }

    private async openFiles(repoRoot: string, files: string[]): Promise<void> {
        for (const f of files) {
            try {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(repoRoot, f)), {
                    preview: false,
                });
            } catch {
                // e.g. modify/delete conflict where the file no longer exists
            }
        }
    }

    private rememberSession(): void {
        const session = this.store.get();
        if (session) {
            this.lastTarget = session.targetBranch;
            this.lastRepoRoot = session.repoRoot;
        }
    }

    private async offerStashPop(repoRoot: string): Promise<void> {
        const choice = await vscode.window.showInformationMessage(
            'Changes were stashed before cherry-picking. Pop the stash now?',
            'Pop Stash'
        );
        if (choice === 'Pop Stash') {
            try {
                await new GitService(repoRoot).stashPop();
            } catch (err) {
                void vscode.window.showErrorMessage(String(err));
            }
        }
    }
}
