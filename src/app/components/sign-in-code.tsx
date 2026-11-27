import Image from "next/image";
import type { Ref } from "react";
import { Copy, Download, QrCode, ScanLine } from "lucide-react";
import { Button, StatusNotice, type StatusKind } from "./editorial-ui";

export type SignInCodeProps = {
	sectionRef: Ref<HTMLDivElement>;
	imageUrl: string;
	signUrl: string;
	countdown: number;
	highlighted: boolean;
	courseName?: string;
	statusKind: StatusKind;
	statusText: string;
	directSign?: { disabled: boolean; label: string; onClick: () => void };
	onDownload: () => void;
	onCopy: () => void;
};

export default function SignInCode({ sectionRef, imageUrl, signUrl, countdown, highlighted,
	courseName, statusKind, statusText, directSign, onDownload, onCopy }: SignInCodeProps) {
	return (
		<div ref={sectionRef} className={`qr-workspace ${highlighted ? "relay-highlight" : ""}`}>
			<div className="mb-5 flex flex-wrap items-start justify-between gap-3">
				<div>
					<p className="section-kicker">03 / THE SIGN-IN DESK</p>
					<h2 className="section-title">实时签到码</h2>
				</div>
				<QrCode aria-hidden="true" size={24} strokeWidth={1.5} />
			</div>
			{imageUrl ? (
				<div className="qr-layout">
					<figure className="mx-auto w-[220px] max-w-full">
						<Image src={imageUrl} alt="课程签到二维码" width={220} height={220} unoptimized
							className="block w-full border border-white bg-white p-3" />
						<figcaption className="qr-caption mt-3">FIG. 01 / LIVE QR CODE</figcaption>
					</figure>
					<div className="min-w-0 space-y-4">
						{courseName && <h3 className="font-serif text-xl font-bold leading-relaxed">{courseName}</h3>}
						<div className="flex items-end justify-between border-b border-current pb-3">
							<span className="text-xs">距离下次刷新</span>
							<span className="font-mono text-4xl numeric-tabular">0{countdown}<span className="ml-1 text-xs">SEC</span></span>
						</div>
						<div className="grid grid-cols-2 gap-2">
							{directSign && <Button className="col-span-2" disabled={directSign.disabled} onClick={directSign.onClick}>
								<ScanLine aria-hidden="true" size={16} strokeWidth={1.5} />{directSign.label}
							</Button>}
							<Button variant="secondary" onClick={onDownload}><Download aria-hidden="true" size={16} strokeWidth={1.5} />下载</Button>
							<Button variant="secondary" onClick={onCopy}><Copy aria-hidden="true" size={16} strokeWidth={1.5} />复制链接</Button>
						</div>
						<p className="text-xs leading-6">页面每5秒自动刷新。下载码10秒有效，请及时使用。</p>
						<details className="border-t border-current text-xs">
							<summary className="min-h-11 cursor-pointer py-3">查看签到链接</summary>
							<p className="break-all pb-3 font-mono leading-6">{signUrl}</p>
						</details>
					</div>
				</div>
			) : (
				<div className="flex min-h-36 items-center gap-5 border-y border-current py-6">
					<ScanLine aria-hidden="true" size={48} strokeWidth={1} className="shrink-0" />
					<div>
						<p className="font-serif text-lg">等待生成，随时就绪。</p>
						<p className="mt-2 text-xs leading-6">选择课程或输入课程编号，<br />你的实时签到码将出现在这里。</p>
					</div>
				</div>
			)}
			{imageUrl && <div className="mt-4"><StatusNotice kind={statusKind}>{statusText}</StatusNotice></div>}
		</div>
	);
}
