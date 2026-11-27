import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

const HELP_TEXT = `Usage:
  node scripts/setup-auto-sign.mjs --key-file /absolute/directory/auto-sign.key [--create-directory]
  node scripts/setup-auto-sign.mjs --help

Creates a new 32-byte random key encoded as 64 lowercase hexadecimal characters.
The key is written exclusively with mode 0600 and is never printed.
An existing key is never overwritten. No application config or services change.

The key directory must be owned by the current user, have mode 0700, and contain
no symlink components. --create-directory explicitly permits creating only
that final directory; its parent must already exist. Existing permissions are
never changed. Run as the application's service user so it can read the key.
No target path is inferred from the current directory or environment.`;

const ERROR_MESSAGES = Object.freeze({
	INVALID_ARGUMENTS: "Invalid arguments. Use --help; provide an explicit --key-file path.",
	INVALID_KEY_PATH: "The key path must be an absolute, normalized file path without symlink components.",
	KEY_DIRECTORY_MISSING: "The key directory is missing. Provision it first or explicitly use --create-directory.",
	KEY_DIRECTORY_UNSAFE: "The key directory must be a real directory owned by the current user with mode 0700.",
	KEY_EXISTS: "The key already exists; it was not overwritten. Rotation must be performed separately.",
	KEY_CREATION_FAILED: "Key creation failed. Inspect the target privately before retrying; existing keys are never overwritten.",
});

class SetupError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

function parseArguments(argumentsList) {
	if (argumentsList.length === 1 && ["--help", "-h"].includes(argumentsList[0])) return { help: true };

	let keyPath;
	let createDirectory = false;
	for (let argumentIndex = 0; argumentIndex < argumentsList.length; argumentIndex += 1) {
		const argument = argumentsList[argumentIndex];
		if (argument === "--key-file" && keyPath === undefined && argumentsList[argumentIndex + 1]) {
			keyPath = argumentsList[argumentIndex + 1];
			argumentIndex += 1;
		} else if (argument === "--create-directory" && !createDirectory) {
			createDirectory = true;
		} else {
			throw new SetupError("INVALID_ARGUMENTS");
		}
	}

	if (!keyPath) throw new SetupError("INVALID_ARGUMENTS");
	if (!path.isAbsolute(keyPath) || keyPath.includes("\0") || path.normalize(keyPath) !== keyPath
		|| keyPath.endsWith(path.sep) || path.dirname(keyPath) === keyPath) {
		throw new SetupError("INVALID_KEY_PATH");
	}
	return { keyPath, createDirectory, help: false };
}

async function verifyDirectory(directoryPath) {
	const metadata = await lstat(directoryPath);
	if (!metadata.isDirectory() || typeof process.geteuid !== "function"
		|| metadata.uid !== process.geteuid() || (metadata.mode & 0o7777) !== 0o700
		|| await realpath(directoryPath) !== directoryPath) {
		throw new SetupError("KEY_DIRECTORY_UNSAFE");
	}
}

async function prepareDirectory(directoryPath, createDirectory) {
	try {
		await verifyDirectory(directoryPath);
		return;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		if (!createDirectory) throw new SetupError("KEY_DIRECTORY_MISSING");
	}

	// Never recursively create or relax permissions on an implicitly chosen ancestor.
	const parentDirectory = path.dirname(directoryPath);
	if (await realpath(parentDirectory) !== parentDirectory) throw new SetupError("INVALID_KEY_PATH");
	await mkdir(directoryPath, { mode: 0o700 });
	await verifyDirectory(directoryPath);
}

async function createKey(keyPath) {
	let keyFile;
	try {
		keyFile = await open(keyPath, "wx", 0o600);
	} catch (error) {
		if (error.code === "EEXIST") throw new SetupError("KEY_EXISTS");
		throw error;
	}

	try {
		const metadata = await keyFile.stat();
		if (!metadata.isFile() || (metadata.mode & 0o7777) !== 0o600) {
			throw new SetupError("KEY_CREATION_FAILED");
		}
		await keyFile.writeFile(randomBytes(32).toString("hex"), "utf8");
		await keyFile.sync();
	} finally {
		await keyFile.close();
	}
}

try {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		console.log(HELP_TEXT);
	} else {
		await prepareDirectory(path.dirname(options.keyPath), options.createDirectory);
		await createKey(options.keyPath);
		console.log("Auto-sign key created with mode 0600. The secret was not printed.");
		console.log("No application configuration, database, timer, or service was changed.");
	}
} catch (error) {
	const errorCode = error instanceof SetupError ? error.code : "KEY_CREATION_FAILED";
	console.error(`${errorCode}: ${ERROR_MESSAGES[errorCode]}`);
	process.exitCode = 1;
}
