import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export async function resolveApprovedWorkspace(
  workspace: string,
  approvedRoots: readonly string[],
): Promise<string> {
  if (!isAbsolute(workspace)) {
    throw new Error('Workspace path must be absolute.');
  }
  if (approvedRoots.length === 0) {
    throw new Error(
      'No approved workspace roots are configured. Add a workspace root to the config file first.',
    );
  }

  const resolvedWorkspace = await realpath(resolve(workspace));
  if (!(await stat(resolvedWorkspace)).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${resolvedWorkspace}`);
  }

  const roots = await Promise.all(approvedRoots.map((root) => realpath(resolve(root))));
  const approved = roots.some((root) => {
    const relativePath = relative(root, resolvedWorkspace);
    return (
      relativePath === '' ||
      (!relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
        relativePath !== '..' &&
        !isAbsolute(relativePath))
    );
  });

  if (!approved) {
    throw new Error(`Workspace is outside configured approved roots: ${resolvedWorkspace}`);
  }
  return resolvedWorkspace;
}
