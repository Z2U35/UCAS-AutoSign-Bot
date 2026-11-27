import "server-only";

const LOGIN_URL = "https://iclass.ucas.edu.cn:8181/app/user/login.action";
const SCHEDULE_URL = "https://iclass.ucas.edu.cn:8181/app/course/get_stu_course_sched.action";
const TIMESTAMP_URL = "https://iclass.ucas.edu.cn:8181/app/common/get_timestamp.do";
const SIGN_URL = "https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action";

const LOGIN_UA = "student_5.0.1.2_android_12_20__110000";
const API_UA = "student_5.0.1.2_android_12_20_100000000000000_110000";
export const LOGIN_TIMEOUT_MS = 15000;
export const SCHEDULE_TIMEOUT_MS = 15000;
export const SIGN_TIMEOUT_MS = 10000;
export const TIMESTAMP_TIMEOUT_MS = 6000;

export type IclassSession = {
	userId: string;
	sessionId: string;
};

export type IclassCourse = {
	id: string;
	uuid: string;
	courseName: string;
	teacherName: string;
	weekDay: string;
	classBeginTime: string;
	classEndTime: string;
	signStatus: string;
};

type IclassStage = "login" | "schedule" | "timestamp" | "sign";

export class IclassError extends Error {
	status: number;
	code: string;
	stage: IclassStage;
	retryable: boolean;

	constructor(status: number, code: string, message: string, stage: IclassStage, retryable: boolean) {
		super(message);
		this.name = "IclassError";
		this.status = status;
		this.code = code;
		this.stage = stage;
		this.retryable = retryable;
	}
}

type LoginResponse = {
	STATUS?: string;
	result?: {
		id?: string;
		sessionId?: string;
	};
};

type ScheduleResponse = {
	STATUS?: string;
	result?: Partial<IclassCourse>[];
};

type TimestampResponse = {
	STATUS?: string;
	timestamp?: number;
};

type UpstreamSignResponse = {
	STATUS?: string;
	message?: string;
	msg?: string;
	ERRMSG?: string;
	result?: {
		stuSignId?: string;
		stuSignStatus?: string;
		msg?: string;
	};
};

const REQUEST_ERROR_MESSAGES = {
	login: {
		http: "登录接口HTTP异常",
		badJson: "登录接口返回非JSON",
		timeout: "登录接口请求超时",
		network: "登录接口网络异常",
	},
	schedule: {
		http: "课表接口HTTP异常",
		badJson: "课表接口返回非JSON",
		timeout: "课表接口请求超时",
		network: "课表接口网络异常",
	},
	timestamp: {
		http: "Failed to fetch server timestamp",
		badJson: "Failed to fetch server timestamp",
		timeout: "Failed to fetch server timestamp",
		network: "Failed to fetch server timestamp",
	},
	sign: {
		http: "签到接口HTTP异常",
		badJson: "签到接口返回非JSON",
		timeout: "签到接口请求超时",
		network: "签到接口网络异常",
	},
};

function isTemporaryHttpFailure(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchIclassJson<ResponseData>(
	stage: IclassStage,
	url: string,
	requestInit: RequestInit,
): Promise<ResponseData> {
	const controller = new AbortController();
	const timeoutMs = stage === "timestamp"
		? TIMESTAMP_TIMEOUT_MS
		: stage === "sign"
			? SIGN_TIMEOUT_MS
			: stage === "schedule"
				? SCHEDULE_TIMEOUT_MS
				: LOGIN_TIMEOUT_MS;
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	const messages = REQUEST_ERROR_MESSAGES[stage];
	const codePrefix = `UPSTREAM_${stage.toUpperCase()}`;
	// A failed sign response cannot establish whether the upstream action completed.
	const canRetryRequest = stage !== "sign";

	try {
		const response = await fetch(url, {
			...requestInit,
			cache: "no-store",
			signal: controller.signal,
		});

		// The timestamp endpoint historically uses JSON status, not HTTP status.
		if (!response.ok && stage !== "timestamp") {
			throw new IclassError(
				502,
				`${codePrefix}_HTTP`,
				`${messages.http}: ${response.status}`,
				stage,
				canRetryRequest && isTemporaryHttpFailure(response.status),
			);
		}

		if (stage === "timestamp") {
			clearTimeout(timeoutId);
		}

		try {
			return (await response.json()) as ResponseData;
		} catch {
			throw new IclassError(502, `${codePrefix}_BAD_JSON`, messages.badJson, stage, canRetryRequest);
		}
	} catch (error) {
		if (error instanceof IclassError) {
			throw error;
		}
		if (error instanceof Error && error.name === "AbortError") {
			throw new IclassError(504, `${codePrefix}_TIMEOUT`, messages.timeout, stage, canRetryRequest);
		}
		throw new IclassError(502, `${codePrefix}_NETWORK`, messages.network, stage, canRetryRequest);
	} finally {
		clearTimeout(timeoutId);
	}
}

function buildLoginBody(username: string, password: string): string {
	const verificationUrlTemplate =
		"http://iclass.ucas.edu.cn:88/ve/webservices/mobileCheck.shtml?method=mobileLogin&username=${0}&password=${1}&lx=${2}";

	return new URLSearchParams({
		phone: username,
		password,
		verificationType: "1",
		verificationUrl: verificationUrlTemplate,
		userLevel: "1",
	}).toString();
}

function sanitizeCourse(item: Partial<IclassCourse>): IclassCourse {
	return {
		id: item.id ?? "",
		uuid: item.uuid ?? "",
		courseName: item.courseName ?? "",
		teacherName: item.teacherName ?? "",
		weekDay: item.weekDay ?? "",
		classBeginTime: item.classBeginTime ?? "",
		classEndTime: item.classEndTime ?? "",
		signStatus: item.signStatus ?? "",
	};
}

export async function loginIclass(username: string, password: string): Promise<IclassSession> {
	const loginData = await fetchIclassJson<LoginResponse>("login", LOGIN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": LOGIN_UA,
		},
		body: buildLoginBody(username, password),
	});

	const sessionId = loginData?.result?.sessionId;
	const userId = loginData?.result?.id;
	if (loginData?.STATUS !== "0" || !sessionId || !userId) {
		throw new IclassError(
			401,
			"UPSTREAM_LOGIN_REJECTED",
			"登录失败，请确认学号正确，或联系管理员检查服务端统一密码",
			"login",
			loginData?.STATUS === undefined || loginData.STATUS === "0",
		);
	}

	return { userId, sessionId };
}

