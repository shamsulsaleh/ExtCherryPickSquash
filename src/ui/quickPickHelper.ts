import * as vscode from 'vscode';
import { GitBranch, GitCommit, GitService } from '../git/gitService';

interface BranchPickItem extends vscode.QuickPickItem {
    branch?: GitBranch;
    create?: 'fromCurrent' | 'fromOther';
}

export type CherryPickTarget =
    | { kind: 'existing'; branch: GitBranch }
    | { kind: 'new'; name: string; base: string };

export async function pickBranch(git: GitService, title: string): Promise<GitBranch | undefined> {
    const picked = await vscode.window.showQuickPick(branchItems(await git.getBranches()), {
        title,
        placeHolder: 'Choose a branch',
    });
    return picked?.branch;
}

export async function pickTarget(git: GitService, title: string): Promise<CherryPickTarget | undefined> {
    const branches = await git.getBranches();
    const current = await git.getCurrentBranch();
    const items: BranchPickItem[] = [
        { label: 'New branch', kind: vscode.QuickPickItemKind.Separator },
        {
            label: '$(add) Create new branch from current branch',
            description: current ?? 'detached HEAD',
            create: 'fromCurrent',
        },
        { label: '$(add) Create new branch from...', description: 'choose a local or remote branch', create: 'fromOther' },
        ...branchItems(branches),
    ];
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Choose a destination branch' });
    if (!picked) {
        return undefined;
    }
    if (picked.branch) {
        return { kind: 'existing', branch: picked.branch };
    }
    let base = current ?? 'HEAD';
    if (picked.create === 'fromOther') {
        const baseBranch = await pickBranch(git, 'Create new branch from...');
        if (!baseBranch) {
            return undefined;
        }
        base = baseBranch.name;
    }
    const localNames = new Set(branches.filter((b) => !b.isRemote).map((b) => b.name));
    const name = await vscode.window.showInputBox({
        title: `New branch from ${base}`,
        prompt: 'Name of the new branch to cherry-pick into',
        placeHolder: 'e.g. hotfix/my-fix',
        validateInput: async (value) => {
            const v = value.trim();
            if (!v) {
                return 'Branch name is required.';
            }
            if (localNames.has(v)) {
                return `Branch '${v}' already exists.`;
            }
            return (await git.isValidBranchName(v)) ? undefined : `'${v}' is not a valid branch name.`;
        },
    });
    return name ? { kind: 'new', name: name.trim(), base } : undefined;
}

function branchItems(branches: GitBranch[]): BranchPickItem[] {
    const local = branches.filter((b) => !b.isRemote);
    const remote = branches.filter((b) => b.isRemote);

    const items: BranchPickItem[] = [];
    items.push({ label: 'Local', kind: vscode.QuickPickItemKind.Separator });
    for (const b of local) {
        items.push({
            label: `${b.current ? '$(check) ' : '$(git-branch) '}${b.name}`,
            description: b.current ? 'current' : undefined,
            branch: b,
        });
    }
    items.push({ label: 'Remote', kind: vscode.QuickPickItemKind.Separator });
    for (const b of remote) {
        items.push({ label: `$(cloud) ${b.name}`, branch: b });
    }
    return items;
}

interface CommitPickItem extends vscode.QuickPickItem {
    commit?: GitCommit;
}

export async function pickCommits(git: GitService, ref: string): Promise<GitCommit[] | undefined> {
    const maxCommits = vscode.workspace.getConfiguration('gitCherryPick').get<number>('maxCommits', 200);
    const commits = await git.getCommits(ref, maxCommits);
    const items: CommitPickItem[] = commits.map((c) => ({
        label: c.subject || '(no message)',
        description: `${c.shortHash} · ${c.author} · ${c.relativeDate}`,
        commit: c,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: `Pick commits from ${ref}`,
        canPickMany: true,
        matchOnDescription: true,
        placeHolder: 'Select one or more commits',
    });
    return picked && picked.length > 0 ? picked.map((p) => p.commit!) : undefined;
}

export async function pickRepository(roots: string[]): Promise<string | undefined> {
    if (roots.length === 0) {
        return undefined;
    }
    if (roots.length === 1) {
        return roots[0];
    }
    interface RepoItem extends vscode.QuickPickItem {
        root?: string;
    }
    const items: RepoItem[] = roots.map((r) => ({
        label: `$(repo) ${r.split(/[\\/]/).pop() ?? r}`,
        description: r,
        root: r,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Choose a repository',
        matchOnDescription: true,
    });
    return picked?.root;
}
