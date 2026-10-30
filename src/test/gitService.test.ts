import * as assert from 'assert';
import { GitService } from '../git/gitService';
import {
    addOrigin,
    cleanupTempDirs,
    commitFile,
    git,
    initRepo,
    writeFile,
} from './helpers';

describe('GitService', () => {
    afterEach(async () => {
        await cleanupTempDirs();
    });

    it('getBranches returns local + remote, excludes origin/HEAD', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'a.txt', 'a', 'initial');
        await addOrigin(repo);
        const svc = new GitService(repo);

        const branches = await svc.getBranches();
        const names = branches.map((b) => b.name);
        assert.ok(names.includes('main'), `expected local main in ${names}`);
        assert.ok(names.includes('origin/main'), `expected remote origin/main in ${names}`);
        assert.ok(!names.includes('origin/HEAD'), 'origin/HEAD should be excluded');
        const main = branches.find((b) => b.name === 'main')!;
        assert.strictEqual(main.isRemote, false);
        assert.strictEqual(main.current, true);
        assert.strictEqual(branches.find((b) => b.name === 'origin/main')!.isRemote, true);
    });

    it('getCommits parses fields and detects merge parents', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'base.txt', 'base', 'base');
        await git(repo, 'checkout', '-b', 'feature');
        await commitFile(repo, 'f.txt', 'f', 'feat');
        await git(repo, 'checkout', 'main');
        await commitFile(repo, 'm.txt', 'm', 'main work');
        await git(repo, 'merge', '--no-ff', '-m', 'merge feature', 'feature');

        const svc = new GitService(repo);
        const commits = await svc.getCommits('main');
        assert.strictEqual(commits.length, 4);
        assert.strictEqual(commits[0].subject, 'merge feature');
        assert.strictEqual(commits[0].index, 0);
        assert.strictEqual(commits[0].parents.length, 2, 'merge commit should have 2 parents');
        assert.ok(commits[0].hash.length === 40);
        assert.ok(commits[0].shortHash.length >= 7);
        assert.ok(commits[0].author.length > 0);
        assert.ok(commits[0].relativeDate.length > 0);
        assert.ok(/\d{4}-\d{2}-\d{2}T/.test(commits[0].isoDate));
        const leaf = commits.find((c) => c.subject === 'feat')!;
        assert.strictEqual(leaf.parents.length, 1);
        const base = commits.find((c) => c.subject === 'base')!;
        assert.strictEqual(base.parents.length, 0);
    });

    it('isWorkingTreeClean true then false', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'a.txt', 'a', 'initial');
        const svc = new GitService(repo);
        assert.strictEqual(await svc.isWorkingTreeClean(), true);
        await writeFile(repo, 'dirty.txt', 'dirty');
        assert.strictEqual(await svc.isWorkingTreeClean(), false);
    });

    it('checkoutBranch on remote creates tracking local branch', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'a.txt', 'a', 'initial');
        await addOrigin(repo);
        // push a branch that only exists on the remote from this repo's perspective
        await git(repo, 'checkout', '-b', 'remoteonly');
        await commitFile(repo, 'r.txt', 'r', 'remote work');
        await git(repo, 'push', 'origin', 'remoteonly');
        await git(repo, 'checkout', 'main');
        await git(repo, 'branch', '-D', 'remoteonly');
        await git(repo, 'fetch', 'origin');

        const svc = new GitService(repo);
        const branches = await svc.getBranches();
        const remote = branches.find((b) => b.name === 'origin/remoteonly')!;
        const checkedOut = await svc.checkoutBranch(remote);
        assert.strictEqual(checkedOut, 'remoteonly');
        assert.strictEqual(await svc.getCurrentBranch(), 'remoteonly');
        // tracking branch exists locally now
        const after = await svc.getBranches();
        assert.ok(after.some((b) => !b.isRemote && b.name === 'remoteonly'));
    });

    it('isValidBranchName accepts good names and rejects bad ones', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'a.txt', 'a', 'initial');
        const svc = new GitService(repo);
        assert.strictEqual(await svc.isValidBranchName('hotfix/my-fix'), true);
        assert.strictEqual(await svc.isValidBranchName('bad name'), false);
        assert.strictEqual(await svc.isValidBranchName('bad..name'), false);
    });

    it('createBranch from current and from remote base, without upstream', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'a.txt', 'a', 'initial');
        await addOrigin(repo);
        await commitFile(repo, 'b.txt', 'b', 'local only');
        const svc = new GitService(repo);

        await svc.createBranch('from-current', 'main');
        assert.strictEqual(await svc.getCurrentBranch(), 'from-current');
        assert.strictEqual((await svc.getCommits())[0].subject, 'local only');

        await svc.createBranch('from-remote', 'origin/main');
        assert.strictEqual(await svc.getCurrentBranch(), 'from-remote');
        assert.strictEqual((await svc.getCommits())[0].subject, 'initial');
        const upstream = await git(repo, 'config', '--get', 'branch.from-remote.merge').catch(() => '');
        assert.strictEqual(String(upstream).trim(), '', 'new branch must not track origin/main');

        await assert.rejects(svc.createBranch('from-current', 'main'));
    });

    it('getOperationInProgress detects cherry-pick', async () => {
        const repo = await initRepo();
        await commitFile(repo, 'c.txt', 'one', 'one');
        await git(repo, 'checkout', '-b', 'source');
        const conflictHash = await commitFile(repo, 'c.txt', 'two', 'two');
        await git(repo, 'checkout', 'main');
        await commitFile(repo, 'c.txt', 'three', 'three');

        const svc = new GitService(repo);
        assert.strictEqual(await svc.getOperationInProgress(), undefined);
        const res = await svc.cherryPick(conflictHash, {});
        assert.strictEqual(res.status, 'conflict');
        assert.strictEqual(await svc.getOperationInProgress(), 'cherry-pick');
        await svc.abortCherryPick();
        assert.strictEqual(await svc.getOperationInProgress(), undefined);
    });
});
