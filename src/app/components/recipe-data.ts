export type DishKind = "salmon" | "risotto" | "salad" | "tiramisu" | "soup" | "toast";

export type Recipe = {
	id: DishKind;
	title: string;
	englishTitle: string;
	category: string;
	description: string;
	minutes: number;
	servings: number;
	difficulty: string;
	ingredients: string[];
	steps: string[];
	tip: string;
};

export const RECIPES: Recipe[] = [
	{
		id: "salmon",
		title: "柠檬黄油煎三文鱼",
		englishTitle: "Lemon butter salmon",
		category: "主食料理",
		description: "金黄酥香的鱼皮，遇上清新的柠檬黄油。配一把嫩芦笋，把平常的一餐做得有滋有味。",
		minutes: 35,
		servings: 2,
		difficulty: "进阶尝试",
		ingredients: [
			"三文鱼 2 块",
			"芦笋 200 克",
			"柠檬半个",
			"黄油 20 克",
			"橄榄油 1 汤匙",
			"蒜 2 瓣",
			"盐、黑胡椒适量",
		],
		steps: [
			"用厨房纸吸干鱼块表面的水分，两面撒盐与黑胡椒；芦笋去掉老根，蒜切末。",
			"平底锅加橄榄油烧热，鱼皮朝下放入三文鱼，中火煎至鱼皮金黄后翻面。",
			"按鱼块厚度调整时间，继续煎至中心熟透；使用食品温度计时，中心温度应达到 63°C。盛出备用。",
			"转小火加入黄油、蒜末与芦笋，炒至芦笋变软，加少许水和柠檬汁拌匀。",
			"将酱汁淋在三文鱼上，与芦笋一起装盘，趁热享用。",
		],
		tip: "鱼块下锅后先不要急着翻动，等鱼皮定型，才更容易煎出完整的酥脆表面。",
	},
	{
		id: "risotto",
		title: "奶油蘑菇烩饭",
		englishTitle: "Creamy mushroom risotto",
		category: "主食料理",
		description: "慢慢搅拌，把蘑菇的鲜香与米粒的绵密留在同一只碗里。",
		minutes: 40,
		servings: 2,
		difficulty: "进阶尝试",
		ingredients: [
			"意大利烩饭米 160 克",
			"蘑菇 200 克",
			"洋葱半个",
			"热蔬菜高汤约 600 毫升",
			"黄油 20 克",
			"帕尔马干酪 30 克",
			"盐、黑胡椒适量",
		],
		steps: [
			"蘑菇切片、洋葱切末，高汤放在小锅中保持温热。",
			"用一半黄油炒香洋葱与蘑菇，加入烩饭米翻炒 1 分钟。",
			"逐勺加入热高汤，轻轻搅拌，等米粒吸收汤汁后再加下一勺。",
			"约 20 分钟后检查米粒熟度，继续补汤煮到喜欢的软硬程度。",
			"关火拌入剩余黄油与干酪，用盐和黑胡椒调味，趁热盛盘。",
		],
		tip: "高汤要保持温热，分次加入；最后留一点流动感，烩饭会更柔润。",
	},
	{
		id: "salad",
		title: "清爽凯撒沙拉",
		englishTitle: "Everyday Caesar salad",
		category: "清爽沙拉",
		description: "脆生菜、香烤面包丁和一层轻盈酱汁，给餐桌添一点绿意。",
		minutes: 15,
		servings: 2,
		difficulty: "新手友好",
		ingredients: [
			"罗马生菜 1 颗",
			"吐司 2 片",
			"帕尔马干酪 20 克",
			"原味酸奶 3 汤匙",
			"蛋黄酱 1 汤匙",
			"柠檬汁 1 茶匙",
			"橄榄油、黑胡椒适量",
		],
		steps: [
			"生菜洗净并充分沥干，掰成方便入口的大小。",
			"吐司切丁，拌少许橄榄油，用平底锅小火烘至金黄酥脆。",
			"酸奶、蛋黄酱和柠檬汁混合，撒少许黑胡椒。",
			"食用前将生菜与酱汁拌匀，放上面包丁，刨入干酪即可。",
		],
		tip: "先沥干生菜、最后再拌酱，蔬菜和面包丁都能保留爽脆口感。",
	},
	{
		id: "tiramisu",
		title: "免生蛋提拉米苏",
		englishTitle: "A little tiramisu",
		category: "甜点烘焙",
		description: "咖啡的微苦与奶油的轻甜，一层一层，留给慢下来的午后。",
		minutes: 25,
		servings: 4,
		difficulty: "新手友好",
		ingredients: [
			"马斯卡彭奶酪 250 克",
			"淡奶油 150 毫升",
			"细砂糖 35 克",
			"手指饼干 12 根",
			"放凉的黑咖啡 150 毫升",
			"无糖可可粉适量",
		],
		steps: [
			"将淡奶油与砂糖打发到出现柔软纹路，轻轻拌入马斯卡彭奶酪。",
			"手指饼干快速蘸一下冷咖啡，铺在容器底部。",
			"铺一层奶酪糊，再重复饼干与奶酪糊的层次。",
			"加盖冷藏至少 4 小时，食用前筛上一层可可粉。操作时间不含冷藏时间。",
		],
		tip: "饼干蘸咖啡的动作要快，避免浸泡过久让成品出水。全程不需要使用生鸡蛋。",
	},
	{
		id: "soup",
		title: "泰式冬阴功汤",
		englishTitle: "Tom yum, made at home",
		category: "暖心汤品",
		description: "酸、辣、鲜在热汤里相遇，柠檬与香茅带来明亮的热带香气。",
		minutes: 25,
		servings: 2,
		difficulty: "新手友好",
		ingredients: [
			"鲜虾 8 只",
			"蘑菇 150 克",
			"番茄 1 个",
			"香茅 1 根",
			"冬阴功酱 1 汤匙",
			"椰奶 100 毫升",
			"水 600 毫升",
			"青柠半个",
		],
		steps: [
			"鲜虾去虾线，蘑菇与番茄切块，香茅拍松切段。",
			"水煮开后放入香茅、冬阴功酱、番茄和蘑菇，小火煮 8 分钟。",
			"加入鲜虾，煮至虾肉完全不透明并熟透，再倒入椰奶煮开。",
			"关火后挤入青柠汁，试味后按喜好调整酸辣度，捞去香茅段后盛出。",
		],
		tip: "青柠汁在关火后加入更清香；不同品牌的冬阴功酱咸度不同，先尝再加盐。",
	},
	{
		id: "toast",
		title: "番茄罗勒烤面包",
		englishTitle: "Tomato & basil bruschetta",
		category: "小食前菜",
		description: "一片酥脆面包，几颗熟番茄，十分钟就能做好的小小幸福。",
		minutes: 10,
		servings: 2,
		difficulty: "新手友好",
		ingredients: [
			"法棍切片 4 片",
			"熟番茄 2 个",
			"新鲜罗勒 1 小把",
			"蒜 1 瓣",
			"橄榄油 1 汤匙",
			"盐、黑胡椒适量",
		],
		steps: [
			"番茄切成小丁，沥去多余汁水，罗勒撕成小片。",
			"番茄与罗勒拌匀，加橄榄油、盐和黑胡椒调味。",
			"面包片放入平底锅，两面烘至酥脆，用切开的蒜瓣轻擦表面。",
			"将番茄罗勒铺在面包上，淋少许橄榄油，做好后立即食用。",
		],
		tip: "番茄馅可以提前准备，但请在上桌前再放到面包上，避免面包吸水变软。",
	},
];

export const RECIPE_CATEGORIES = ["全部食谱", ...new Set(RECIPES.map((recipe) => recipe.category))];
