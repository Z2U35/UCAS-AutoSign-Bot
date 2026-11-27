import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 110_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const COUNT_FIELDS = ["processed", "reconciled", "succeeded", "failed", "skipped", "expired", "paused", "dryRun", "uncertain"];
const HELP_TEXT = `Usage: node scripts/trigger-auto-sign.mjs

UCAS_AUTO_SIGN_KEY_FILE must name an absolute path to a mode-0600 key file.
UCAS_AUTO_SIGN_PORT optionally selects a numeric loopback port (default: 3000).
The only destination is http://127.0.0.1:<port>/api/internal/auto-sign/tick.
Node's environment-proxy mode must be disabled for this local-only request.
No credential, destination URL, or other argument is accepted on the command line.
Output contains only allowlisted counts, execution mode, busy state, or a fixed
failure code. A request waits for completion and times out after 110 seconds.`;

class TriggerError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

function getConfiguration() {
	const keyPath = process.env.UCAS_AUTO_SIGN_KEY_FILE;
	const portText = process.env.UCAS_AUTO_SIGN_PORT ?? "3000";
	const portNumber = Number(portText);
	const environmentProxyEnabled = Boolean(process.env.NODE_USE_ENV_PROXY && process.env.NODE_USE_ENV_PROXY !== "0")
		|| process.execArgv.some((argument) => argument.split("=")[0] === "--use-env-proxy")
		|| (process.env.NODE_OPTIONS ?? "").includes("--use-env-proxy");
	if (!keyPath || !path.isAbsolute(keyPath) || keyPath.includes("\0")
		|| !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535
		|| String(portNumber) !== portText || environmentProxyEnabled) {
		throw new TriggerError("AUTO_SIGN_CONFIGURATION_INVALID");
	}
	return { keyPath, endpoint: `http://127.0.0.1:${portText}/api/internal/auto-sign/tick` };
}

async function readMachineKey(keyPath) {
	let keyFile;
	try {
		// Reject final-component symlinks and avoid blocking on a misconfigured FIFO.
		keyFile = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const metadata = await keyFile.stat();
		if (!metadata.isFile() || (metadata.mode & 0o7777) !== 0o600
			|| typeof process.geteuid !== "function" || metadata.uid !== process.geteuid()
			|| metadata.size < 64 || metadata.size > 65) {
			throw new TriggerError("AUTO_SIGN_KEY_UNAVAILABLE");
		}
		const keyBuffer = Buffer.alloc(66);
		const { bytesRead } = await keyFile.read(keyBuffer, 0, keyBuffer.length, 0);
		const keyText = keyBuffer.subarray(0, bytesRead).toString("utf8");
		const machineKey = keyText.endsWith("\n") ? keyText.slice(0, -1) : keyText;
		if (machineKey.length !== 64 || !/^[a-f0-9]{64}$/.test(machineKey)) {
			throw new TriggerError("AUTO_SIGN_KEY_UNAVAILABLE");
		}
		return machineKey;
	} catch {
		throw new TriggerError("AUTO_SIGN_KEY_UNAVAILABLE");
	} finally {
		if (keyFile) await keyFile.close();
	}
}

async function readResponseSummary(response) {
	if (!response.body || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
		throw new TriggerError("AUTO_SIGN_RESPONSE_INVALID");
	}

	const responseReader = response.body.getReader();
	const responseChunks = [];
	let responseBytes = 0;
	try {
		while (true) {
			const { done, value } = await responseReader.read();
			if (done) break;
			responseBytes += value.byteLength;
			if (responseBytes > MAX_RESPONSE_BYTES) throw new TriggerError("AUTO_SIGN_RESPONSE_INVALID");
			responseChunks.push(value);
		}
	} finally {
		await responseReader.cancel().catch(() => {});
	}

	let responseData;
	try {
		responseData = JSON.parse(Buffer.concat(responseChunks).toString("utf8"));
	} catch {
		throw new TriggerError("AUTO_SIGN_RESPONSE_INVALID");
	}
	if (!responseData || typeof responseData !== "object" || Array.isArray(responseData)
		|| !["dry-run", "live"].includes(responseData.mode) || typeof responseData.busy !== "boolean") {
		throw new TriggerError("AUTO_SIGN_RESPONSE_INVALID");
	}

	const countSource = responseData.counts ?? responseData;
	if (!countSource || typeof countSource !== "object" || Array.isArray(countSource)) {
		throw new TriggerError("AUTO_SIGN_RESPONSE_INVALID");
	}
	const counts = {};
	for (const countName of COUNT_FIELDS) {
		if (!Object.hasOwn(countSource, countName)) continue;
		const countValue = countSource[countName];
		if (!Number.isSafeInteger(countValue) || countValue < 0) throw new TriggerError("AUTO_SIGN_RESPONSE_INVALID");
		counts[countName] = countValue;
	}
	// Never echo task details, account identifiers, upstream bodies, or error text.
	return { mode: responseData.mode, busy: responseData.busy, counts };
}

let requestSignal;
try {
	if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2])) {
		console.log(HELP_TEXT);
	} else {
		if (process.argv.length !== 2) throw new TriggerError("AUTO_SIGN_CONFIGURATION_INVALID");
		const configuration = getConfiguration();
		const machineKey = await readMachineKey(configuration.keyPath);
		requestSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const response = await fetch(configuration.endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${machineKey}`, Accept: "application/json" },
			redirect: "error",
			cache: "no-store",
			signal: requestSignal,
		});
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => {});
			throw new TriggerError("AUTO_SIGN_HTTP_FAILURE");
		}
		console.log(JSON.stringify(await readResponseSummary(response)));
	}
} catch (error) {
	const errorCode = requestSignal?.aborted ? "AUTO_SIGN_TICK_TIMEOUT"
		: error instanceof TriggerError ? error.code : "AUTO_SIGN_TICK_FAILED";
	console.error(errorCode);
	process.exitCode = 1;
}
