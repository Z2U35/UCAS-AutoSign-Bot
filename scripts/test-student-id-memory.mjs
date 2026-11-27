import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readLastStudentId, rememberStudentId } from "../src/lib/student-id-memory.ts";

const storageKey = "ucas-last-student-id-v1";
const firstStudentId = "202600000000001";
const secondStudentId = "202600000000002";
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
	if (originalWindowDescriptor) {
		Object.defineProperty(globalThis, "window", originalWindowDescriptor);
	} else {
		delete globalThis.window;
	}
});

function installBrowser(browser) {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		writable: true,
		value: browser,
	});
}

function createBrowser(initialEntries = []) {
	const values = new Map(initialEntries);
	const mutations = [];
	const localStorage = {
		getItem(key) {
			return values.get(key) ?? null;
		},
		setItem(key, value) {
			mutations.push({ operation: "set", key, value });
			values.set(key, value);
		},
		removeItem(key) {
			mutations.push({ operation: "remove", key });
			values.delete(key);
		},
	};
	return { localStorage, values, mutations };
}

test("SSR reads empty and ignores writes without a window", () => {
	delete globalThis.window;
	assert.equal(readLastStudentId(), "");
	assert.doesNotThrow(() => rememberStudentId(firstStudentId));
	assert.doesNotThrow(() => rememberStudentId(""));
	assert.equal(Object.hasOwn(globalThis, "window"), false);

	installBrowser(undefined);
	assert.equal(readLastStudentId(), "");
	assert.doesNotThrow(() => rememberStudentId(firstStudentId));
});

test("restores a saved ID without modifying storage", () => {
	const browser = createBrowser([[storageKey, firstStudentId]]);
	installBrowser(browser);
	assert.equal(readLastStudentId(), firstStudentId);

	installBrowser({ localStorage: browser.localStorage });
	assert.equal(readLastStudentId(), firstStudentId);
	assert.deepEqual(browser.mutations, []);
});

test("independent browsers do not share remembered IDs", () => {
	const firstBrowser = createBrowser();
	const secondBrowser = createBrowser();
	installBrowser(firstBrowser);
	assert.equal(readLastStudentId(), "");
	rememberStudentId(firstStudentId);

	installBrowser(secondBrowser);
	assert.equal(readLastStudentId(), "");
	rememberStudentId(secondStudentId);
	assert.equal(readLastStudentId(), secondStudentId);

	installBrowser(firstBrowser);
	assert.equal(readLastStudentId(), firstStudentId);
});

test("reads only exactly 15 ASCII digits, retaining leading zeros", () => {
	const browser = createBrowser();
	installBrowser(browser);
	assert.equal(readLastStudentId(), "");
	for (const invalidValue of [
		"", "20260000000000", "2026000000000011", "20260000000000a",
		` ${firstStudentId}`, `${firstStudentId} `, `${firstStudentId}\n`,
		`${firstStudentId}\r`, `${firstStudentId}\u2028`, `${firstStudentId}\u2029`,
		"\uff12".repeat(15), JSON.stringify({ studentId: firstStudentId }),
	]) {
		browser.values.set(storageKey, invalidValue);
		assert.equal(readLastStudentId(), "", `Must reject stored ${JSON.stringify(invalidValue)}`);
	}
	const studentIdWithLeadingZeros = "000000000000001";
	browser.values.set(storageKey, studentIdWithLeadingZeros);
	assert.equal(readLastStudentId(), studentIdWithLeadingZeros);
	assert.deepEqual(browser.mutations, []);
});

test("valid edits update only the student ID key; partial and invalid edits preserve it", () => {
	const unrelatedEntries = [["ucas-theme-mode", "dark"], ["unrelated-setting", "unchanged"]];
	const browser = createBrowser(unrelatedEntries);
	installBrowser(browser);
	rememberStudentId(` \t${firstStudentId}\n `);
	assert.equal(readLastStudentId(), firstStudentId);
	rememberStudentId(secondStudentId);
	assert.equal(readLastStudentId(), secondStudentId);

	for (const invalidValue of [
		"2", "20260000000000", "2026000000000011", "20260000000000a",
		"2026000 00000001", "+20260000000001", "\uff12".repeat(15),
		"never-store-this-password", JSON.stringify({ password: "not-a-student-id" }),
	]) {
		rememberStudentId(invalidValue);
		assert.equal(readLastStudentId(), secondStudentId);
	}
	const studentIdWithLeadingZeros = "000000000000001";
	rememberStudentId(studentIdWithLeadingZeros);
	assert.equal(readLastStudentId(), studentIdWithLeadingZeros);
	assert.deepEqual(browser.mutations, [
		{ operation: "set", key: storageKey, value: firstStudentId },
		{ operation: "set", key: storageKey, value: secondStudentId },
		{ operation: "set", key: storageKey, value: studentIdWithLeadingZeros },
	]);
	assert.deepEqual([...browser.values], [...unrelatedEntries, [storageKey, studentIdWithLeadingZeros]]);
});

test("clearing empty or whitespace-only input removes only the saved ID", () => {
	const browser = createBrowser([["ucas-theme-mode", "dark"]]);
	installBrowser(browser);
	for (const emptyInput of ["", " \t\n "]) {
		browser.values.set(storageKey, firstStudentId);
		rememberStudentId(emptyInput);
		assert.equal(readLastStudentId(), "");
		assert.equal(browser.values.has(storageKey), false);
		assert.deepEqual([...browser.values], [["ucas-theme-mode", "dark"]]);
	}
	assert.deepEqual(browser.mutations, [
		{ operation: "remove", key: storageKey },
		{ operation: "remove", key: storageKey },
	]);
});

for (const deniedMethod of ["getItem", "setItem", "removeItem"]) {
	test(`swallows localStorage.${deniedMethod} errors`, () => {
		const browser = createBrowser([[storageKey, firstStudentId]]);
		browser.localStorage[deniedMethod] = () => {
			throw new Error(`Storage ${deniedMethod} denied`);
		};
		installBrowser(browser);
		if (deniedMethod === "getItem") {
			assert.equal(readLastStudentId(), "");
		} else {
			assert.doesNotThrow(() => rememberStudentId(deniedMethod === "setItem" ? secondStudentId : ""));
			assert.equal(readLastStudentId(), firstStudentId);
		}
		assert.deepEqual(browser.mutations, []);
	});
}

test("swallows a denied localStorage getter for reads, writes, and clears", () => {
	installBrowser({
		get localStorage() {
			throw new Error("Access to localStorage denied");
		},
	});
	assert.equal(readLastStudentId(), "");
	assert.doesNotThrow(() => rememberStudentId(firstStudentId));
	assert.doesNotThrow(() => rememberStudentId(""));
	assert.doesNotThrow(() => rememberStudentId("partial"));
});
