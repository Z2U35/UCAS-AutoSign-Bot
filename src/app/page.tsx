"use client";

import { FormEvent, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { readLastStudentId, rememberStudentId } from "@/lib/student-id-memory";
import CourseWorkspace, { type CourseItem, type FeatureMode } from "./components/course-workspace";
import type { StatusKind } from "./components/editorial-ui";
import { useAutoSign } from "./components/use-auto-sign";

type QueryResponse = {
	date: string;
	total: number;
	courses: CourseItem[];
};

type DirectSignResponse = {
	success?: boolean;
	message?: string;
	upstreamStatus?: string;
	result?: {
		stuSignId?: string;
		stuSignStatus?: string;
	};
};

const AUTO_QR_TTL_MS = 5 * 1000;
const DOWNLOAD_QR_TTL_MS = 10 * 1000;
// UCAS 的 get_timestamp.do 与 stu_scan_sign.action 运行在不同服务器上，
// 两者时钟偏差约 3.5s。校准对齐了 timestamp API，需要减去缓冲才能被 sign API 接受。
const SIGN_TIMESTAMP_BUFFER_MS = 3 * 1000;

const ACTION_STATUS_DEFAULT_TEXT = "生成签到码后，可在此查看下载、复制和点击签到的状态信息";
const SIGN_BASE_URL = "https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action";

type QrSource =
	| {
			mode: "query";
			uuid: string;
			courseId: string;
	  }
	| {
			mode: "manual";
			identifier: string;
	  };

function toYyyyMMdd(dateInput: string): string {
	return dateInput.replace(/-/g, "");
}

function getTodayInputDate(): string {
	const now = new Date();
	const offset = now.getTimezoneOffset() * 60000;
	return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function buildSignInUrl(courseId: string, expiresAt: number): string {
	return `${SIGN_BASE_URL}?courseSchedId=${encodeURIComponent(courseId)}&timestamp=${expiresAt}`;
}

function buildManualSignInUrl(identifier: string, expiresAt: number): string | null {
	const raw = identifier.trim();
	if (!raw) {
		return null;
	}

	if (/^\d+$/.test(raw)) {
		return `${SIGN_BASE_URL}?courseSchedId=${encodeURIComponent(raw)}&timestamp=${expiresAt}`;
	}

	const compact = raw.replace(/-/g, "");
	if (/^[0-9a-fA-F]{32}$/.test(compact)) {
		return `${SIGN_BASE_URL}?timeTableId=${encodeURIComponent(compact.toUpperCase())}&timestamp=${expiresAt}`;
	}

	return null;
}

function getSignIdentifierForFilename(signUrl: string, selectedUuid: string): string {
	if (!signUrl) {
		return selectedUuid || "unknown";
	}

	try {
		const url = new URL(signUrl);
		const courseSchedId = url.searchParams.get("courseSchedId");
		if (courseSchedId) {
			return courseSchedId;
		}

		const timeTableId = url.searchParams.get("timeTableId");
		if (timeTableId) {
			return timeTableId;
		}

		return selectedUuid || "unknown";
	} catch {
		return selectedUuid || "unknown";
	}
}

function extractClockTime(value: string): string | null {
	if (!value) {
		return null;
	}
	const timeMatch = value.match(/(\d{2}:\d{2}(?::\d{2})?)$/);
	if (!timeMatch) {
		return null;
	}
	return timeMatch[1].length === 5 ? `${timeMatch[1]}:00` : timeMatch[1];
}

function buildDateTimeFromClock(dateInput: string, clockTime: string | null): Date | null {
	if (!clockTime) {
		return null;
	}

	const parsed = new Date(`${dateInput}T${clockTime}`);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return parsed;
}

export default function Home() {
	const [students, setStudents] = useState<{ id: string; name: string }[]>([]);
	const [accountId, setAccountId] = useState("");
	const [logoutPending, setLogoutPending] = useState(false);
	const [featureMode, setFeatureMode] = useState<FeatureMode>("query");
	const [studentId, setStudentId] = useState("");
	const credentialPayload = accountId ? { accountId } : { studentId: studentId.trim() };
	const [date, setDate] = useState(getTodayInputDate);
	const [keyword, setKeyword] = useState("");
	const [manualIdentifier, setManualIdentifier] = useState("");
	const [courses, setCourses] = useState<CourseItem[]>([]);
	const [courseQueryContext, setCourseQueryContext] = useState<{ accountId: string; date: string; version: number } | null>(null);
	const courseQueryVersionRef = useRef(0);
	const [selectedUuid, setSelectedUuid] = useState("");
	const [statusText, setStatusText] = useState("选择快捷账号或输入学号，即可查询今天的课程");
	const [statusKind, setStatusKind] = useState<StatusKind>("idle");
	const [actionStatusText, setActionStatusText] = useState(ACTION_STATUS_DEFAULT_TEXT);
	const [actionStatusKind, setActionStatusKind] = useState<StatusKind>("idle");
	const [loading, setLoading] = useState(false);
	const [manualLoading, setManualLoading] = useState(false);
	const [directSignLoading, setDirectSignLoading] = useState(false);
	const [signUrl, setSignUrl] = useState("");
	const [qrDataUrl, setQrDataUrl] = useState("");
	const [expireAt, setExpireAt] = useState(0);
	const [expireCountdown, setExpireCountdown] = useState(0);
	const [qrRelayActive, setQrRelayActive] = useState(false);
	const [qrSource, setQrSource] = useState<QrSource | null>(null);
	const qrSectionRef = useRef<HTMLDivElement | null>(null);

	const updateStatus = (kind: StatusKind, message: string) => {
		setStatusKind(kind);
		setStatusText(message);
	};

	const updateActionStatus = (kind: StatusKind, message: string) => {
		setActionStatusKind(kind);
		setActionStatusText(message);
	};

	const timeOffsetRef = useRef<{ offset: number; fetchedAt: number } | null>(null);
	const OFFSET_TTL_MS = 30 * 1000;

	const getServerTimeOffset = async (): Promise<number> => {
		const cached = timeOffsetRef.current;
		if (cached && Date.now() - cached.fetchedAt < OFFSET_TTL_MS) {
			return cached.offset;
		}

		try {
			const start = Date.now();
			const res = await fetch("/api/course-uuid/timestamp", {
				cache: "no-store"
			});
			if (!res.ok) {
				throw new Error();
			}
			const data = await res.json();
			if (data.success && typeof data.timestamp === "number") {
				const latency = Math.max(0, Date.now() - start);
				const serverTime = data.timestamp + Math.floor(latency / 2);
				const offset = serverTime - Date.now();
				timeOffsetRef.current = { offset, fetchedAt: Date.now() };
				return offset;
			}
		} catch {}

		// 校准失败：优先用过期的缓存降级
		if (cached) return cached.offset;
		timeOffsetRef.current = { offset: 0, fetchedAt: Date.now() };
		return 0;
	};

	useEffect(() => {
		void getServerTimeOffset();
	}, []);

	useEffect(() => {
		// Restore after hydration so the server and first client render agree.
		const savedStudentId = readLastStudentId();
		setStudentId((currentStudentId) => currentStudentId || savedStudentId);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void fetch("/api/access/accounts", { cache: "no-store", signal: controller.signal })
			.then(async (response) => {
				if (response.status === 401) {
					window.location.replace("/");
					return;
				}
				if (!response.ok) throw new Error();
				const data = await response.json();
				setStudents(data.students);
			})
			.catch(() => {
				if (!controller.signal.aborted) updateStatus("error", "快捷账号加载失败，请检查服务器配置并刷新页面");
			});
		return () => controller.abort();
	}, []);

	const fetchProtected = useCallback(async (url: string, init: RequestInit) => {
		const response = await fetch(url, init);
		if (response.status === 401) {
			const data = await response.clone().json();
			if (data.code === "ACCESS_REQUIRED") window.location.replace("/");
		}
		return response;
	}, []);

	const autoSign = useAutoSign(fetchProtected);

	const resetGeneratedSignState = () => {
		setSelectedUuid("");
		setSignUrl("");
		setQrDataUrl("");
		setExpireAt(0);
		setExpireCountdown(0);
		setQrRelayActive(false);
		setQrSource(null);
		setActionStatusKind("idle");
		setActionStatusText(ACTION_STATUS_DEFAULT_TEXT);
	};

	const resetCourseQuery = () => {
		courseQueryVersionRef.current += 1;
		setCourseQueryContext(null);
		setLoading(false);
		autoSign.dismissPreview();
		setCourses([]);
		setKeyword("");
		resetGeneratedSignState();
		updateStatus("idle", "查询条件已更新，请重新查询课程");
	};

	const selectAccount = (selectedAccountId: string) => {
		setAccountId(selectedAccountId);
		resetCourseQuery();
	};

	const updateStudentId = (nextStudentId: string) => {
		setStudentId(nextStudentId);
		rememberStudentId(nextStudentId);
		resetCourseQuery();
	};

	const getPayloadFromSource = (source: QrSource, deadline: number): string | null => {
		if (source.mode === "query") {
			return buildSignInUrl(source.courseId, deadline);
		}
		return buildManualSignInUrl(source.identifier, deadline);
	};

	const generateQrDataUrlFromPayload = async (payload: string): Promise<string> => {
		const { default: QRCode } = await import("qrcode");
		return QRCode.toDataURL(payload, {
			width: 320,
			margin: 1,
			errorCorrectionLevel: "M"
		});
	};

	const regenerateAutoQr = async (source: QrSource): Promise<boolean> => {
		const offset = await getServerTimeOffset();
		const currentTimestamp = Date.now() + offset;
		// 签到时间戳减去缓冲，弥补 UCAS 两台服务器间的时钟偏差
		const signTimestamp = currentTimestamp - SIGN_TIMESTAMP_BUFFER_MS;
		const payload = getPayloadFromSource(source, signTimestamp);
		if (!payload) {
			setQrDataUrl("");
			setSignUrl("");
			setExpireAt(0);
			setExpireCountdown(0);
			return false;
		}

		try {
			const imageUrl = await generateQrDataUrlFromPayload(payload);
			setSignUrl(payload);
			setExpireAt(currentTimestamp + AUTO_QR_TTL_MS);
			setQrDataUrl(imageUrl);
			return true;
		} catch {
			setQrDataUrl("");
			setSignUrl("");
			setExpireAt(0);
			setExpireCountdown(0);
			return false;
		}
	};

	useEffect(() => {
		if (!expireAt) {
			setExpireCountdown(0);
			return;
		}

		const updateCountdown = () => {
			const remainMs = expireAt - (Date.now() + (timeOffsetRef.current?.offset ?? 0));
			setExpireCountdown(Math.max(0, Math.ceil(remainMs / 1000)));
		};

		updateCountdown();
		const timer = window.setInterval(updateCountdown, 250);

		return () => {
			window.clearInterval(timer);
		};
	}, [expireAt]);

	useEffect(() => {
		if (!qrSource || !expireAt) {
			return;
		}

		const delay = Math.max(0, expireAt - (Date.now() + (timeOffsetRef.current?.offset ?? 0)));
		const timer = window.setTimeout(async () => {
			const ok = await regenerateAutoQr(qrSource);
			if (!ok) {
				if (qrSource.mode === "query") {
					updateActionStatus("error", "签到码自动刷新失败，请重新选择课程");
				} else {
					updateStatus("error", "签到码自动刷新失败，请重新生成");
				}
			}
		}, delay);

		return () => {
			window.clearTimeout(timer);
		};
	}, [qrSource, expireAt]);

	const deferredKeyword = useDeferredValue(keyword);

	const filteredCourses = useMemo(() => {
		const word = deferredKeyword.trim().toLowerCase();
		if (!word) {
			return courses;
		}
		return courses.filter((item) => {
			return item.courseName.toLowerCase().includes(word) || item.teacherName.toLowerCase().includes(word);
		});
	}, [courses, deferredKeyword]);

	const hasQr = Boolean(qrDataUrl);
	const autoSignContextMatches = Boolean(accountId && courseQueryContext?.accountId === accountId && courseQueryContext.date === date);
	const queryAttempted = statusKind !== "idle";
	const hasKeyword = keyword.trim().length > 0;
	const emptyHelpText = hasKeyword ? "试试其他关键词，或清空筛选查看全部课程" : "请检查学号与查询日期，非上课日可能没有课程";

	const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!accountId) rememberStudentId(studentId);
		const requestedContext = { accountId, date };
		resetCourseQuery();
		const requestVersion = courseQueryVersionRef.current;
		setLoading(true);
		updateStatus("loading", "正在查询课程…");

		try {
			const res = await fetchProtected("/api/course-uuid/query", {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					...credentialPayload,
					date: toYyyyMMdd(date)
				})
			});

			const data = (await res.json()) as QueryResponse & { message?: string };
			// Never attach an older account's courses to newly selected query conditions.
			if (requestVersion !== courseQueryVersionRef.current) return;

			if (!res.ok) {
				setCourses([]);
				updateStatus("error", data.message ?? "查询失败，请重试");
				return;
			}

			setCourses(data.courses ?? []);
			setCourseQueryContext({ ...requestedContext, version: requestVersion });
			updateStatus("success", `已查询到 ${data.total} 门课程（${data.date}）`);
		} catch {
			if (requestVersion !== courseQueryVersionRef.current) return;
			setCourses([]);
			updateStatus("error", "网络异常，请稍后重试");
		} finally {
			if (requestVersion === courseQueryVersionRef.current) setLoading(false);
		}
	};

	const onScheduleAutoSign = (courseId: string) => {
		if (featureMode !== "query" || loading || !autoSignContextMatches || !courseQueryContext) return;
		if (courseQueryContext.version !== courseQueryVersionRef.current) return;
		if (!courses.some((course) => course.id === courseId)) return;
		void autoSign.requestPreview(courseQueryContext.accountId, courseQueryContext.date, courseId);
	};

	const onPick = async (uuid: string, courseId: string) => {
		setSelectedUuid(uuid);
		const source: QrSource = { mode: "query", uuid, courseId };
		setQrSource(source);

		const ok = await regenerateAutoQr(source);
		if (!ok) {
			updateActionStatus("error", "签到码生成失败，请重新选择课程");
			return;
		}

		updateActionStatus("success", "签到码已生成（5秒后自动刷新）");

		if (window.matchMedia("(max-width: 1023px)").matches) {
			setQrRelayActive(true);
			window.setTimeout(() => setQrRelayActive(false), 1200);
			window.requestAnimationFrame(() => {
				qrSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
			updateActionStatus("info", "已生成签到码");
		}
	};

	const onManualGenerate = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const source: QrSource = { mode: "manual", identifier: manualIdentifier };
		const payload = getPayloadFromSource(source, Date.now() + (timeOffsetRef.current?.offset ?? 0));

		if (!payload) {
			updateStatus("error", "请输入纯数字课程ID或32位UUID");
			return;
		}

		setManualLoading(true);
		setSelectedUuid("");
		setQrSource(source);

		let ok = false;
		try {
			ok = await regenerateAutoQr(source);
		} finally {
			setManualLoading(false);
		}

		if (!ok) {
			updateStatus("error", "签到码生成失败，请检查课程ID或UUID后重试");
			return;
		}

		updateStatus("success", "签到码已生成（5秒后自动刷新）");

		if (window.matchMedia("(max-width: 1023px)").matches) {
			setQrRelayActive(true);
			window.setTimeout(() => setQrRelayActive(false), 1200);
			window.requestAnimationFrame(() => {
				qrSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		}
	};

	const onDownloadQr = async () => {
		if (!qrSource) {
			return;
		}

		const offset = await getServerTimeOffset();
		const deadline = Date.now() + offset + DOWNLOAD_QR_TTL_MS;
		const payload = getPayloadFromSource(qrSource, deadline);
		if (!payload) {
			if (featureMode === "query") {
				updateActionStatus("error", "下载二维码失败，请重新生成签到码");
				return;
			}
			updateStatus("error", "下载二维码失败，请重新生成签到码");
			return;
		}

		try {
			const imageUrl = await generateQrDataUrlFromPayload(payload);
			const link = document.createElement("a");
			link.href = imageUrl;
			const safeIdentifier = getSignIdentifierForFilename(payload, selectedUuid);
			link.download = `ucas-signin-${safeIdentifier}-${deadline}.png`;
			link.click();
			if (featureMode === "query") {
				updateActionStatus("success", "二维码已开始下载（10秒有效）");
				return;
			}
			updateStatus("success", "二维码已开始下载（10秒有效）");
		} catch {
			if (featureMode === "query") {
				updateActionStatus("error", "下载二维码失败，请稍后重试");
				return;
			}
			updateStatus("error", "下载二维码失败，请稍后重试");
		}
	};

	const onCopySignUrl = async () => {
		if (!signUrl) {
			return;
		}

		try {
			await navigator.clipboard.writeText(signUrl);
			if (featureMode === "query") {
				updateActionStatus("info", "已复制签到链接");
				return;
			}
			updateStatus("info", "已复制签到链接");
		} catch {
			if (featureMode === "query") {
				updateActionStatus("error", "复制签到链接失败，请手动复制");
				return;
			}
			updateStatus("error", "复制签到链接失败，请手动复制");
		}
	};

	const refreshCoursesAfterSign = async (): Promise<{ ok: true; total: number } | { ok: false }> => {
		const requestVersion = courseQueryVersionRef.current;
		try {
			const res = await fetchProtected("/api/course-uuid/query", {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					...credentialPayload,
					date: toYyyyMMdd(date)
				})
			});

			const data = (await res.json()) as QueryResponse & { message?: string };
			if (!res.ok || requestVersion !== courseQueryVersionRef.current) {
				return { ok: false };
			}

			setCourses(data.courses ?? []);
			return { ok: true, total: data.total ?? (data.courses ?? []).length };
		} catch {
			return { ok: false };
		}
	};

	const onDirectSign = async () => {
		if (directSignBlockedByTime) {
			updateActionStatus("error", "当前不在签到时间（开课前30分钟至下课前可签到）");
			return;
		}

		const courseSchedId =
			selectedCourse?.id ||
			(() => {
				try {
					const url = new URL(signUrl);
					return url.searchParams.get("courseSchedId") ?? url.searchParams.get("timeTableId") ?? "";
				} catch {
					return "";
				}
			})();

		if (!courseSchedId) {
			updateActionStatus("error", "请先在查询课程模式选择课程并生成签到码");
			return;
		}

		if (!accountId && !/^\d{15}$/.test(studentId.trim())) {
			updateActionStatus("error", "请先输入15位学号并查询课程");
			return;
		}

		setDirectSignLoading(true);
		updateActionStatus("loading", "正在发起签到…");

		try {
			// 优先从当前二维码URL中提取时间戳，与扫码行为完全一致
			let signTimestamp = 0;
			try {
				const url = new URL(signUrl);
				const ts = url.searchParams.get("timestamp");
				if (ts) signTimestamp = Number(ts);
			} catch {}
			// 降级：使用校准后的当前时间戳（减去缓冲）
			if (!signTimestamp || !Number.isFinite(signTimestamp)) {
				const offset = await getServerTimeOffset();
				signTimestamp = Date.now() + offset - SIGN_TIMESTAMP_BUFFER_MS;
			}

			const res = await fetchProtected("/api/course-uuid/sign", {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					...credentialPayload,
					courseSchedId,
					timestamp: signTimestamp
				})
			});

			const data = (await res.json()) as DirectSignResponse;

			if (!res.ok || !data.success) {
				updateActionStatus("error", data.message ?? "签到失败，请稍后重试");
				return;
			}

			const signIdText = data.result?.stuSignId ? `（签到记录 ${data.result.stuSignId}）` : "";
			const refreshed = await refreshCoursesAfterSign();
			if (refreshed.ok) {
				updateActionStatus("success", `${data.message ?? "签到成功"}${signIdText}，课程状态已刷新`);
			} else {
				updateActionStatus(
					"info",
					`${data.message ?? "签到成功"}${signIdText}，但课程状态刷新失败，请手动查询`
				);
			}
		} catch {
			updateActionStatus("error", "网络异常，签到请求未完成");
		} finally {
			setDirectSignLoading(false);
		}
	};

	const selectedCourse = useMemo(() => {
		if (!selectedUuid) {
			return null;
		}
		return courses.find((item) => item.uuid === selectedUuid) ?? null;
	}, [courses, selectedUuid]);

	const now = Date.now() + (timeOffsetRef.current?.offset ?? 0);

	const signWindow = useMemo(() => {
		if (!selectedCourse) {
			return null;
		}

		const classBegin = buildDateTimeFromClock(date, extractClockTime(selectedCourse.classBeginTime));
		const classEnd = buildDateTimeFromClock(date, extractClockTime(selectedCourse.classEndTime));
		if (!classBegin || !classEnd) {
			return null;
		}

		const openAt = new Date(classBegin.getTime() - 30 * 60 * 1000);
		return {
			openAt: openAt.getTime(),
			closeAt: classEnd.getTime()
		};
	}, [selectedCourse, date]);

	const directSignBlockedByTime = Boolean(
		selectedCourse && (!signWindow || now < signWindow.openAt || now > signWindow.closeAt)
	);

	const directSignDisabled = loading || directSignLoading || !hasQr || !selectedUuid || directSignBlockedByTime;

	const directSignButtonText = directSignLoading
		? "签到中..."
		: directSignBlockedByTime
			? "不在签到时间"
			: "点击签到";

	const changeFeatureMode = (mode: FeatureMode) => {
		autoSign.dismissPreview();
		resetGeneratedSignState();
		setFeatureMode(mode);
		updateStatus("idle", mode === "query"
			? "选择快捷账号或输入学号，即可查询课程"
			: "输入课程ID或UUID，直接生成签到码");
	};

	const logout = async () => {
		setLogoutPending(true);
		try {
			const response = await fetch("/api/access/logout", { method: "POST" });
			if (!response.ok) throw new Error();
			window.location.replace("/");
		} catch {
			updateStatus("error", "退出失败，请检查网络后重试");
			setLogoutPending(false);
		}
	};

	return (
		<CourseWorkspace
			mode={featureMode}
			autoSign={autoSign}
			query={{
				students, accountId, studentId, date, keyword,
				courses: filteredCourses, total: courses.length, selectedUuid, loading,
				attempted: queryAttempted, emptyHelp: emptyHelpText, statusKind, statusText, autoSignContextMatches,
			}}
			manualIdentifier={manualIdentifier}
			manualLoading={manualLoading}
			busy={loading || directSignLoading || manualLoading}
			logoutPending={logoutPending}
			signCode={{
				sectionRef: qrSectionRef,
				imageUrl: qrDataUrl,
				signUrl,
				countdown: expireCountdown,
				highlighted: qrRelayActive,
				courseName: featureMode === "query" ? selectedCourse?.courseName : undefined,
				statusKind: featureMode === "query" ? actionStatusKind : statusKind,
				statusText: featureMode === "query" ? actionStatusText : statusText,
				directSign: featureMode === "query" ? {
					disabled: directSignDisabled, label: directSignButtonText, onClick: onDirectSign,
				} : undefined,
				onDownload: onDownloadQr,
				onCopy: onCopySignUrl,
			}}
			onModeChange={changeFeatureMode}
			onSelectAccount={selectAccount}
			onStudentIdChange={updateStudentId}
			onDateChange={(nextDate) => {
				setDate(nextDate);
				resetCourseQuery();
			}}
			onKeywordChange={setKeyword}
			onManualIdentifierChange={(identifier) => {
				setManualIdentifier(identifier);
				resetGeneratedSignState();
			}}
			onQuery={onSubmit}
			onManualGenerate={onManualGenerate}
			onPickCourse={onPick}
			onScheduleAutoSign={onScheduleAutoSign}
			onLogout={logout}
		/>
	);
}
