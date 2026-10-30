import * as vscode from 'vscode';
import { CherryPickManager } from './engine/cherryPickManager';
import { CherryPickMode } from './engine/types';
import { WorkspaceSessionStore } from './engine/sessionStore';
import { GitService } from './git/gitService';
import { VscodeGitProvider } from './git/vscodeGitProvider';
import { pickBranch, pickCommits, pickRepository } from './ui/quickPickHelper';
import { CherryPickStatusBar } from './ui/statusBar';
import { CommitTreeDataProvider } from './views/commitTreeDataProvider';
import { CommitTreeItem } from './views/commitTreeItem';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const gitProvider = new VscodeGitProvider();
    gitProvider.activate(context);

    const store = new WorkspaceSessionStore(context);
    const statusBar = new CherryPickStatusBar(context);
    const tree = new CommitTreeDataProvider();
    const treeView = tree.createView(context);
    const manager = new CherryPickManager(store, statusBar, tree);

    const chooseDefaultRepo = () => {
        const roots = gitProvider.getRepoRoots();
        if (roots.length === 0) {
            tree.setRepoRoot(undefined);
            return;
        }
        const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
        const match = activePath ? roots.find((r) => activePath.startsWith(r)) : undefined;
        tree.setRepoRoot(match ?? roots[0]);
    };
    chooseDefaultRepo();

    context.subscriptions.push(
        gitProvider.onDidChangeRepos(() => {
            const roots = gitProvider.getRepoRoots();
            const current = tree.activeRepoRoot;
            if (!current || !roots.includes(current)) {
                chooseDefaultRepo();
            }
            tree.debouncedRefresh();
        }),
        gitProvider.onDidChangeRepoState((root) => {
            if (root === tree.activeRepoRoot) {
                tree.debouncedRefresh();
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(() => {
            if (!tree.activeRepoRoot) {
                chooseDefaultRepo();
            }
        })
    );

    const reg = (cmd: string, fn: (...args: never[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(cmd, fn));

    const runOnSelection = (mode: CherryPickMode) => (item?: CommitTreeItem, selected?: CommitTreeItem[]) => {
        const items = selected && selected.length > 0 ? selected : item ? [item] : [...tree.selection];
        const commits = items.map((i) => i.commit);
        const repoRoot = tree.activeRepoRoot;
        if (!repoRoot || commits.length === 0) {
            void vscode.window.showErrorMessage(`Select commit(s) to ${mode === 'squash' ? 'squash' : 'cherry-pick'} first.`);
            return;
        }
        return manager.cherryPickCommits(repoRoot, commits, mode);
    };
    reg('gitCherryPick.cherryPickSelected', runOnSelection('pick'));
    reg('gitCherryPick.squashSelected', runOnSelection('squash'));

    reg('gitCherryPick.pickCommits', async () => {
        const repoRoot = tree.activeRepoRoot;
        if (!repoRoot) {
            void vscode.window.showErrorMessage('No git repository available.');
            return;
        }
        const git = new GitService(repoRoot);
        const branch = await pickBranch(git, 'Pick commits from branch...');
        if (!branch) {
            return;
        }
        const commits = await pickCommits(git, branch.name);
        if (!commits) {
            return;
        }
        return manager.cherryPickCommits(repoRoot, commits);
    });

    reg('gitCherryPick.refresh', () => tree.refresh());

    reg('gitCherryPick.switchBranch', async () => {
        const repoRoot = tree.activeRepoRoot;
        if (!repoRoot) {
            return;
        }
        const branch = await pickBranch(new GitService(repoRoot), 'View commits of branch...');
        if (branch) {
            tree.setRef(branch.current ? undefined : branch.name);
        }
    });

    reg('gitCherryPick.switchRepository', async () => {
        const root = await pickRepository(gitProvider.getRepoRoots());
        if (root) {
            tree.setRepoRoot(root);
        }
    });

    reg('gitCherryPick.copyHash', (item?: CommitTreeItem) => {
        const target = item ?? tree.selection[0];
        if (target) {
            return vscode.env.clipboard.writeText(target.commit.hash);
        }
        return undefined;
    });

    reg('gitCherryPick.continue', () => manager.continue());
    reg('gitCherryPick.skip', () => manager.skip());
    reg('gitCherryPick.abort', () => manager.abort());
    reg('gitCherryPick.showActions', () => manager.showActions());

    void treeView; // created for side effects (registration + selection tracking)

    void manager.restoreSession();
}

export function deactivate(): void {
    // nothing to clean up
}
