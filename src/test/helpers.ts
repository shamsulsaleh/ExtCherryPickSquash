import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGit } from '../git/gitRunner';
import { SessionStore, CherryPickSession } from '../engine/types';

const createdDirs: string[] = [];

export async function makeTempDir(prefix = 'gcp-test-'): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
    createdDirs.push(dir);
    return dir;
}

export async function cleanupTempDirs(): Promise<void> {
    for (const dir of createdDirs.splice(0)) {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
    const res = await runGit(cwd, args, { env: { GIT_EDITOR: 'true' } });
    if (res.code !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${res.code}): ${res.stderr}`);
    }
    return res.stdout;
}

/** Create a repo with local (never global) user config and branch `main`. */
export async function initRepo(prefix?: string): Promise<string> {
    const dir = await makeTempDir(prefix);
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.name', 'Test User');
    await git(dir, 'config', 'user.email', 'test@example.com');
    await git(dir, 'config', 'commit.gpgsign', 'false');
    return dir;
}

export async function commitFile(
    repo: string,
    relPath: string,
    content: string,
    message: string
): Promise<string> {
    const abs = path.join(repo, relPath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
    await git(repo, 'add', '--', relPath);
    await git(repo, 'commit', '-m', message);
    return (await git(repo, 'rev-parse', 'HEAD')).trim();
}

export async function writeFile(repo: string, relPath: string, content: string): Promise<void> {
    const abs = path.join(repo, relPath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
}

export async function head(repo: string): Promise<string> {
    return (await git(repo, 'rev-parse', 'HEAD')).trim();
}

/** Create a bare remote, wire it as `origin`, push all branches, fetch. */
export async function addOrigin(repo: string): Promise<string> {
    const bare = await makeTempDir('gcp-remote-');
    await git(bare, 'init', '--bare', '-b', 'main');
    await git(repo, 'remote', 'add', 'origin', bare);
    await git(repo, 'push', '-u', 'origin', '--all');
    await git(repo, 'fetch', 'origin');
    return bare;
}

export class MemorySessionStore implements SessionStore {
    private session: CherryPickSession | undefined;

    get(): CherryPickSession | undefined {
        return this.session;
    }

    async set(s: CherryPickSession | undefined): Promise<void> {
        this.session = s;
    }
}
