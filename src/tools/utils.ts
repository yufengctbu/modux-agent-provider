import * as path from 'node:path'
import * as vscode from 'vscode'

// ***
// Shared utilities for tool implementations
// ***

/**
 * Safely resolves a user-provided relative path to an absolute path within the workspace.
 *
 * Rejects the following to prevent path traversal attacks:
 *   - Absolute paths
 *   - Paths containing `..` that escape the workspace root
 *
 * @returns The resolved absolute path, or an error object with a description.
 */
export function resolveWorkspacePath(relativePath: string): string | { error: string } {
  const folders = vscode.workspace.workspaceFolders
  if (!folders || folders.length === 0) {
    return { error: 'No workspace folder found. Please open a folder first.' }
  }
  const root = folders[0].uri.fsPath
  const resolved = path.resolve(root, relativePath)

  // Ensure the resolved path stays within the workspace root (prevents ../ traversal)
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return { error: `Path "${relativePath}" is outside the workspace root. Access denied.` }
  }
  return resolved
}
