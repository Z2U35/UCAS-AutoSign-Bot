const LAST_STUDENT_ID_KEY = "ucas-last-student-id-v1";
const STUDENT_ID_PATTERN = /^\d{15}$/;

export function readLastStudentId(): string {
	if (typeof window === "undefined") return "";
	try {
		const savedStudentId = window.localStorage.getItem(LAST_STUDENT_ID_KEY) ?? "";
		return STUDENT_ID_PATTERN.test(savedStudentId) ? savedStudentId : "";
	} catch {
		return "";
	}
}

export function rememberStudentId(studentId: string): void {
	if (typeof window === "undefined") return;
	const normalizedStudentId = studentId.trim();
	try {
		if (!normalizedStudentId) {
			window.localStorage.removeItem(LAST_STUDENT_ID_KEY);
		} else if (STUDENT_ID_PATTERN.test(normalizedStudentId)) {
			// Partial edits must not overwrite the last complete student ID.
			window.localStorage.setItem(LAST_STUDENT_ID_KEY, normalizedStudentId);
		}
	} catch {
		// Blocked or full storage must not prevent manual course queries.
	}
}
