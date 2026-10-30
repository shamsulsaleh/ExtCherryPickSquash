import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { CommitTreeItem } from './commitTreeItem';

export class CommitTreeDataProvider implements vscode.TreeDataProvider<CommitTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<CommitTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private treeView: vscode.TreeView<CommitTreeItem> | undefined;
    private repoRoot: string | undefined;
    private ref: string | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;

    createView(context: vscode.ExtensionContext): vscode.TreeView<CommitTreeItem> {
        this.treeView = vscode.window.createTreeView('gitCherryPick.commitsView', {
            treeDataProvider: this,
            canSelectMany: true,
            showCollapseAll: false,
        });
        context.subscriptions.push(this.treeView);
        return this.treeView;
    }

    get selection(): readonly CommitTreeItem[] {
        return this.treeView?.selection ?? [];
    }

    get activeRepoRoot(): string | undefined {
        return this.repoRoot;
    }

    get viewedRef(): string | undefined {
        return this.ref;
    }

    setRepoRoot(root: string | undefined): void {
        if (root !== this.repoRoot) {
            this.repoRoot = root;
            this.ref = undefined;
            this.refresh();
        }
    }

    /** undefined = follow the currently checked-out branch */
    setRef(ref: string | undefined): void {
        if (ref !== this.ref) {
            this.ref = ref;
            this.refresh();
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    debouncedRefresh(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => this.refresh(), 300);
    }

    getTreeItem(element: CommitTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: CommitTreeItem): Promise<CommitTreeItem[]> {
        if (element) {
            return [];
        }
        if (!this.repoRoot) {
            if (this.treeView) {
                this.treeView.message = 'No git repository found in this workspace.';
                this.treeView.description = undefined;
            }
            return [];
        }
        const git = new GitService(this.repoRoot);
        const ref = this.ref ?? (await git.getCurrentBranch());
        if (!ref) {
            if (this.treeView) {
                this.treeView.message = 'HEAD is detached; pick a branch to view commits.';
                this.treeView.description = path.basename(this.repoRoot);
            }
            return [];
        }
        const maxCommits = vscode.workspace.getConfiguration('gitCherryPick').get<number>('maxCommits', 200);
        const commits = await git.getCommits(ref, maxCommits);
        if (this.treeView) {
            this.treeView.message = commits.length === 0 ? `No commits on ${ref}.` : undefined;
            this.treeView.description = `${path.basename(this.repoRoot)} · ${ref}`;
        }
        return commits.map((c) => new CommitTreeItem(c));
    }
}
