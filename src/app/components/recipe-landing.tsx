"use client";

import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import {
	ArrowRight,
	Bookmark,
	ChefHat,
	Clock3,
	Heart,
	Leaf,
	Search,
	SlidersHorizontal,
	Sparkles,
	UtensilsCrossed,
	X,
} from "lucide-react";
import { RECIPES, RECIPE_CATEGORIES, type Recipe } from "./recipe-data";
import RecipeIllustration from "./recipe-illustration";
import styles from "./recipe-landing.module.css";

const SAVED_RECIPES_KEY = "cookbook-saved-recipes-v1";
const SAVED_RECIPES_EVENT = "cookbook-saved-recipes-change";
const featuredRecipe = RECIPES[0];

function subscribeToSavedRecipes(onChange: () => void) {
	window.addEventListener("storage", onChange);
	window.addEventListener(SAVED_RECIPES_EVENT, onChange);
	return () => {
		window.removeEventListener("storage", onChange);
		window.removeEventListener(SAVED_RECIPES_EVENT, onChange);
	};
}

function getSavedRecipesSnapshot() {
	try {
		return localStorage.getItem(SAVED_RECIPES_KEY) ?? "[]";
	} catch {
		return "[]";
	}
}

function getServerSavedRecipesSnapshot() {
	return "[]";
}

function parseSavedRecipes(snapshot: string) {
	try {
		const storedRecipes: unknown = JSON.parse(snapshot);
		return Array.isArray(storedRecipes)
			? RECIPES.filter((recipe) => storedRecipes.includes(recipe.id)).map((recipe) => recipe.id)
			: [];
	} catch {
		return [];
	}
}

