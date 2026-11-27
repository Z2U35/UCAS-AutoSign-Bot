import "server-only";
import { readFile, stat } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { AutoSignStore } from "./store.ts";
import { AutoSignError, type AutoSignMode } from "./types.ts";

const storeGlobal = globalThis as typeof globalThis & {
	ucasAutoSignStore?: { path: string; store: AutoSignStore };
};

export function isAutoSignConfigured(): boolean {
	return Boolean(process.env.UCAS_AUTO_SIGN_DB_PATH && process.env.UCAS_AUTO_SIGN_KEY_FILE);
}

export function getAutoSignMode(): AutoSignMode {
	const mode = process.env.UCAS_AUTO_SIGN_MODE ?? "dry-run";
	if (mode !== "dry-run" && mode !== "live") throw new AutoSignError("INVALID_EXECUTION_MODE", 503);
	return mode;
}

export function getAutoSignStore(): AutoSignStore {
	const databasePath = process.env.UCAS_AUTO_SIGN_DB_PATH;
	if (!isAutoSignConfigured() || !databasePath || !path.isAbsolute(databasePath)) {
		throw new AutoSignError("AUTO_SIGN_NOT_CONFIGURED", 503);
	}
	if (!storeGlobal.ucasAutoSignStore) {
		storeGlobal.ucasAutoSignStore = { path: databasePath, store: new AutoSignStore(databasePath) };
	}
	if (storeGlobal.ucasAutoSignStore.path !== databasePath) throw new AutoSignError("RESTART_REQUIRED", 503);
	return storeGlobal.ucasAutoSignStore.store;
}

export async function verifyMachineCredential(authorization: string | null): Promise<boolean> {
	const keyPath = process.env.UCAS_AUTO_SIGN_KEY_FILE;
	if (!keyPath || !path.isAbsolute(keyPath)) throw new AutoSignError("AUTO_SIGN_NOT_CONFIGURED", 503);
	let expected: string;
	try {
		const metadata = await stat(keyPath);
		if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error();
		expected = (await readFile(/* turbopackIgnore: true */ keyPath, "utf8")).trim();
		if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error();
	} catch {
		throw new AutoSignError("MACHINE_CREDENTIAL_UNAVAILABLE", 503);
	}
	const supplied = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? "")?.[1];
	return Boolean(supplied && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)));
}
