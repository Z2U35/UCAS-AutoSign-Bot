import { randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const configPath = process.env.UCAS_CONFIG_PATH || path.join(process.cwd(), "config/private.json");
const configDirectory = path.dirname(configPath);
const passwordPath = path.join(configDirectory, "access-password.txt");
const rotatePassword = process.argv.includes("--rotate");

try {
	await mkdir(configDirectory, { recursive: true, mode: 0o700 });
	await chmod(configDirectory, 0o700);
	let config;
	try {
		config = JSON.parse(await readFile(configPath, "utf8"));
		if (!rotatePassword) throw new Error("Configuration already exists. Use --rotate to replace the access password.");
		if (!Array.isArray(config.students) || typeof config.access?.secureCookies !== "boolean") {
			throw new Error("Existing configuration is invalid; repair it before rotating.");
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		config = {
			access: { secureCookies: !process.argv.includes("--local-http") },
			studentPassword: "",
			students: [],
		};
	}
	const password = `Aa1!${randomBytes(24).toString("base64url")}`;
	const salt = randomBytes(16).toString("hex");
	config.access.passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
	config.access.sessionSecret = randomBytes(32).toString("hex");
	const temporaryPath = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	await writeFile(passwordPath, `${password}\n`, { mode: 0o600 });
	await chmod(passwordPath, 0o600);
	await rename(temporaryPath, configPath);
	console.log(`Private config: ${configPath}`);
	console.log(`Generated password saved privately: ${passwordPath}`);
	console.log("No password is printed. Save it in a password manager, then remove access-password.txt.");
	if (!config.studentPassword) {
		console.log("Set studentPassword in the private config before using the application. It is separate from the access password.");
	}
} catch (error) {
	// Syntax errors may quote secrets from a malformed JSON file.
	console.error(error instanceof SyntaxError ? "Invalid private JSON; no configuration changes applied." : error.message);
	process.exitCode = 1;
}
