import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const originalFetch = globalThis.fetch;
const clockFile = process.env.UCAS_MOCK_CLOCK_FILE;
if (clockFile) {
	Date.now = () => Number(readFileSync(clockFile, "utf8"));
}

// Loaded only by test-access.mjs in its isolated server process.
globalThis.fetch = async (input, options) => {
	const requestUrl = new URL(typeof input === "string" ? input : input.url || String(input));
	if (requestUrl.hostname !== "iclass.ucas.edu.cn") return originalFetch(input, options);
	if (requestUrl.pathname.endsWith("login.action")) {
		const loginBody = new URLSearchParams(options.body);
		const username = loginBody.get("phone");
		const accountNames = {
			"202600000000001": "alpha",
			"202600000000002": "beta",
			"202600000000003": "manual",
		};
		const accountName = accountNames[username];
		assert.ok(accountName, "Only synthetic student IDs may be used in tests");
		assert.equal(loginBody.get("password"), "test-shared-student-password");
		return Response.json({ STATUS: "0", result: { id: accountName, sessionId: `session-${accountName}` } });
	}
	if (requestUrl.pathname.endsWith("get_stu_course_sched.action")) {
		const accountName = requestUrl.searchParams.get("id");
		assert.equal(options.headers.sessionId, `session-${accountName}`);
		return Response.json({ STATUS: "0", result: [{
			id: "1234567", uuid: accountName, courseName: accountName,
			classBeginTime: "08:30", classEndTime: "10:10", signStatus: "0",
		}] });
	}
	if (requestUrl.pathname.endsWith("stu_scan_sign.action")) {
		if (process.env.UCAS_MOCK_FORBID_SIGN === "1") throw new Error("Sign submission forbidden in rehearsal test");
		const accountName = requestUrl.searchParams.get("id");
		return Response.json({ STATUS: "0", result: { stuSignId: `mock-${accountName}`, stuSignStatus: "1" } });
	}
	if (requestUrl.pathname.endsWith("get_timestamp.do")) {
		return Response.json({ STATUS: "0", timestamp: Date.now() });
	}
	throw new Error("Unexpected upstream request during access tests");
};
