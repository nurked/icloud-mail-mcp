/**
 * Credential storage backed by the macOS Keychain via the built-in `security`
 * CLI — no native modules to compile.
 *
 * One generic-password item per provider:
 *   service = "imail-mcp"
 *   account = <providerId>   (e.g. "icloud")
 *   secret  = JSON.stringify({ email, password })
 *
 * Args are passed via execFile (argv, no shell) so passwords with special
 * characters are safe from shell interpretation.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Credentials } from "../providers/types.js";

const exec = promisify(execFile);
const SERVICE = "imail-mcp";

export async function saveCredentials(
  providerId: string,
  creds: Credentials
): Promise<void> {
  const secret = JSON.stringify(creds);
  // -U updates the item if it already exists instead of erroring.
  await exec("security", [
    "add-generic-password",
    "-s",
    SERVICE,
    "-a",
    providerId,
    "-w",
    secret,
    "-U",
  ]);
}

export async function loadCredentials(
  providerId: string
): Promise<Credentials | null> {
  try {
    const { stdout } = await exec("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      providerId,
      "-w",
    ]);
    return JSON.parse(stdout.trim()) as Credentials;
  } catch {
    // Item not found (exit code 44) or unreadable.
    return null;
  }
}

export async function deleteCredentials(providerId: string): Promise<void> {
  try {
    await exec("security", [
      "delete-generic-password",
      "-s",
      SERVICE,
      "-a",
      providerId,
    ]);
  } catch {
    // Nothing stored — treat as success.
  }
}
