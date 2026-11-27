"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Eye, EyeOff, LockKeyhole } from "lucide-react";
import RecipeLanding from "./components/recipe-landing";
import styles from "./components/recipe-landing.module.css";

const ACCESS_ERROR_MESSAGES: Record<string, string> = {
	400: "提交内容无效，请重新输入访问密码。",
	401: "访问密码不正确，请重试。",
	413: "提交内容过长，请重新输入访问密码。",
	429: "尝试次数过多，请稍后重试。",
	503: "访问配置暂不可用，请联系管理员。",
};

export default function AccessGate() {
	const searchParams = useSearchParams();
	const [pending, setPending] = useState(false);
	const [passwordVisible, setPasswordVisible] = useState(false);
	const [passwordEdited, setPasswordEdited] = useState(false);
	const errorStatus = searchParams.get("accessError") ?? "";
	const message =
		!passwordEdited && !pending && Object.hasOwn(ACCESS_ERROR_MESSAGES, errorStatus)
			? ACCESS_ERROR_MESSAGES[errorStatus]
			: undefined;
	const passwordInvalid = Boolean(message && errorStatus === "401");

	useEffect(() => {
		// Back navigation can restore the form with its pre-navigation pending state.
		function resetPending() {
			setPending(false);
		}
		window.addEventListener("pageshow", resetPending);
		return () => window.removeEventListener("pageshow", resetPending);
	}, []);

	useEffect(() => {
		if (Object.hasOwn(ACCESS_ERROR_MESSAGES, errorStatus)) {
			document.getElementById("private-kitchen")?.scrollIntoView({ block: "center" });
		}
	}, [errorStatus]);

	function unlockSystem(event: FormEvent<HTMLFormElement>) {
		if (pending) {
			event.preventDefault();
			return;
		}
		// Keep the native POST and server redirect visible to password managers.
		setPending(true);
	}

	return (
		<RecipeLanding
			accessForm={
				<form
					id="private-kitchen"
					method="post"
					action="/api/access/login"
					encType="application/x-www-form-urlencoded"
					autoComplete="on"
					onSubmit={unlockSystem}
					className={styles.accessForm}
					aria-labelledby="access-form-title"
					aria-busy={pending}
				>
					<input type="hidden" name="username" autoComplete="username" value="ucas-workspace" />
					<h2 id="access-form-title" className={styles.accessFormHeading}>
						<LockKeyhole size={17} aria-hidden="true" /> 私房厨房
					</h2>
					<p className={styles.accessDescription}>
						留一处自己的小天地。
						<br />
						输入访问密码，打开私人空间。
					</p>
					<label htmlFor="access-password" className={styles.passwordLabel}>
						访问密码
					</label>
					<div className={styles.passwordControl}>
						<input
							id="access-password"
							type={passwordVisible ? "text" : "password"}
							name="accessPassword"
							autoComplete="current-password"
							placeholder="请输入访问密码"
							required
							maxLength={256}
							aria-invalid={passwordInvalid || undefined}
							onInput={() => setPasswordEdited(true)}
							aria-describedby={
								message ? "access-password-help access-error" : "access-password-help"
							}
							className={styles.passwordInput}
						/>
						<button
							type="button"
							className={styles.passwordToggle}
							aria-label={passwordVisible ? "隐藏访问密码" : "显示访问密码"}
							title={passwordVisible ? "隐藏访问密码" : "显示访问密码"}
							aria-controls="access-password"
							disabled={pending}
							onClick={() => setPasswordVisible(!passwordVisible)}
						>
							{passwordVisible ? (
								<EyeOff aria-hidden="true" size={18} />
							) : (
								<Eye aria-hidden="true" size={18} />
							)}
						</button>
					</div>
					<p id="access-password-help" className={styles.passwordHelp}>
						支持浏览器保存与自动填充。
						<br />
						仅建议在个人设备上保存密码。
					</p>
					{message && (
						<p id="access-error" role="alert" className={styles.accessError}>
							{message}
						</p>
					)}
					<button type="submit" disabled={pending} className={styles.accessSubmit}>
						{pending ? "正在打开…" : "进入我的厨房"}
						<ArrowRight size={15} aria-hidden="true" />
					</button>
				</form>
			}
		/>
	);
}
