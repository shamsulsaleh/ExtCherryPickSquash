import * as vscode from 'vscode';
import { GitCommit } from '../git/gitService';

export class CommitTreeItem extends vscode.TreeItem {
    constructor(readonly commit: GitCommit) {
        super(commit.subject || '(no message)', vscode.TreeItemCollapsibleState.None);
        this.id = commit.hash;
        this.description = `${commit.shortHash} · ${commit.author} · ${commit.relativeDate}`;

        const tip = new vscode.MarkdownString();
        tip.appendMarkdown(`**${commit.subject}**\n\n`);
        tip.appendMarkdown(`- Commit: \`${commit.hash}\`\n`);
        tip.appendMarkdown(`- Author: ${commit.author}\n`);
        tip.appendMarkdown(`- Date: ${commit.isoDate}\n`);
        tip.appendMarkdown(`- Parents: ${commit.parents.length ? commit.parents.map((p) => `\`${p.slice(0, 7)}\``).join(', ') : '(root)'}`);
        this.tooltip = tip;

        this.iconPath = new vscode.ThemeIcon(commit.parents.length > 1 ? 'git-merge' : 'git-commit');
        this.contextValue = 'commit';
    }
}
