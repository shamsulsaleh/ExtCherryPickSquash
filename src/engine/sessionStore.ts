import * as vscode from 'vscode';
import { CherryPickSession, SessionStore } from './types';

const KEY = 'gitCherryPick.session';

export class WorkspaceSessionStore implements SessionStore {
    constructor(private readonly context: vscode.ExtensionContext) {}

    get(): CherryPickSession | undefined {
        return this.context.workspaceState.get<CherryPickSession>(KEY);
    }

    set(s: CherryPickSession | undefined): Thenable<void> {
        return this.context.workspaceState.update(KEY, s);
    }
}
