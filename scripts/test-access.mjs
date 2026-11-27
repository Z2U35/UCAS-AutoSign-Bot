import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ucas-access-test-"));
const configPath = path.join(temporaryDirectory, "private.json");
const databasePath = path.join(temporaryDirectory, "auto-sign.sqlite");
const machineKeyPath = path.join(temporaryDirectory, "machine.key");
const mockClockPath = path.join(temporaryDirectory, "clock.txt");
const machineKey = randomBytes(32).toString("hex");
await writeFile(machineKeyPath, machineKey, { mode: 0o600 });
await writeFile(mockClockPath, String(Date.parse("2026-09-14T12:00:00+08:00")));
const password = `Test1!${randomBytes(24).toString("hex")}`;
const salt = randomBytes(16).toString("hex");
const config = {
	access: {
		passwordHash: `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`,
		sessionSecret: randomBytes(32).toString("hex"),
		secureCookies: true,
	},
	studentPassword: "test-shared-student-password",
	students: ["alpha", "beta"].map((name, index) => ({
		id: name, name, studentId: `20260000000000${index + 1}`,
	})),
};
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
const portReservation = createServer();
portReservation.listen(0, "127.0.0.1");
await once(portReservation, "listening");
const port = portReservation.address().port;
await new Promise((resolve) => portReservation.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [
	"--import", path.resolve("scripts/mock-access-upstream.mjs"),
	"node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port),
], { env: {
	...process.env, UCAS_CONFIG_PATH: configPath,
	UCAS_AUTO_SIGN_DB_PATH: databasePath, UCAS_AUTO_SIGN_KEY_FILE: machineKeyPath,
	UCAS_AUTO_SIGN_MODE: "dry-run", UCAS_MOCK_CLOCK_FILE: mockClockPath,
}, stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

async function request(route, body, cookie, extraHeaders = {}) {
	return fetch(`${baseUrl}${route}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { Origin: baseUrl, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(10000),
	});
}

async function login() {
	const response = await request("/api/access/login", { password });
	assert.equal(response.status, 200);
	const setCookie = response.headers.get("set-cookie");
	assert.match(setCookie, /HttpOnly/i);
	assert.match(setCookie, /Secure/i);
	assert.match(setCookie, /SameSite=strict/i);
	assert.match(setCookie, /Max-Age=28800/i);
	return setCookie.split(";")[0];
}

async function submitAccessForm(accessPassword, extraHeaders = {}) {
	return fetch(`${baseUrl}/api/access/login`, {
		method: "POST",
		headers: { Origin: baseUrl, ...extraHeaders },
		body: new URLSearchParams({ username: "ucas-workspace", accessPassword }),
		redirect: "manual",
		signal: AbortSignal.timeout(10000),
	});
}

try {
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (server.exitCode !== null) throw new Error("Test server exited before startup");
		try {
			const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1000) });
			if (response.ok) { ready = true; break; }
		} catch {}
		await delay(100);
	}
	assert.ok(ready, "Test server must become ready");
	const lockedResponse = await request("/");
	assert.equal(lockedResponse.headers.get("referrer-policy"), "same-origin",
		"Native form POSTs need a policy that preserves their same-origin Origin header");
	const lockedHtml = await lockedResponse.text();
	assert.match(lockedHtml, /CookBook 日常食记/);
	assert.match(lockedHtml, /私房厨房/);
	assert.match(lockedHtml, /name="accessPassword"/);
	const lockedPageText = lockedHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<[^>]*>/g, "");
	assert.doesNotMatch(lockedPageText, /UCAS|课表|课程|签到|学号|学生账号|COURSE JOURNAL/i);
	assert.match(lockedHtml, /encType="application\/x-www-form-urlencoded"/i);
	assert.match(lockedHtml, /autoComplete="current-password"/i);
	assert.ok(!lockedHtml.includes('name="studentId"'));
	for (const route of ["/api/access/accounts", "/api/course-uuid/timestamp", "/api/auto-sign"]) {
		assert.equal((await request(route)).status, 401);
	}
	for (const route of ["/api/course-uuid/query", "/api/course-uuid/sign", "/api/auto-sign/accounts", "/api/auto-sign/tasks", "/api/auto-sign/tasks/preview", "/api/auto-sign/tasks/cancel", "/api/auto-sign/tasks/delete"]) {
		assert.equal((await request(route, { accountId: "alpha" })).status, 401);
	}
	assert.equal((await request("/api/access/accounts", undefined, `ucas-access=${"0".repeat(64)}`)).status, 401);
	console.log("PASS: locked page and every protected API reject unauthenticated access");

	assert.equal((await request("/api/access/login", { password }, undefined, { Origin: "https://attacker.invalid" })).status, 403);
	assert.equal((await request("/api/access/login", { password: "wrong-but-long-password" })).status, 401);
	assert.equal((await submitAccessForm(password, { Origin: "https://attacker.invalid" })).status, 403);
	assert.equal((await submitAccessForm(password, { Origin: "null", "Sec-Fetch-Site": "same-origin" })).status, 403);
	assert.equal((await submitAccessForm(password, { "Sec-Fetch-Site": "cross-site" })).status, 403);
	for (const [formPassword, errorStatus] of [["wrong-but-long-password", 401], ["x".repeat(8193), 413]]) {
		const failedForm = await submitAccessForm(formPassword);
		assert.equal(failedForm.status, 303);
		assert.equal(failedForm.headers.get("location"), `/?accessError=${errorStatus}`);
		assert.equal(failedForm.headers.get("set-cookie"), null);
		assert.equal(failedForm.headers.get("cache-control"), "no-store");
	}
	const errorHtml = await (await request("/?accessError=401")).text();
	assert.equal((await request("/?accessError=401")).headers.get("referrer-policy"), "same-origin");
	assert.match(errorHtml, /role="alert"/);
	assert.match(errorHtml, /aria-invalid="true"/);
	const unknownErrorHtml = await (await request("/?accessError=toString")).text();
	assert.match(unknownErrorHtml, /私房厨房/);
	assert.doesNotMatch(unknownErrorHtml, /role="alert"/);
	const formLogin = await submitAccessForm(password);
	assert.equal(formLogin.status, 303);
	assert.equal(formLogin.headers.get("location"), "/");
	assert.equal(formLogin.headers.get("cache-control"), "no-store");
	const formSetCookie = formLogin.headers.get("set-cookie");
	for (const attribute of [/HttpOnly/i, /Secure/i, /SameSite=strict/i, /Max-Age=28800/i]) {
		assert.match(formSetCookie, attribute);
	}
	const formCookie = formSetCookie.split(";")[0];
	const formUnlockedHtml = await (await request("/", undefined, formCookie)).text();
	assert.ok(formUnlockedHtml.includes('name="studentId"'));
	assert.ok(!formUnlockedHtml.includes('id="access-password"'));
	await request("/api/access/logout", {}, formCookie);
	assert.equal((await request("/api/access/accounts", undefined, formCookie)).status, 401);
	console.log("PASS: native form login redirects, authenticates, preserves cookie security and rejects invalid submissions");
	const cookie = await login();
	const unlockedHtml = await (await request("/", undefined, cookie)).text();
	assert.ok(unlockedHtml.includes('name="studentId"'));
	assert.ok(!unlockedHtml.includes('name="password"'));
	assert.ok(!unlockedHtml.includes(config.studentPassword));
	assert.ok(!unlockedHtml.includes(config.access.passwordHash));
	const accountsResponse = await request("/api/access/accounts", undefined, cookie);
	assert.equal(accountsResponse.headers.get("cache-control"), "no-store");
	assert.deepEqual(await accountsResponse.json(), { students: config.students.map(({ id, name }) => ({ id, name })) });
	console.log("PASS: correct password unlocks UI, secure cookie, names-only account response");

	for (const accountId of ["alpha", "beta"]) {
		const queryResponse = await request("/api/course-uuid/query", {
			accountId, studentId: "202600000000003", password: "must-be-ignored", date: "20260911",
		}, cookie);
		assert.equal(queryResponse.status, 200);
		assert.equal((await queryResponse.json()).courses[0].courseName, accountId);
		const signResponse = await request("/api/course-uuid/sign", { accountId, courseSchedId: "1234567" }, cookie);
		assert.equal(signResponse.status, 200);
		assert.equal((await signResponse.json()).result.stuSignId, `mock-${accountId}`);
	}
	const manualResponse = await request("/api/course-uuid/query", {
		studentId: " 202600000000003 ", date: "20260911",
	}, cookie);
	assert.equal(manualResponse.status, 200);
	assert.equal((await manualResponse.json()).courses[0].courseName, "manual");
	const manualSignResponse = await request("/api/course-uuid/sign", {
		studentId: "202600000000003", password: "must-be-ignored", courseSchedId: "1234567",
	}, cookie);
	assert.equal(manualSignResponse.status, 200);
	assert.equal((await manualSignResponse.json()).result.stuSignId, "mock-manual");
	for (const studentId of ["", "alpha@example.com", "20260000000000", "2026000000000011", 202600000000001]) {
		for (const route of ["/api/course-uuid/query", "/api/course-uuid/sign"]) {
			const response = await request(route, { studentId, date: "20260911", courseSchedId: "1234567" }, cookie, { "X-Real-IP": "validation-test" });
			assert.equal(response.status, 400);
		}
	}
	assert.equal((await request("/api/course-uuid/timestamp", undefined, cookie)).status, 200);
	assert.equal((await request("/api/course-uuid/query", { accountId: "unknown" }, cookie)).status, 400);
	assert.equal((await request("/api/course-uuid/sign", { accountId: "unknown" }, cookie)).status, 400);
	assert.equal((await request("/api/course-uuid/sign", {}, cookie, { Origin: "https://attacker.invalid" })).status, 403);
	console.log("PASS: saved and manual student IDs use the server password; overrides ignored; malformed IDs rejected; upstream mocked");

	config.students[0].name = "renamed";
	await writeFile(configPath, JSON.stringify(config));
	assert.equal((await (await request("/api/access/accounts", undefined, cookie)).json()).students[0].name, "renamed");
	config.studentPassword = "";
	await writeFile(configPath, JSON.stringify(config));
	assert.equal((await request("/api/access/accounts", undefined, cookie)).status, 503);
	config.studentPassword = "test-shared-student-password";
	await writeFile(configPath, '{"password":"do-not-leak-this-parse-error"');
	const brokenConfig = await request("/api/access/accounts", undefined, cookie);
	assert.equal(brokenConfig.status, 503);
	assert.ok(!(await brokenConfig.text()).includes("do-not-leak"));
	const brokenConfigForm = await submitAccessForm(password);
	assert.equal(brokenConfigForm.status, 303);
	assert.equal(brokenConfigForm.headers.get("location"), "/?accessError=503");
	await writeFile(configPath, JSON.stringify(config));
	assert.equal((await request("/api/access/logout", {}, cookie)).status, 200);
	assert.equal((await request("/api/access/accounts", undefined, cookie)).status, 401);
	const rotatedCookie = await login();
	config.access.sessionSecret = randomBytes(32).toString("hex");
	await writeFile(configPath, JSON.stringify(config));
	assert.equal((await request("/api/access/accounts", undefined, rotatedCookie)).status, 401);
	console.log("PASS: hot reload, fail-closed invalid config, logout revocation and secret rotation");

	for (let attempt = 0; attempt < 30; attempt += 1) {
		assert.equal((await request("/api/access/login", { password: "wrong-but-long-password" }, undefined, { "X-Real-IP": "rate-test" })).status, 401);
	}
	const limitedResponse = await request("/api/access/login", { password }, undefined, { "X-Real-IP": "rate-test" });
	assert.equal(limitedResponse.status, 429);
	assert.ok(Number(limitedResponse.headers.get("retry-after")) > 0);
	const limitedForm = await submitAccessForm(password, { "X-Real-IP": "rate-test" });
	assert.equal(limitedForm.status, 303);
	assert.equal(limitedForm.headers.get("location"), "/?accessError=429");
	assert.ok(Number(limitedForm.headers.get("retry-after")) > 0);
	assert.equal((await readFile(configPath, "utf8")).includes('"name":"beta"'), true);
	console.log("PASS: login throttling returns 429 and Retry-After");

	const schedulerCookie = await login();
	const initialSnapshot = await (await request("/api/auto-sign", undefined, schedulerCookie)).json();
	assert.equal(initialSnapshot.available, true);
	assert.equal(initialSnapshot.mode, "dry-run");
	assert.ok(initialSnapshot.accounts.every((account) => !account.enabled));
	assert.deepEqual(initialSnapshot.tasks, []);
	const selectedCourse = { accountId: "alpha", date: "2026-09-15", courseSchedId: "1234567" };
	assert.equal((await request("/api/auto-sign/tasks/preview", selectedCourse, schedulerCookie)).status, 409);
	assert.equal((await request("/api/auto-sign/accounts", { accountId: "alpha", enabled: true }, schedulerCookie, { Origin: "https://attacker.invalid" })).status, 403);
	assert.equal((await request("/api/auto-sign/accounts", { accountId: "alpha", enabled: true }, schedulerCookie)).status, 200);
	assert.deepEqual((await (await request("/api/auto-sign", undefined, schedulerCookie)).json()).tasks, []);
	const previewResponse = await request("/api/auto-sign/tasks/preview", selectedCourse, schedulerCookie);
	assert.equal(previewResponse.status, 200);
	const { preview } = await previewResponse.json();
	assert.ok(preview.scheduledAt >= Date.parse("2026-09-15T08:20:00+08:00"));
	assert.ok(preview.scheduledAt <= Date.parse("2026-09-15T08:24:00+08:00"));
	assert.equal(preview.deadlineAt, preview.classBeginAt - 30_000);
	const repeatedPreview = (await (await request("/api/auto-sign/tasks/preview", selectedCourse, schedulerCookie)).json()).preview;
	assert.deepEqual(repeatedPreview, preview);
	assert.equal((await request("/api/auto-sign/tasks", { ...selectedCourse, expectedClassBeginAt: 0 }, schedulerCookie)).status, 409);
	const taskBody = { ...selectedCourse, expectedClassBeginAt: preview.classBeginAt, expectedClassEndAt: preview.classEndAt };
	const creation = await request("/api/auto-sign/tasks", taskBody, schedulerCookie);
	assert.equal(creation.status, 200);
	const firstTask = (await creation.json()).task;
	assert.equal(firstTask.scheduledAt, preview.scheduledAt);
	assert.equal(firstTask.deadlineAt, preview.deadlineAt);
	const repeated = (await (await request("/api/auto-sign/tasks", taskBody, schedulerCookie)).json()).task;
	assert.equal(firstTask.id, repeated.id);
	const deleteRoute = "/api/auto-sign/tasks/delete";
	const pendingDeletion = await request(deleteRoute, { taskId: firstTask.id }, schedulerCookie);
	assert.equal(pendingDeletion.status, 409);
	assert.equal((await pendingDeletion.json()).code, "TASK_NOT_DELETABLE");
	assert.equal((await request("/api/auto-sign/tasks/cancel", { taskId: firstTask.id }, schedulerCookie)).status, 200);
	assert.equal((await request(deleteRoute, { taskId: firstTask.id }, schedulerCookie, { Origin: "https://attacker.invalid" })).status, 403);
	assert.equal((await request(deleteRoute, { taskId: firstTask.id }, undefined, { Authorization: `Bearer ${machineKey}` })).status, 401);
	for (const taskId of [undefined, "", " ", 123, "x".repeat(65)]) {
		assert.equal((await request(deleteRoute, { taskId }, schedulerCookie)).status, 400);
	}
	assert.equal((await request(deleteRoute, { taskId: "missing-task" }, schedulerCookie)).status, 404);
	assert.equal((await (await request("/api/auto-sign", undefined, schedulerCookie)).json()).tasks.length, 1);
	for (let deletionAttempt = 0; deletionAttempt < 2; deletionAttempt += 1) {
		const deletion = await request(deleteRoute, { taskId: firstTask.id }, schedulerCookie);
		assert.equal(deletion.status, 200);
		assert.equal(deletion.headers.get("cache-control"), "no-store");
	}
	assert.deepEqual((await (await request("/api/auto-sign", undefined, schedulerCookie)).json()).tasks, []);
	const scheduledTask = (await (await request("/api/auto-sign/tasks", taskBody, schedulerCookie)).json()).task;
	assert.notEqual(scheduledTask.id, firstTask.id);
	for (const authorization of [undefined, `Bearer ${"0".repeat(64)}`]) {
		assert.equal((await request("/api/internal/auto-sign/tick", {}, schedulerCookie, authorization ? { Authorization: authorization } : {})).status, 401);
	}
	assert.equal((await request("/api/internal/auto-sign/tick", undefined)).status, 405);
	const oversized = await request("/api/auto-sign/tasks", { payload: "x".repeat(5000) }, schedulerCookie);
	assert.equal(oversized.status, 413);
	await writeFile(mockClockPath, String(preview.scheduledAt));
	assert.equal((await request("/api/auto-sign", undefined, schedulerCookie)).status, 401, "Browser session expires overnight");
	const machineTick = await request("/api/internal/auto-sign/tick", {}, undefined, { Authorization: `Bearer ${machineKey}` });
	assert.equal(machineTick.status, 200);
	assert.equal((await machineTick.json()).processed, 1);
	const freshCookie = await login();
	const completedSnapshot = await (await request("/api/auto-sign", undefined, freshCookie)).json();
	assert.equal(completedSnapshot.tasks.find((task) => task.id === scheduledTask.id).status, "dry_run");
	assert.equal(completedSnapshot.tasks.some((task) => task.id === firstTask.id), false);
	assert.equal(completedSnapshot.scheduler.lastFinishedAt, preview.scheduledAt);
	const secondTick = await request("/api/internal/auto-sign/tick", {}, undefined, { Authorization: `Bearer ${machineKey}` });
	assert.equal((await secondTick.json()).processed, 0);
	const publicText = JSON.stringify(completedSnapshot);
	for (const secret of [password, machineKey, config.studentPassword, config.access.sessionSecret, "session-alpha", "studentIdentity", "leaseToken"]) {
		assert.ok(!publicText.includes(secret));
		assert.ok(!serverOutput.includes(secret));
	}
	console.log("PASS: scheduler confirmation, cancellation, expired sessions, machine auth, dry-run and safe output");
	assert.equal((await request(deleteRoute, { taskId: scheduledTask.id }, freshCookie)).status, 200);
	const afterDeletion = await (await request("/api/auto-sign", undefined, freshCookie)).json();
	assert.deepEqual(afterDeletion.tasks, []);
	assert.deepEqual(afterDeletion.accounts, completedSnapshot.accounts);
	assert.deepEqual(afterDeletion.scheduler, completedSnapshot.scheduler);
	console.log("PASS: terminal card deletion persists across snapshots, is idempotent, and rejects active, unauthenticated and cross-origin requests");

	assert.equal((await request("/api/auto-sign/accounts", { accountId: "beta", enabled: true }, freshCookie)).status, 200);
	const retainedCreations = [];
	for (let taskIndex = 0; taskIndex < 22; taskIndex += 1) {
		await writeFile(mockClockPath, String(preview.scheduledAt + 1000 + taskIndex));
		const selectedDate = `2026-10-${String(taskIndex + 1).padStart(2, "0")}`;
		const createdResponse = await request("/api/auto-sign/tasks", {
			accountId: taskIndex % 2 === 0 ? "alpha" : "beta", date: selectedDate, courseSchedId: "1234567",
			expectedClassBeginAt: Date.parse(`${selectedDate}T08:30:00+08:00`),
			expectedClassEndAt: Date.parse(`${selectedDate}T10:10:00+08:00`),
		}, freshCookie);
		assert.equal(createdResponse.status, 200);
		const createdTask = (await createdResponse.json()).task;
		retainedCreations.push(createdTask);
		if (taskIndex % 2 === 1) {
			assert.equal((await request("/api/auto-sign/tasks/cancel", { taskId: createdTask.id }, freshCookie)).status, 200);
		}
	}
	const retainedSnapshot = await (await request("/api/auto-sign", undefined, freshCookie)).json();
	const expectedTaskIds = retainedCreations.slice(-20).reverse().map((task) => task.id);
	assert.deepEqual(retainedSnapshot.tasks.map((task) => task.id), expectedTaskIds);
	assert.deepEqual(new Set(retainedSnapshot.tasks.map((task) => task.status)), new Set(["pending", "cancelled"]));
	const inspection = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const storedTasks = inspection.prepare("SELECT id FROM tasks ORDER BY updatedAt DESC, createdAt DESC, rowid DESC").all();
		assert.deepEqual(storedTasks.map((task) => task.id), expectedTaskIds);
		const evictedIds = [firstTask.id, scheduledTask.id, ...retainedCreations.slice(0, 2).map((task) => task.id)];
		for (const taskId of evictedIds) {
			assert.equal(inspection.prepare("SELECT COUNT(*) AS total FROM events WHERE taskId = ?").get(taskId).total, 0);
		}
		assert.deepEqual(inspection.prepare("PRAGMA foreign_key_check").all(), []);
	} finally {
		inspection.close();
	}
	console.log("PASS: snapshot and SQLite keep the same twenty mixed-status records across accounts; older rows and events are removed");

	const pushedMessages = [];
	const mockWeComServer = createHttpServer((req, res) => {
		const reqUrl = new URL(req.url, "http://127.0.0.1");
		if (req.method === "GET" && reqUrl.pathname === "/cgi-bin/gettoken") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ errcode: 0, access_token: "mock-wecom-token", expires_in: 7200 }));
			return;
		}
		if (req.method === "POST" && reqUrl.pathname === "/cgi-bin/message/send") {
			let bodyText = "";
			req.on("data", (chunk) => { bodyText += chunk; });
			req.on("end", () => {
				pushedMessages.push(JSON.parse(bodyText));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ errcode: 0, invaliduser: "" }));
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	mockWeComServer.listen(0, "127.0.0.1");
	await once(mockWeComServer, "listening");
	try {
		const wecomPort = mockWeComServer.address().port;
		const cbToken = "CallbackToken99";
		const cbAesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
		const cbCorpId = "ww_test_corp_callback";
		const wecomConfig = {
			...config,
			wecom: {
				enabled: true,
				corpId: cbCorpId,
				agentId: 1000002,
				corpSecret: "mock_corp_secret_value_123",
				apiOrigin: `http://127.0.0.1:${wecomPort}`,
				callbackToken: cbToken,
				callbackEncodingAesKey: cbAesKey,
				adminUserIds: ["wx_admin"],
			},
			students: [
				{ id: "alpha", name: "alpha", studentId: "202600000000001", wecomUserId: "wx_alpha" },
				{ id: "beta", name: "beta", studentId: "202600000000002" },
			],
		};
		await writeFile(configPath, JSON.stringify(wecomConfig), { mode: 0o600 });

		const encryptWeCom = (plain) => {
			const aesKey = Buffer.from(`${cbAesKey}=`, "base64");
			const msgBuf = Buffer.from(plain, "utf8");
			const corpBuf = Buffer.from(cbCorpId, "utf8");
			const lenBuf = Buffer.alloc(4);
			lenBuf.writeUInt32BE(msgBuf.length, 0);
			const raw = Buffer.concat([randomBytes(16), lenBuf, msgBuf, corpBuf]);
			const padLen = 32 - (raw.length % 32 || 0);
			const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
			const cipher = createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
			cipher.setAutoPadding(false);
			const cipherText = Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
			const ts = "1795696000";
			const nonce = "55667788";
			const sig = createHash("sha1").update([cbToken, ts, nonce, cipherText].sort().join(""), "utf8").digest("hex");
			return { cipherText, ts, nonce, sig };
		};

		const echoEnc = encryptWeCom("verify-ok-123");
		const getVerify = await fetch(`${baseUrl}/api/wecom/callback?msg_signature=${echoEnc.sig}&timestamp=${echoEnc.ts}&nonce=${echoEnc.nonce}&echostr=${encodeURIComponent(echoEnc.cipherText)}`);
		assert.equal(getVerify.status, 200);
		assert.equal(await getVerify.text(), "verify-ok-123");

		const badPost = await fetch(`${baseUrl}/api/wecom/callback?msg_signature=${"0".repeat(40)}&timestamp=1&nonce=2`, {
			method: "POST", headers: { "Content-Type": "text/xml" }, body: "<xml><Encrypt>abc</Encrypt></xml>",
		});
		assert.equal(badPost.status, 403);

		const bigPost = await fetch(`${baseUrl}/api/wecom/callback?msg_signature=${"0".repeat(40)}&timestamp=1&nonce=2`, {
			method: "POST", headers: { "Content-Type": "text/xml" }, body: "x".repeat(17000),
		});
		assert.equal(bigPost.status, 413);

		const innerMsg = `<xml><ToUserName><![CDATA[${cbCorpId}]]></ToUserName><FromUserName><![CDATA[wx_alpha]]></FromUserName><CreateTime>1795696001</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[/c 2026-09-15]]></Content><MsgId>msg-e2e-001</MsgId><AgentID>1000002</AgentID></xml>`;
		const postEnc = encryptWeCom(innerMsg);
		const xmlBody = `<xml><ToUserName><![CDATA[${cbCorpId}]]></ToUserName><AgentID><![CDATA[1000002]]></AgentID><Encrypt><![CDATA[${postEnc.cipherText}]]></Encrypt></xml>`;
		const postRes = await fetch(`${baseUrl}/api/wecom/callback?msg_signature=${postEnc.sig}&timestamp=${postEnc.ts}&nonce=${postEnc.nonce}`, {
			method: "POST", headers: { "Content-Type": "text/xml" }, body: xmlBody,
		});
		assert.equal(postRes.status, 200);
		assert.equal(await postRes.text(), "success");

		for (let waitIdx = 0; waitIdx < 40 && pushedMessages.length === 0; waitIdx += 1) {
			await delay(50);
		}
		assert.equal(pushedMessages.length, 1);
		assert.equal(pushedMessages[0].touser, "wx_alpha");
		assert.match(pushedMessages[0].text.content, /课表｜alpha｜2026-09-15/);
		assert.match(pushedMessages[0].text.content, /\[1\] 08:30-10:10 alpha/);
		console.log("PASS: WeCom callback GET verification and async encrypted slash-command POST bot reply");
	} finally {
		await new Promise((resolve) => mockWeComServer.close(resolve));
	}
} catch (error) {
	console.error(serverOutput);
	throw error;
} finally {
	const serverExited = once(server, "exit");
	server.kill("SIGTERM");
	await Promise.race([serverExited, delay(5000)]);
	if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
	await rm(temporaryDirectory, { recursive: true, force: true });
}