export async function queryIclassSchedule(session: IclassSession, date: string): Promise<IclassCourse[]> {
	const scheduleUrl = `${SCHEDULE_URL}?id=${encodeURIComponent(session.userId)}&dateStr=${encodeURIComponent(date)}`;
	const scheduleData = await fetchIclassJson<ScheduleResponse>("schedule", scheduleUrl, {
		method: "GET",
		headers: {
			sessionId: session.sessionId,
			"User-Agent": API_UA,
		},
	});

	if (scheduleData?.STATUS !== "0") {
		throw new IclassError(
			502,
			"UPSTREAM_SCHEDULE_REJECTED",
			"课表查询失败，或当天无课程",
			"schedule",
			scheduleData?.STATUS === undefined,
		);
	}

	return (scheduleData.result ?? []).map(sanitizeCourse);
}

export async function getIclassTimestamp(): Promise<number> {
	// Keep the random query parameter to bypass intermediate caches.
	const timestampUrl = `${TIMESTAMP_URL}?id=${Math.floor(Math.random() * 1000000)}`;
	const timestampData = await fetchIclassJson<TimestampResponse | null>("timestamp", timestampUrl, {
		method: "POST",
		headers: {
			"User-Agent": API_UA,
			Connection: "Keep-Alive",
		},
	});

	if (timestampData === null) {
		throw new IclassError(502, "UPSTREAM_TIMESTAMP_BAD_RESPONSE", "Failed to fetch server timestamp", "timestamp", true);
	}

	if (timestampData.STATUS !== "0" || typeof timestampData.timestamp !== "number") {
		throw new IclassError(
			502,
			"UPSTREAM_TIMESTAMP_INVALID_RESPONSE",
			"Invalid server response",
			"timestamp",
			timestampData.STATUS === undefined || timestampData.STATUS === "0",
		);
	}

	return timestampData.timestamp;
}

export async function submitIclassSign(
	session: IclassSession,
	courseSchedId: string,
	timestamp: number,
): Promise<{
	success: boolean;
	message: string;
	upstreamStatus: string;
	result: { stuSignId: string; stuSignStatus: string };
	status: number;
}> {
	const signUrl = `${SIGN_URL}?courseSchedId=${encodeURIComponent(courseSchedId)}&timestamp=${timestamp}&id=${encodeURIComponent(session.userId)}`;
	const signData = await fetchIclassJson<UpstreamSignResponse>("sign", signUrl, {
		method: "GET",
		headers: {
			sessionId: session.sessionId,
			"User-Agent": API_UA,
		},
	});

	const upstreamStatus = signData?.STATUS ?? "";
	const stuSignId = signData?.result?.stuSignId ?? "";
	const stuSignStatus = signData?.result?.stuSignStatus ?? "";
	const upstreamMessage = signData?.result?.msg ?? signData?.ERRMSG ?? signData?.msg ?? signData?.message ?? "";
	const result = { stuSignId, stuSignStatus };

	if (upstreamStatus === "0" && stuSignStatus === "1") {
		return { success: true, message: "签到成功", upstreamStatus, result, status: 200 };
	}

	if (upstreamStatus === "0" && stuSignStatus && stuSignStatus !== "1") {
		return { success: false, message: "签到请求已提交，但状态未完成", upstreamStatus, result, status: 409 };
	}

	return {
		success: false,
		message: upstreamMessage || "签到失败，请稍后重试",
		upstreamStatus,
		result,
		status: 400,
	};
}
