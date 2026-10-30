import * as vscode from 'vscode';

export class CherryPickStatusBar {
    private readonly item: vscode.StatusBarItem;

    constructor(context: vscode.ExtensionContext) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.item.command = 'gitCherryPick.showActions';
        context.subscriptions.push(this.item);
    }

    showRunning(index: number, total: number): void {
        this.item.text = `$(sync~spin) Cherry-pick ${index}/${total}`;
        this.item.backgroundColor = undefined;
        this.item.tooltip = 'Cherry-pick in progress';
        this.item.show();
    }

    showPaused(index: number, total: number): void {
        this.item.text = `$(warning) Cherry-pick conflict ${index}/${total}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.tooltip = 'Cherry-pick paused on conflict — click for actions';
        this.item.show();
    }

    hide(): void {
        this.item.hide();
    }
}