export default function RecipeLanding({ accessForm }: { accessForm: ReactNode }) {
	const [activeCategory, setActiveCategory] = useState("全部食谱");
	const [searchQuery, setSearchQuery] = useState("");
	const [savedRecipesFallback, setSavedRecipesFallback] = useState<string | null>(null);
	const savedRecipesSnapshot = useSyncExternalStore(
		subscribeToSavedRecipes,
		getSavedRecipesSnapshot,
		getServerSavedRecipesSnapshot,
	);
	const savedRecipes = parseSavedRecipes(savedRecipesFallback ?? savedRecipesSnapshot);
	const [onlySaved, setOnlySaved] = useState(false);
	const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
	const recipeDialogRef = useRef<HTMLDialogElement>(null);

	function toggleSavedRecipe(recipeId: Recipe["id"]) {
		const nextSavedRecipes = savedRecipes.includes(recipeId)
			? savedRecipes.filter((savedRecipeId) => savedRecipeId !== recipeId)
			: [...savedRecipes, recipeId];
		const nextSavedRecipesSnapshot = JSON.stringify(nextSavedRecipes);
		try {
			localStorage.setItem(SAVED_RECIPES_KEY, nextSavedRecipesSnapshot);
			setSavedRecipesFallback(null);
		} catch {
			// The current page retains the selection even without persistent storage.
			setSavedRecipesFallback(nextSavedRecipesSnapshot);
		}
		window.dispatchEvent(new Event(SAVED_RECIPES_EVENT));
	}

	function openRecipe(recipe: Recipe) {
		setSelectedRecipe(recipe);
		recipeDialogRef.current?.showModal();
	}

	function resetFilters() {
		setActiveCategory("全部食谱");
		setSearchQuery("");
		setOnlySaved(false);
	}

	const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
	const filteredRecipes = RECIPES.filter((recipe) => {
		const matchesCategory = activeCategory === "全部食谱" || recipe.category === activeCategory;
		const matchesSaved = !onlySaved || savedRecipes.includes(recipe.id);
		const searchableText = [
			recipe.title,
			recipe.englishTitle,
			recipe.category,
			...recipe.ingredients,
		]
			.join(" ")
			.toLocaleLowerCase();
		return matchesCategory && matchesSaved && searchableText.includes(normalizedQuery);
	});

	return (
		<div className={styles.shell}>
			<a className="skip-link" href="#recipe-collection">
				跳到食谱
			</a>
			<header className={styles.header}>
				<div className={styles.headerInner}>
					<Link href="/" className={styles.brand} aria-label="CookBook 日常食记首页">
						<span className={styles.brandMark}>
							<ChefHat size={25} aria-hidden="true" />
						</span>
						<span>
							<strong lang="en">
								CookBook<span className={styles.brandDot}>.</span>
							</strong>
							<small>日常食记</small>
						</span>
					</Link>
					<nav className={styles.headerNav} aria-label="主导航">
						<a href="#recipe-collection" onClick={resetFilters}>
							发现食谱
						</a>
						<button
							type="button"
							aria-pressed={onlySaved}
							onClick={() => {
								setOnlySaved(!onlySaved);
								setActiveCategory("全部食谱");
								setSearchQuery("");
							}}
						>
							<Bookmark size={17} aria-hidden="true" /> 我的收藏{" "}
							<span className={styles.savedCount}>{savedRecipes.length}</span>
						</button>
						<a href="#private-kitchen" className={styles.kitchenLink}>
							我的厨房 <ArrowRight size={16} aria-hidden="true" />
						</a>
					</nav>
				</div>
			</header>

			<div className={styles.pageLayout}>
				<aside className={styles.sidebar}>
					<div className={styles.categorySection}>
						<p className={styles.eyebrow} lang="en">
							A LITTLE INSPIRATION
						</p>
						<h2 className={styles.sidebarTitle}>
							<UtensilsCrossed size={18} aria-hidden="true" /> 今天想吃什么？
						</h2>
						<nav className={styles.categories} aria-label="食谱分类">
							{RECIPE_CATEGORIES.map((category) => (
								<button
									key={category}
									type="button"
									aria-pressed={activeCategory === category && !onlySaved}
									onClick={() => {
										setActiveCategory(category);
										setOnlySaved(false);
									}}
								>
									<span>{category}</span>
									<span>
										{category === "全部食谱"
											? RECIPES.length
											: RECIPES.filter((recipe) => recipe.category === category).length}
									</span>
								</button>
							))}
						</nav>
					</div>
					{accessForm}
					<div className={styles.sidebarNote}>
						<Leaf size={22} aria-hidden="true" />
						<p>
							一餐一饭，认真对待。
							<br />
							<span>好好吃饭，也是好好生活。</span>
						</p>
					</div>
				</aside>

				<main className={styles.main}>
					<div className={styles.introduction}>
						<div>
							<p className={styles.eyebrow} lang="en">
								FROM OUR KITCHEN TO YOURS
							</p>
							<h1>
								把日子，煮成喜欢的味道<span>。</span>
							</h1>
							<p>简单的食材，刚刚好的灵感。今天，也为自己做顿好饭。</p>
						</div>
						<span className={styles.introSeal} aria-hidden="true">
							<ChefHat size={24} />
							<span lang="en">
								MADE WITH
								<br />
								LOVE
							</span>
						</span>
					</div>

					<section className={styles.hero} aria-labelledby="featured-recipe-title">
						<div className={styles.heroCopy}>
							<span className={styles.heroLabel}>
								<Sparkles size={14} aria-hidden="true" /> 今日推荐{" "}
								<span lang="en">TODAY&apos;S SPECIAL</span>
							</span>
							<h2 id="featured-recipe-title">
								柠檬黄油
								<br />
								煎三文鱼
							</h2>
							<p>{featuredRecipe.description}</p>
							<div className={styles.heroMeta}>
								<span>
									<Clock3 size={16} aria-hidden="true" /> 35 分钟
								</span>
								<span>
									<UtensilsCrossed size={16} aria-hidden="true" /> 2 人份
								</span>
							</div>
							<button
								type="button"
								className={styles.heroButton}
								onClick={() => openRecipe(featuredRecipe)}
							>
								一起做这道菜 <ArrowRight size={17} aria-hidden="true" />
							</button>
						</div>
						<div className={styles.heroArt}>
							<RecipeIllustration dish="salmon" />
							<span className={styles.artCaption}>一点柠檬香，一整天的好心情。</span>
						</div>
					</section>

					<section
						id="recipe-collection"
						className={styles.collection}
						aria-labelledby="recipe-collection-title"
					>
						<div className={styles.collectionHeading}>
							<div>
								<p className={styles.eyebrow} lang="en">
									SOMETHING DELICIOUS
								</p>
								<h2 id="recipe-collection-title">
									{onlySaved
										? "我的收藏"
										: activeCategory === "全部食谱"
											? "每一餐，都有新灵感"
											: activeCategory}
								</h2>
							</div>
							<label className={styles.search}>
								<Search size={18} aria-hidden="true" />
								<span className="sr-only">搜索食谱或食材</span>
								<input
									type="search"
									placeholder="搜索食谱、食材…"
									value={searchQuery}
									onChange={(event) => setSearchQuery(event.target.value)}
								/>
							</label>
						</div>
						<p className={styles.resultsCount} role="status">
							{filteredRecipes.length} 道食谱，为日常添点滋味
						</p>
						<div className={styles.recipeGrid}>
							{filteredRecipes.map((recipe) => (
								<article key={recipe.id} className={styles.recipeCard}>
									<button
										type="button"
										className={styles.cardOpen}
										onClick={() => openRecipe(recipe)}
										aria-label={`查看${recipe.title}食谱`}
									>
										<span className={styles.cardArt} data-dish={recipe.id}>
											<RecipeIllustration dish={recipe.id} />
										</span>
										<span className={styles.cardBody}>
											<span className={styles.cardCategory}>
												{recipe.category}
												<span>{recipe.difficulty}</span>
											</span>
											<strong className={styles.cardTitle}>{recipe.title}</strong>
											<span className={styles.cardEnglish} lang="en">
												{recipe.englishTitle}
											</span>
											<span className={styles.cardMeta}>
												<span>
													<Clock3 size={14} aria-hidden="true" /> {recipe.minutes} 分钟
												</span>
												<span>
													{recipe.servings} 人份 <ArrowRight size={14} aria-hidden="true" />
												</span>
											</span>
										</span>
									</button>
									<button
										type="button"
										className={styles.saveButton}
										aria-pressed={savedRecipes.includes(recipe.id)}
										aria-label={`${savedRecipes.includes(recipe.id) ? "取消收藏" : "收藏"}${recipe.title}`}
										onClick={() => toggleSavedRecipe(recipe.id)}
									>
										<Heart
											size={18}
											aria-hidden="true"
											fill={savedRecipes.includes(recipe.id) ? "currentColor" : "none"}
										/>
									</button>
								</article>
							))}
						</div>
						{filteredRecipes.length === 0 && (
							<div className={styles.emptyState}>
								<SlidersHorizontal size={28} aria-hidden="true" />
								<h3>{onlySaved ? "这里还没有符合条件的收藏" : "还没找到这道美味"}</h3>
								<p>试试其他食材，或点亮食谱上的小爱心。</p>
								<button type="button" onClick={resetFilters}>
									查看全部食谱 <ArrowRight size={16} aria-hidden="true" />
								</button>
							</div>
						)}
					</section>
					<div className={styles.kitchenTip}>
						<Leaf size={23} aria-hidden="true" />
						<div>
							<strong>厨房里的小提醒</strong>
							<p>跟着时令挑食材，按自己的口味调味。不必完美，愿你享受下厨的每一分钟。</p>
						</div>
						<span lang="en">COOK. SHARE. ENJOY.</span>
					</div>
				</main>
			</div>

			<footer className={styles.footer}>
				<span>
					<ChefHat size={18} aria-hidden="true" /> <strong lang="en">CookBook.</strong> 日常食记
				</span>
				<p>把平凡的日子，过得有滋有味。</p>
				<span lang="en">A little kitchen, a lot of love.</span>
			</footer>

			<dialog
				ref={recipeDialogRef}
				className={styles.recipeDialog}
				aria-labelledby="recipe-detail-title"
				onClose={() => setSelectedRecipe(null)}
			>
				<button
					type="button"
					className={styles.closeDialog}
					aria-label="关闭食谱"
					onClick={() => recipeDialogRef.current?.close()}
				>
					<X size={22} aria-hidden="true" />
				</button>
				{selectedRecipe && (
					<div className={styles.detailContent}>
						<p className={styles.eyebrow}>
							{selectedRecipe.category} / {selectedRecipe.minutes} 分钟 / {selectedRecipe.servings}{" "}
							人份
						</p>
						<h2 id="recipe-detail-title">{selectedRecipe.title}</h2>
						<p className={styles.detailDescription}>{selectedRecipe.description}</p>
						<div className={styles.detailColumns}>
							<section>
								<h3>
									<UtensilsCrossed size={18} aria-hidden="true" /> 准备食材
								</h3>
								<ul>
									{selectedRecipe.ingredients.map((ingredient) => (
										<li key={ingredient}>{ingredient}</li>
									))}
								</ul>
							</section>
							<section>
								<h3>
									<ChefHat size={18} aria-hidden="true" /> 开始下厨
								</h3>
								<ol>
									{selectedRecipe.steps.map((step) => (
										<li key={step}>{step}</li>
									))}
								</ol>
							</section>
						</div>
						<p className={styles.detailTip}>
							<strong>美味小贴士</strong>
							{selectedRecipe.tip}
						</p>
					</div>
				)}
			</dialog>
		</div>
	);
}
