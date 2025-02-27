import { git, IGitExecutionOptions } from '../core/git';
import { Branch, BranchType } from '../model/branch';
import { CommitIdentity } from '../model/commit-identity';

const delimiter = '1F';
const delimiterString = String.fromCharCode(parseInt(delimiter, 16));
const forEachRefFormat = [
    '%(refname)',
    '%(refname:short)',
    '%(upstream:short)',
    '%(objectname)', // SHA
    '%(author)',
    '%(parent)', // parent SHAs
    '%(subject)',
    '%(body)',
    `%${delimiter}`, // indicate end-of-line as %(body) may contain newlines
].join('%00');

export async function listBranch(repositoryPath: string, type: 'current', options?: IGitExecutionOptions): Promise<undefined | Branch>;
export async function listBranch(repositoryPath: string, type: 'local' | 'remote' | 'all', options?: IGitExecutionOptions): Promise<Branch[]>;
export async function listBranch(repositoryPath: string, type: 'current' | 'local' | 'remote' | 'all', options?: IGitExecutionOptions): Promise<undefined | Branch | Branch[]> {
    if (type === 'current') {
        let opts = {};
        if (options) {
            opts = {
                ...options
            };
        }
        opts = {
            ...opts,
            successExitCodes: new Set([0, 1, 128])
        }
        const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repositoryPath, 'getCurrentBranch', opts);
        const { exitCode } = result;
        // If the error code 1 is returned if no upstream.
        // If the error code 128 is returned if the branch is unborn.
        if (exitCode === 1 || exitCode === 128) {
            return undefined;
        }
        // New branches have a `heads/` prefix.
        const name = result.stdout.trim().replace(/^heads\//, '');
        return (await getBranches(repositoryPath, [`refs/heads/${name}`], options)).shift();
    } else {
        const result = await getBranches(repositoryPath, [], options);
        switch (type) {
            case 'local': return result.filter(branch => branch.type === BranchType.Local);
            case 'remote': return result.filter(branch => branch.type === BranchType.Remote);
            case 'all': return result;
            default: throw new Error(`Unhandled type: ${type}.`);
        }
    }
}

export async function createBranch(
    repositoryPath: string,
    name: string,
    createOptions?: { startPoint?: string, checkout?: boolean },
    options?: IGitExecutionOptions): Promise<void> {

    const startPoint = createOptions ? createOptions.startPoint : undefined;
    const checkout = createOptions ? createOptions.checkout : false;
    const args = checkout ? ['checkout', '-b', name] : ['branch', name];
    if (startPoint) {
        args.push(startPoint);
    }
    await git(args, repositoryPath, 'createBranch', options);
}

export async function renameBranch(repositoryPath: string, name: string, newName: string, renameOptions?: { force?: boolean }, options?: IGitExecutionOptions): Promise<void> {
    const force = renameOptions ? renameOptions.force : false;
    const args = ['branch', `${force ? '-M' : '-m'}`, name, newName];
    await git(args, repositoryPath, 'renameBranch', options);
}

export async function deleteBranch(repositoryPath: string, name: string, deleteOptions?: { force?: boolean, remote?: boolean }, options?: IGitExecutionOptions): Promise<void> {
    const force = deleteOptions ? deleteOptions.force : false;
    const remote = deleteOptions ? deleteOptions.remote : false;
    const args = ['branch', `${force ? '-D' : '-d'}`, `${name}`];
    const branches = remote ? await getBranches(repositoryPath, [], options) : [];
    await git(args, repositoryPath, 'deleteBranch', options);
    if (remote && branches && branches.length) {
        const branch = branches.find(branch => branch.name.replace(/^heads\//, '') === name);
        if (branch && branch.remote) {
            // Push the remote deletion.
            await git(['push', branch.remote, `:${branch.upstreamWithoutRemote}`], repositoryPath, 'deleteRemoteBranch', options);
        }
    }
}

async function getBranches(repositoryPath: string, prefixes: string[], options?: IGitExecutionOptions): Promise<Branch[]> {
    if (!prefixes || !prefixes.length) {
        prefixes = ['refs/heads', 'refs/remotes'];
    }
    // Branches are ordered by their commit date, in inverse chronological order. The first item is the most recent.
    const args = ['for-each-ref', `--format=${forEachRefFormat}`, '--sort=-committerdate', ...prefixes];
    const result = await git(args, repositoryPath, 'getBranches', options);
    const names = result.stdout;
    const lines = names.split(delimiterString);

    // Remove the trailing newline.
    lines.splice(-1, 1);

    let branches = lines.map((line, ix) => {
        // Preceding newline character after first row.
        const pieces = (ix > 0 ? line.substr(1) : line).split('\0');

        const ref = pieces[0];
        const name = pieces[1];
        const upstream = pieces[2];
        const sha = pieces[3];

        const authorIdentity = pieces[4];
        const author = CommitIdentity.parseIdentity(authorIdentity);

        if (!author) {
            throw new Error(`Couldn't parse author identity ${authorIdentity}.`);
        }

        const parentSHAs = pieces[5].split(' ');
        const summary = pieces[6];
        const body = pieces[7];

        const tip = { sha, summary, body, author, parentSHAs };

        const type = ref.startsWith('refs/head') ? BranchType.Local : BranchType.Remote;
        return new Branch(name, upstream.length > 0 ? upstream : undefined, tip, type);
    });
    if (process.platform === 'darwin') { branches.reverse(); }
    return branches;
}
