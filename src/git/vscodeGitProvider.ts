import * as vscode from 'vscode';

// Minimal local declarations for the built-in git extension API.
export interface GitExtensionAPI {
    repositories: Repository[];
    onDidOpenRepository: vscode.Event<Repository>;
    onDidCloseRepository: vscode.Event<Repository>;
}

export interface Repository {
    rootUri: vscode.Uri;
    state: {
        onDidChange: vscode.Event<void>;
    };
}

interface GitExtensionExports {
    getAPI(version: 1): GitExtensionAPI;
}

export class VscodeGitProvider {
    private api: GitExtensionAPI | undefined;
    private readonly repoDisposables = new Map<string, vscode.Disposable>();

    private readonly _onDidChangeRepos = new vscode.EventEmitter<void>();
    readonly onDidChangeRepos = this._onDidChangeRepos.event;

    private readonly _onDidChangeRepoState = new vscode.EventEmitter<string>();
    readonly onDidChangeRepoState = this._onDidChangeRepoState.event;

    activate(context: vscode.ExtensionContext): void {
        const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
        if (!ext) {
            return;
        }
        const wire = (exports: GitExtensionExports | undefined) => {
            if (!exports) {
                return;
            }
            this.api = exports.getAPI(1);
            for (const repo of this.api.repositories) {
                this.watchRepo(repo);
            }
            context.subscriptions.push(
                this.api.onDidOpenRepository((repo) => {
                    this.watchRepo(repo);
                    this._onDidChangeRepos.fire();
                }),
                this.api.onDidCloseRepository((repo) => {
                    const key = repo.rootUri.fsPath;
                    this.repoDisposables.get(key)?.dispose();
                    this.repoDisposables.delete(key);
                    this._onDidChangeRepos.fire();
                })
            );
            this._onDidChangeRepos.fire();
        };
        if (ext.isActive) {
            wire(ext.exports);
        } else {
            void ext.activate().then(() => wire(ext.exports));
        }
    }

    private watchRepo(repo: Repository): void {
        const key = repo.rootUri.fsPath;
        if (this.repoDisposables.has(key)) {
            return;
        }
        this.repoDisposables.set(
            key,
            repo.state.onDidChange(() => this._onDidChangeRepoState.fire(key))
        );
    }

    getRepoRoots(): string[] {
        return (this.api?.repositories ?? []).map((r) => r.rootUri.fsPath);
    }
}
