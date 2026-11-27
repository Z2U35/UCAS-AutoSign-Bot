import { useId } from "react";
import type { DishKind } from "./recipe-data";

export default function RecipeIllustration({ dish }: { dish: DishKind }) {
	const illustrationId = useId();
	const plateGradient = `${illustrationId}-plate`;
	const salmonGradient = `${illustrationId}-salmon`;
	return (
		<svg viewBox="0 0 320 320" fill="none" aria-hidden="true" focusable="false">
			<defs>
				<radialGradient id={plateGradient} cx="40%" cy="30%" r="70%">
					<stop stopColor="#fffefb" />
					<stop offset="1" stopColor="#eae2d4" />
				</radialGradient>
				<linearGradient
					id={salmonGradient}
					x1="90"
					y1="100"
					x2="230"
					y2="210"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#ffb16e" />
					<stop offset="1" stopColor="#dd6534" />
				</linearGradient>
			</defs>
			<ellipse cx="162" cy="177" rx="132" ry="131" fill="#593324" opacity=".12" />
			<circle cx="160" cy="160" r="133" fill={`url(#${plateGradient})`} />
			<circle cx="160" cy="160" r="110" stroke="#fff" strokeWidth="2" />
			<circle cx="160" cy="160" r="100" fill="#f5efdf" stroke="#e8dfcc" />
			{dish === "salmon" && (
				<g transform="rotate(-20 160 160)">
					<path
						d="M87 139c0-20 18-34 42-34h72c23 0 40 18 40 40v47c0 12-10 19-22 19H119c-22 0-32-14-32-32z"
						fill="#aa542d"
					/>
					<path
						d="M87 131c0-20 18-34 42-34h72c23 0 40 18 40 40v44c0 12-10 19-22 19H119c-22 0-32-14-32-32z"
						fill={`url(#${salmonGradient})`}
					/>
					{[116, 144, 172, 200].map((position) => (
						<path
							key={position}
							d={`M${position} 108q-12 38 10 80`}
							stroke="#ffdbb5"
							strokeWidth="5"
							opacity=".8"
						/>
					))}
					{[0, 1, 2].map((position) => (
						<g key={position} transform={`translate(${position * 13} 0)`}>
							<path d="M108 223l105 5" stroke="#557637" strokeWidth="7" strokeLinecap="round" />
							<path d="M97 222l16-6v13z" fill="#345529" />
						</g>
					))}
					<circle cx="226" cy="106" r="27" fill="#f3c844" />
					<circle cx="226" cy="106" r="21" fill="#ffe697" stroke="#fff4cb" strokeWidth="2" />
					{[0, 60, 120].map((angle) => (
						<path
							key={angle}
							d="M206 106h40"
							stroke="#fff5d2"
							strokeWidth="2"
							transform={`rotate(${angle} 226 106)`}
						/>
					))}
					<path d="M135 138q10-26 29-13-4 23-29 13m10 2q25-8 25 13-26 7-25-13" fill="#4e7137" />
				</g>
			)}
			{dish === "risotto" && (
				<g>
					<ellipse cx="160" cy="165" rx="85" ry="72" fill="#e6c781" />
					{Array.from({ length: 30 }, (_unused, position) => (
						<ellipse
							key={position}
							cx={104 + ((position * 31) % 116)}
							cy={118 + ((position * 23) % 92)}
							rx="7"
							ry="3"
							transform={`rotate(${position * 19} ${104 + ((position * 31) % 116)} ${118 + ((position * 23) % 92)})`}
							fill="#f9e7af"
						/>
					))}
					{[
						[122, 138],
						[182, 123],
						[157, 184],
						[205, 177],
					].map(([horizontal, vertical]) => (
						<g
							key={`${horizontal}-${vertical}`}
							transform={`translate(${horizontal} ${vertical}) rotate(-20)`}
						>
							<path d="M-18 0a18 16 0 0 1 36 0z" fill="#947052" />
							<path d="M-6 0h12v17H-6z" fill="#d7b28b" />
						</g>
					))}
					<path d="M150 153q-23-26-31-5 12 22 31 5m1 0q9-30 25-16-1 22-25 16" fill="#527840" />
				</g>
			)}
			{dish === "salad" && (
				<g>
					{[0, 60, 120, 180, 240, 300].map((angle) => (
						<g key={angle} transform={`rotate(${angle} 160 160)`}>
							<path
								d="M160 166c-52-5-72-56-30-75 41 1 55 37 30 75"
								fill={angle % 120 ? "#81ae50" : "#b1c96b"}
							/>
							<path d="M157 158l-26-53" stroke="#e6ebaa" strokeWidth="3" />
						</g>
					))}
					{[
						[129, 133],
						[181, 112],
						[194, 186],
						[116, 192],
					].map(([horizontal, vertical]) => (
						<rect
							key={`${horizontal}-${vertical}`}
							x={horizontal}
							y={vertical}
							width="23"
							height="22"
							rx="4"
							transform={`rotate(20 ${horizontal} ${vertical})`}
							fill="#cb944a"
							stroke="#e2b672"
							strokeWidth="3"
						/>
					))}
					<path d="M152 136l25 14-24 7m-17 11l22 20-32-4m58-23l15-21 5 28" fill="#fff0c7" />
				</g>
			)}
			{dish === "tiramisu" && (
				<g transform="rotate(-12 160 160)">
					<rect x="97" y="99" width="127" height="129" rx="12" fill="#b49371" />
					<path d="M98 133h126v20H98zm0 45h126v24H98z" fill="#fff0d8" />
					<rect x="97" y="95" width="127" height="42" rx="8" fill="#71452f" />
					{[113, 133, 153, 173, 193, 213].map((position) => (
						<path
							key={position}
							d={`M${position} 104v21`}
							stroke="#956341"
							strokeWidth="3"
							strokeLinecap="round"
						/>
					))}
					<ellipse
						cx="236"
						cy="222"
						rx="12"
						ry="8"
						fill="#63402e"
						transform="rotate(-25 236 222)"
					/>
				</g>
			)}
			{dish === "soup" && (
				<g>
					<circle cx="160" cy="160" r="88" fill="#cc6436" stroke="#b55230" strokeWidth="4" />
					{[0, 140, 240].map((angle) => (
						<g key={angle} transform={`rotate(${angle} 160 160)`}>
							<path
								d="M141 108c-37-4-41 34-10 39"
								stroke="#ffd1a5"
								strokeWidth="14"
								strokeLinecap="round"
							/>
							<path d="M117 112l9 8m-16 7l12 2m-8 12l8-6" stroke="#ef8f65" strokeWidth="3" />
						</g>
					))}
					<path d="M151 153q20-31 34-13-4 27-34 13m1 1q-25-21-30 1 18 17 30-1" fill="#668147" />
					<circle cx="201" cy="195" r="24" fill="#e1db88" stroke="#779142" strokeWidth="5" />
					<path d="M182 195h38m-19-20v40m-13-34l26 28" stroke="#f8f1bc" strokeWidth="2" />
				</g>
			)}
			{dish === "toast" && (
				<g transform="rotate(-25 160 160)">
					{[109, 174].map((vertical) => (
						<g key={vertical}>
							<rect
								x="90"
								y={vertical}
								width="142"
								height="55"
								rx="25"
								fill="#d3a063"
								stroke="#ad763e"
								strokeWidth="5"
							/>
							{[107, 140, 173, 202].map((horizontal) => (
								<rect
									key={horizontal}
									x={horizontal}
									y={vertical + 12}
									width="23"
									height="27"
									rx="6"
									fill={horizontal % 2 ? "#d9563e" : "#ec7851"}
								/>
							))}
							<path
								d={`M142 ${vertical + 24}q-14-27-25-7 1 19 25 7m26 0q16-23 29-6-3 20-29 6`}
								fill="#507844"
							/>
						</g>
					))}
				</g>
			)}
		</svg>
	);
}
