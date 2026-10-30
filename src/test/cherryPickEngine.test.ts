import * as assert from 'assert';
import { CherryPickEngine } from '../engine/cherryPickEngine';
import { orderOldestFirst } from '../engine/types';
import { GitService } from '../git/gitService';
import {
    MemorySessionStore,
    cleanupTempDirs,
    commitFile,
    git,
    head,
    initRepo,
    writeFile,
} from './helpers';

async function logSubjects(repo: string): Promise<string[]> {
    const out = await git(repo, 'log', '--format=%s');
    return out.trim().split('\n');
}

describe('CherryPickEngine', () => {
    afterEach(async () => {
        await cleanupTempDirs();
    });

    it('applies 3 clean commits oldest-first, session cleared', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'base.txt', 'base', 'base');
        await git(repo, 'checkout', '-b', 'source');
        const h1 = await commitFile(repo, '1.txt', '1', 'first');
        const h2 = await commitFile(repo, '2.txt', '2', 'second');
        const h3 = await commitFile(repo, '3.txt', '3', 'third');
        await git(repo, 'checkout', 'main');

        const svc = new GitService(repo);
        const store = new MemorySessionStore();
        const engine = new CherryPickEngine(svc, store);
        const res = await engine.start({
            targetBranch: 'main',
            commits: [h1, h2, h3],
            appendX: false,
            stashed: false,
        });
        assert.strictEqual(res.kind, 'completed');
        if (res.kind === 'completed') {
            assert.deepStrictEqual(res.applied, [h1, h2, h3]);
            assert.deepStrictEqual(res.skipped, []);
        }
        assert.strictEqual(store.get(), undefined);
        const subjects = await logSubjects(repo);
        assert.deepStrictEqual(subjects.slice(0, 3), ['third', 'second', 'first']);
    });

    it('conflict pauses; unresolved blocks continue; resolve -> completed', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'c.txt', 'base\n', 'base');
        await git(repo, 'checkout', '-b', 'source');
        const conflict = await commitFile(repo, 'c.txt', 'source\n', 'conflicting');
        const clean = await commitFile(repo, 'ok.txt', 'ok\n', 'clean after');
        await git(repo, 'checkout', 'main');
        await commitFile(repo, 'c.txt', 'main\n', 'main change');

        const svc = new GitService(repo);
        const store = new MemorySessionStore();
        const engine = new CherryPickEngine(svc, store);

        const r1 = await engine.start({
            targetBranch: 'main',
            commits: [conflict, clean],
            appendX: false,
            stashed: false,
        });
        assert.strictEqual(r1.kind, 'conflict');
        if (r1.kind === 'conflict') {
            assert.deepStrictEqual(r1.files, ['c.txt']);
            assert.strictEqual(r1.index, 1);
            assert.strictEqual(r1.total, 2);
        }
        const persisted = store.get();
        assert.ok(persisted, 'session should be persisted on conflict');
        assert.strictEqual(persisted!.state, 'paused_conflict');
        assert.strictEqual(persisted!.currentIndex, 0);

        // Markers still present -> unresolved
        const r2 = await engine.continue();
        assert.strictEqual(r2.kind, 'unresolved');
        if (r2.kind === 'unresolved') {
            assert.deepStrictEqual(r2.files, ['c.txt']);
        }

        // Resolve in working tree without staging
        await writeFile(repo, 'c.txt', 'resolved\n');
        const r3 = await engine.continue();
        assert.strictEqual(r3.kind, 'completed');
        if (r3.kind === 'completed') {
            assert.deepStrictEqual(r3.applied, [conflict, clean]);
        }
        assert.strictEqual(store.get(), undefined);
        const subjects = await logSubjects(repo);
        assert.strictEqual(subjects[0], 'clean after');
        assert.strictEqual(subjects[1], 'conflicting');
    });

    it('skip on conflict advances the queue', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'c.txt', 'base\n', 'base');
        await git(repo, 'checkout', '-b', 'source');
        const conflict = await commitFile(repo, 'c.txt', 'source\n', 'conflicting');
        const clean = await commitFile(repo, 'ok.txt', 'ok\n', 'clean after');
        await git(repo, 'checkout', 'main');
        await commitFile(repo, 'c.txt', 'main\n', 'main change');

        const svc = new GitService(repo);
        const engine = new CherryPickEngine(svc, new MemorySessionStore());
        const r1 = await engine.start({
            targetBranch: 'main',
            commits: [conflict, clean],
            appendX: false,
            stashed: false,
        });
        assert.strictEqual(r1.kind, 'conflict');
        const r2 = await engine.skip();
        assert.strictEqual(r2.kind, 'completed');
        if (r2.kind === 'completed') {
            assert.deepStrictEqual(r2.applied, [clean]);
            assert.deepStrictEqual(r2.skipped, [conflict]);
        }
        const subjects = await logSubjects(repo);
        assert.strictEqual(subjects[0], 'clean after');
        assert.ok(!subjects.includes('conflicting'));
    });

    it('abort restores pre-abort HEAD and clears store', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'c.txt', 'base\n', 'base');
        await git(repo, 'checkout', '-b', 'source');
        const conflict = await commitFile(repo, 'c.txt', 'source\n', 'conflicting');
        await git(repo, 'checkout', 'main');
        await commitFile(repo, 'c.txt', 'main\n', 'main change');
        const preAbort = await head(repo);

        const svc = new GitService(repo);
        const store = new MemorySessionStore();
        const engine = new CherryPickEngine(svc, store);
        const r1 = await engine.start({
            targetBranch: 'main',
            commits: [conflict],
            appendX: false,
            stashed: false,
        });
        assert.strictEqual(r1.kind, 'conflict');
        const r2 = await engine.abort();
        assert.strictEqual(r2.stashed, false);
        assert.strictEqual(await head(repo), preAbort);
        assert.strictEqual(store.get(), undefined);
    });

    it('commit whose change is already on target is skipped as empty', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'base.txt', 'base', 'base');
        await git(repo, 'checkout', '-b', 'source');
        const dup = await commitFile(repo, 'dup.txt', 'same content\n', 'dup');
        await git(repo, 'checkout', 'main');
        // Apply the identical change on main with a different commit
        await commitFile(repo, 'dup.txt', 'same content\n', 'dup applied differently');

        const svc = new GitService(repo);
        const engine = new CherryPickEngine(svc, new MemorySessionStore());
        const res = await engine.start({
            targetBranch: 'main',
            commits: [dup],
            appendX: false,
            stashed: false,
        });
        assert.strictEqual(res.kind, 'completed');
        if (res.kind === 'completed') {
            assert.deepStrictEqual(res.applied, []);
            assert.deepStrictEqual(res.skipped, [dup]);
        }
        const subjects = await logSubjects(repo);
        assert.ok(!subjects.includes('dup'));
    });

    it('continue after user committed manually advances', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'c.txt', 'base\n', 'base');
        await git(repo, 'checkout', '-b', 'source');
        const conflict = await commitFile(repo, 'c.txt', 'source\n', 'conflicting');
        const clean = await commitFile(repo, 'ok.txt', 'ok\n', 'clean after');
        await git(repo, 'checkout', 'main');
        await commitFile(repo, 'c.txt', 'main\n', 'main change');

        const svc = new GitService(repo);
        const engine = new CherryPickEngine(svc, new MemorySessionStore());
        const r1 = await engine.start({
            targetBranch: 'main',
            commits: [conflict, clean],
            appendX: false,
            stashed: false,
        });
        assert.strictEqual(r1.kind, 'conflict');

        // User resolves and commits manually via SCM/terminal
        await writeFile(repo, 'c.txt', 'resolved\n');
        await git(repo, 'add', '--', 'c.txt');
        await git(repo, 'commit', '-m', 'conflicting');
        assert.strictEqual(await svc.getOperationInProgress(), undefined);

        const r2 = await engine.continue();
        assert.strictEqual(r2.kind, 'completed');
        if (r2.kind === 'completed') {
            assert.deepStrictEqual(r2.applied, [conflict, clean]);
        }
        const subjects = await logSubjects(repo);
        assert.strictEqual(subjects[0], 'clean after');
        assert.strictEqual(subjects[1], 'conflicting');
    });

    describe('squash mode', () => {
        const MSG = 'Squash subject\n\nSquashed commits:\n- a\n- b\n';

        it('squashes clean commits into one commit with the given message', async () => {
            const repo = await initRepo();
            await commitFile(repo, 'base.txt', 'base', 'base');
            await git(repo, 'checkout', '-b', 'source');
            const h1 = await commitFile(repo, '1.txt', '1', 'first');
            const h2 = await commitFile(repo, '2.txt', '2', 'second');
            await git(repo, 'checkout', 'main');
            const origHead = await head(repo);

            const store = new MemorySessionStore();
            const engine = new CherryPickEngine(new GitService(repo), store);
            const res = await engine.start({
                targetBranch: 'main',
                commits: [h1, h2],
                appendX: false,
                stashed: false,
                mode: 'squash',
                squashMessage: MSG,
            });
            assert.strictEqual(res.kind, 'completed');
            if (res.kind === 'completed') {
                assert.strictEqual(res.mode, 'squash');
                assert.deepStrictEqual(res.applied, [h1, h2]);
                assert.strictEqual(res.squashedInto, await head(repo));
            }
            assert.deepStrictEqual(await logSubjects(repo), ['Squash subject', 'base']);
            assert.strictEqual((await git(repo, 'rev-parse', 'HEAD~1')).trim(), origHead);
            assert.strictEqual((await git(repo, 'log', '-1', '--format=%B')).trim(), MSG.trim());
            const files = (await git(repo, 'show', '--name-only', '--format=', 'HEAD')).trim().split('\n').sort();
            assert.deepStrictEqual(files, ['1.txt', '2.txt']);
            assert.strictEqual(store.get(), undefined);
        });

        it('conflict -> resolve -> continue still ends in a single squash commit', async () => {
            const repo = await initRepo();
            await commitFile(repo, 'c.txt', 'base\n', 'base');
            await git(repo, 'checkout', '-b', 'source');
            const conflict = await commitFile(repo, 'c.txt', 'source\n', 'conflicting');
            const clean = await commitFile(repo, 'ok.txt', 'ok\n', 'clean after');
            await git(repo, 'checkout', 'main');
            await commitFile(repo, 'c.txt', 'main\n', 'main change');

            const store = new MemorySessionStore();
            const engine = new CherryPickEngine(new GitService(repo), store);
            const r1 = await engine.start({
                targetBranch: 'main',
                commits: [conflict, clean],
                appendX: false,
                stashed: false,
                mode: 'squash',
                squashMessage: MSG,
            });
            assert.strictEqual(r1.kind, 'conflict');
            assert.strictEqual(store.get()!.mode, 'squash');
            assert.ok(store.get()!.origHead, 'origHead persisted for reload recovery');

            await writeFile(repo, 'c.txt', 'resolved\n');
            const r2 = await engine.continue();
            assert.strictEqual(r2.kind, 'completed');
            if (r2.kind === 'completed') {
                assert.ok(r2.squashedInto);
            }
            assert.deepStrictEqual(await logSubjects(repo), ['Squash subject', 'main change', 'base']);
            assert.strictEqual((await git(repo, 'show', 'HEAD:c.txt')).trim(), 'resolved');
            assert.strictEqual((await git(repo, 'show', 'HEAD:ok.txt')).trim(), 'ok');
        });

        it('skip excludes the conflicting commit from the squash', async () => {
            const repo = await initRepo();
            await commitFile(repo, 'c.txt', 'base\n', 'base');
            await git(repo, 'checkout', '-b', 'source');
            const conflict = await commitFile(repo, 'c.txt', 'source\n', 'conflicting');
            const clean = await commitFile(repo, 'ok.txt', 'ok\n', 'clean after');
            await git(repo, 'checkout', 'main');
            await commitFile(repo, 'c.txt', 'main\n', 'main change');

            const engine = new CherryPickEngine(new GitService(repo), new MemorySessionStore());
            await engine.start({
                targetBranch: 'main',
                commits: [conflict, clean],
                appendX: false,
                stashed: false,
                mode: 'squash',
                squashMessage: MSG,
            });
            const r2 = await engine.skip();
            assert.strictEqual(r2.kind, 'completed');
            if (r2.kind === 'completed') {
                assert.deepStrictEqual(r2.skipped, [conflict]);
                assert.ok(r2.squashedInto);
            }
            assert.deepStrictEqual(await logSubjects(repo), ['Squash subject', 'main change', 'base']);
            assert.strictEqual((await git(repo, 'show', 'HEAD:c.txt')).trim(), 'main');
        });

        it('abort resets the branch to where the squash started (all-or-nothing)', async () => {
            const repo = await initRepo();
            await commitFile(repo, 'c.txt', 'base\n', 'base');
            await git(repo, 'checkout', '-b', 'source');
            const clean = await commitFile(repo, 'ok.txt', 'ok\n', 'clean first');
            const conflict = await commitFile(repo, 'c.txt', 'source\n', 'conflicting');
            await git(repo, 'checkout', 'main');
            await commitFile(repo, 'c.txt', 'main\n', 'main change');
            const origHead = await head(repo);

            const store = new MemorySessionStore();
            const engine = new CherryPickEngine(new GitService(repo), store);
            const r1 = await engine.start({
                targetBranch: 'main',
                commits: [clean, conflict],
                appendX: false,
                stashed: false,
                mode: 'squash',
                squashMessage: MSG,
            });
            assert.strictEqual(r1.kind, 'conflict');
            assert.notStrictEqual(await head(repo), origHead, 'first commit was applied before the conflict');

            await engine.abort();
            assert.strictEqual(await head(repo), origHead);
            assert.strictEqual((await git(repo, 'status', '--porcelain')).trim(), '');
            assert.strictEqual(store.get(), undefined);
        });

        it('creates no commit when every change is already on the target', async () => {
            const repo = await initRepo();
            await commitFile(repo, 'base.txt', 'base', 'base');
            await git(repo, 'checkout', '-b', 'source');
            const dup = await commitFile(repo, 'dup.txt', 'same\n', 'dup');
            await git(repo, 'checkout', 'main');
            await commitFile(repo, 'dup.txt', 'same\n', 'dup applied differently');
            const origHead = await head(repo);

            const engine = new CherryPickEngine(new GitService(repo), new MemorySessionStore());
            const res = await engine.start({
                targetBranch: 'main',
                commits: [dup],
                appendX: false,
                stashed: false,
                mode: 'squash',
                squashMessage: MSG,
            });
            assert.strictEqual(res.kind, 'completed');
            if (res.kind === 'completed') {
                assert.strictEqual(res.squashedInto, undefined);
                assert.deepStrictEqual(res.skipped, [dup]);
            }
            assert.strictEqual(await head(repo), origHead);
        });
    });

    it('orderOldestFirst sorts by index descending', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'a.txt', 'a', 'one');
        await commitFile(repo, 'b.txt', 'b', 'two');
        await commitFile(repo, 'c.txt', 'c', 'three');
        const svc = new GitService(repo);
        const commits = await svc.getCommits('main');
        // newest first: [three(0), two(1), one(2)]
        const ordered = orderOldestFirst([commits[0], commits[1], commits[2]]);
        assert.deepStrictEqual(
            ordered.map((c) => c.subject),
            ['one', 'two', 'three']
        );
    });
});
