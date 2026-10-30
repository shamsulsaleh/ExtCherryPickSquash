import { execFile } from 'child_process';

export interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}

export function runGit(
    cwd: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv }
): Promise<GitResult> {
    return new Promise((resolve) => {
        execFile(
            'git',
            args,
            {
                cwd,
                env: { ...process.env, ...opts?.env },
                maxBuffer: 50 * 1024 * 1024,
                windowsHide: true,
            },
            (error, stdout, stderr) => {
                if (error && typeof (error as NodeJS.ErrnoException & { code?: number }).code !== 'number') {
                    // Spawn failure (e.g. git not found) — treat as error result rather than throwing.
                    resolve({ code: -1, stdout: stdout ?? '', stderr: stderr || String(error) });
                    return;
                }
                const code = error ? (error as { code?: number }).code ?? 1 : 0;
                resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
            }
        );
    });
}
