import { GitCommit } from '../git/gitService';

export interface CherryPickSession {
    repoRoot: string;
    targetBranch: string;
    /** hashes, oldest first */
    queue: string[];
    currentIndex: number;
    state: 'running' | 'paused_conflict';
    mainline?: number;
    appendX: boolean;
    stashed: boolean;
    applied: string[];
    skipped: string[];
    /** 'squash' = apply like 'pick', then soft-reset to origHead and commit once. Missing = 'pick'. */
    mode?: CherryPickMode;
    origHead?: string;
    squashMessage?: string;
}

export type CherryPickMode = 'pick' | 'squash';

export interface SessionStore {
    get(): CherryPickSession | undefined;
    set(s: CherryPickSession | undefined): Promise<void> | Thenable<void>;
}

export type StepResult =
    | {
          kind: 'completed';
          applied: string[];
          skipped: string[];
          stashed: boolean;
          mode: CherryPickMode;
          /** squash mode: hash of the single squash commit; undefined when nothing was squashed */
          squashedInto?: string;
      }
    | { kind: 'conflict'; commit: string; files: string[]; index: number; total: number }
    | { kind: 'unresolved'; files: string[] }
    | { kind: 'error'; commit: string; message: string };

export function orderOldestFirst(commits: GitCommit[]): GitCommit[] {
    return [...commits].sort((a, b) => b.index - a.index);
}
