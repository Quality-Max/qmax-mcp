import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const OUTPUT_DIRECTORY = '.qmax-mcp/repros';

export type WriteGeneratedOutputArgs = {
  content: string;
  outputPath?: string;
  overwrite?: boolean;
};

/**
 * Writes a generated repro beneath the caller's workspace.  The returned path
 * is always workspace-relative, so it is safe to present to an MCP client.
 */
export async function writeGeneratedOutput(args: WriteGeneratedOutputArgs): Promise<string> {
  const workspaceRoot = await realpath(process.cwd());
  const outputRoot = await resolveOutputRoot(workspaceRoot);
  const requestedPath = args.outputPath ?? `qmax-repro-${Date.now()}-${randomUUID().slice(0, 8)}.spec.ts`;

  if (path.isAbsolute(requestedPath)) {
    throw new Error('outputPath must be relative to the approved .qmax-mcp/repros directory.');
  }

  const candidate = path.resolve(outputRoot, requestedPath);
  assertWithin(outputRoot, candidate, 'outputPath escapes the approved output directory.');

  await mkdir(path.dirname(candidate), { recursive: true });
  const resolvedParent = await realpath(path.dirname(candidate));
  assertWithin(outputRoot, resolvedParent, 'outputPath resolves through a symlink outside the approved output directory.', true);

  // Use the resolved parent when creating the file so an intermediate symlink
  // cannot redirect the write after validation.
  const target = path.join(resolvedParent, path.basename(candidate));
  assertWithin(outputRoot, target, 'outputPath escapes the approved output directory.');

  const existing = await lstatIfPresent(target);
  if (existing?.isSymbolicLink()) {
    throw new Error('outputPath must not target a symbolic link.');
  }
  if (existing && !existing.isFile()) {
    throw new Error('outputPath must name a regular file.');
  }
  if (existing && !args.overwrite) {
    throw new Error('Refusing to overwrite an existing generated file. Set overwrite:true after reviewing the target.');
  }

  if (existing) {
    await overwriteAtomically(target, args.content);
  } else {
    const handle = await open(target, 'wx');
    try {
      await handle.writeFile(args.content, 'utf8');
    } finally {
      await handle.close();
    }
  }

  const relative = path.relative(workspaceRoot, target);
  assertWithin(workspaceRoot, target, 'Generated path escapes the workspace.');
  return relative.split(path.sep).join('/');
}

async function resolveOutputRoot(workspaceRoot: string): Promise<string> {
  const configuredRoot = path.join(workspaceRoot, OUTPUT_DIRECTORY);
  await mkdir(configuredRoot, { recursive: true });
  const resolvedRoot = await realpath(configuredRoot);
  assertWithin(workspaceRoot, resolvedRoot, 'The approved output directory resolves outside the workspace.');
  return resolvedRoot;
}

async function lstatIfPresent(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function overwriteAtomically(target: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertWithin(root: string, candidate: string, message: string, allowRoot = false): void {
  const relative = path.relative(root, candidate);
  if ((!allowRoot && !relative) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}
