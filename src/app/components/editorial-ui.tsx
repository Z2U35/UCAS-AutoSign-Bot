"use client";

import type { ComponentProps, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import { Check, CircleAlert, Info, LoaderCircle } from "lucide-react";

export type StatusKind = "idle" | "loading" | "success" | "error" | "info";

const buttonVariants = cva("action-btn inline-flex items-center justify-center gap-2 px-4 py-2", {
	variants: {
		variant: {
			primary: "action-btn--primary",
			secondary: "action-btn--secondary",
			quiet: "action-btn--quiet",
		},
	},
	defaultVariants: { variant: "primary" },
});

type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ variant, className, type = "button", ...props }: ButtonProps) {
	return <button type={type} className={twMerge(buttonVariants({ variant }), className)} {...props} />;
}

export function SectionHeading({ number, label, title, detail }: {
	number: string;
	label: string;
	title: string;
	detail?: ReactNode;
}) {
	return (
		<div className="section-heading">
			<div>
				<p className="section-kicker">{number} / {label}</p>
				<h2 className="section-title">{title}</h2>
			</div>
			{detail && <div className="font-mono text-xs">{detail}</div>}
		</div>
	);
}

export function StatusNotice({ kind, children }: { kind: StatusKind; children: ReactNode }) {
	const StatusIcon = kind === "error" ? CircleAlert : kind === "success" ? Check : kind === "loading" ? LoaderCircle : Info;
	const statusVariant = kind === "idle" ? "neutral" : kind;
	return (
		<p role={kind === "error" ? "alert" : "status"} aria-atomic="true"
			className={`status-banner status-banner--${statusVariant} flex items-start gap-2 p-3 text-xs leading-6`}>
			<StatusIcon aria-hidden="true" strokeWidth={1.5} className="mt-1 h-4 w-4 shrink-0" />
			<span>{children}</span>
		</p>
	);
}
