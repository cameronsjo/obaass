import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Create an isolated temp vault directory. Caller is responsible for cleanup. */
export async function makeTempVault(): Promise<string> {
	return mkdtemp(join(tmpdir(), "obaass-vault-"));
}

/** Write a file inside the vault, creating parent dirs. `relPath` is vault-relative. */
export async function writeVaultFile(
	vault: string,
	relPath: string,
	content: string,
): Promise<void> {
	const abs = join(vault, relPath);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, content, "utf-8");
}

/** Remove a temp vault tree. */
export async function cleanupVault(vault: string): Promise<void> {
	await rm(vault, { recursive: true, force: true });
}
