import {
	type Component,
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Spacer,
	TruncatedText,
} from "@earendil-works/pi-tui";
import type { AuthStatus, AuthStorage } from "../../../core/auth-storage.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../../../core/prime-inference-auth.js";
import { theme } from "../theme/theme.js";
import {
	getMenuListLayout,
	MenuList,
	MenuPanel,
	MenuRow,
	MenuSearchInput,
	type MenuViewportProvider,
} from "./menu-panel.js";

export type AuthSelectorCategory = "provider" | "service";

export type AuthSelectorProvider = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	/** Which tab the entry belongs to. Defaults to "provider" when omitted. */
	category?: AuthSelectorCategory;
};

export interface OAuthSelectorOptions extends MenuViewportProvider {
	initialCategory?: AuthSelectorCategory;
	header?: Component;
	getHeaderRows?: () => number;
	title?: string;
	subtitle?: string;
	searchPlaceholder?: string;
}

export function compareAuthSelectorProviders(a: AuthSelectorProvider, b: AuthSelectorProvider): number {
	if (a.authType !== b.authType) {
		return a.authType === "oauth" ? -1 : 1;
	}
	return a.name.localeCompare(b.name);
}

const PREFERRED_VISIBLE_PROVIDERS = 8;
const PROVIDER_LIST_RESERVED_ROWS = 7;
/** Extra fixed rows the Providers/MCP Connections tab bar (text + spacer) consumes. */
const TAB_BAR_RESERVED_ROWS = 2;
const PROVIDER_SCROLL_INDICATOR_ROWS = 1;

export class OAuthSelectorComponent extends Container implements Focusable {
	private searchInput: MenuSearchInput;

	// Delegate focus to the search input so its IME cursor remains positioned correctly.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private listContainer: Container;
	private tabBar?: TruncatedText;
	private allProviders: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex: number = 0;
	private searchQuery = "";
	private mode: "login" | "logout";
	/** Tabs present in the data, in display order. Empty/single → no tab bar. */
	private categories: AuthSelectorCategory[] = [];
	private activeCategory: AuthSelectorCategory = "provider";
	private authStorage: AuthStorage;
	private getAuthStatus: (providerId: string) => AuthStatus;
	private onSelectCallback: (provider: AuthSelectorProvider) => void;
	private onCancelCallback: () => void;
	private listLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE_PROVIDERS,
		reservedRows: PROVIDER_LIST_RESERVED_ROWS,
		comfortableItemRows: 3,
		compactItemRows: 2,
	});
	private readonly viewport: MenuViewportProvider;
	private readonly getHeaderRows: () => number;

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		providers: AuthSelectorProvider[],
		onSelect: (provider: AuthSelectorProvider) => void,
		onCancel: () => void,
		getAuthStatus?: (providerId: string) => AuthStatus,
		options: OAuthSelectorOptions = {},
	) {
		super();

		this.mode = mode;
		this.authStorage = authStorage;
		this.getAuthStatus = getAuthStatus ?? ((providerId) => this.authStorage.getAuthStatus(providerId));
		this.viewport = options;
		this.getHeaderRows = options.header ? (options.getHeaderRows ?? (() => TAB_BAR_RESERVED_ROWS)) : () => 0;
		this.allProviders = this.sortProviders(providers);
		this.filteredProviders = this.allProviders;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		const present = new Set(providers.map((p) => p.category ?? "provider"));
		this.categories = (["provider", "service"] as const).filter((c) => present.has(c));
		this.activeCategory =
			options.initialCategory && this.categories.includes(options.initialCategory)
				? options.initialCategory
				: (this.categories[0] ?? "provider");

		const panel = new MenuPanel({
			title: options.title ?? (mode === "login" ? "模型服务" : "已保存的凭据"),
			subtitle: options.subtitle ?? (mode === "login" ? "用订阅账号或 API key 连接。" : "选择要移除的凭据。"),
		});
		this.addChild(panel);
		if (options.header) {
			panel.addChild(options.header);
			panel.addChild(new Spacer(1));
		}

		if (this.categories.length > 1) {
			this.tabBar = new TruncatedText("");
			panel.addChild(this.tabBar);
			panel.addChild(new Spacer(1));
		}

		this.searchInput = new MenuSearchInput(options.searchPlaceholder ?? "搜索模型服务");
		this.searchInput.onSubmit = () => {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider);
			}
		};
		panel.addChild(this.searchInput);
		panel.addChild(new Spacer(1));

		this.listContainer = new MenuList({ compact: () => this.listLayout.compact });
		panel.addChild(this.listContainer);

		this.filterProviders("");
	}

	private inActiveCategory(provider: AuthSelectorProvider): boolean {
		return (provider.category ?? "provider") === this.activeCategory;
	}

	private switchCategory(direction: 1 | -1): void {
		if (this.categories.length < 2) return;
		const current = this.categories.indexOf(this.activeCategory);
		const next = (current + direction + this.categories.length) % this.categories.length;
		this.activeCategory = this.categories[next];
		this.selectedIndex = 0;
		this.searchInput.setValue("");
		this.filterProviders("");
	}

	private updateTabBar(): void {
		if (!this.tabBar) return;
		const labels: Record<AuthSelectorCategory, string> = {
			provider: "模型服务",
			service: "MCP 连接",
		};
		const rendered = this.categories
			.map((category) =>
				category === this.activeCategory
					? theme.bold(theme.fg("accent", labels[category]))
					: theme.fg("muted", labels[category]),
			)
			.join(theme.fg("muted", "  ·  "));
		this.tabBar.setText(`${rendered}   ${theme.fg("muted", "←/→ 切换")}`);
	}

	private filterProviders(query: string): void {
		const queryChanged = query !== this.searchQuery;
		this.searchQuery = query;
		const inCategory = this.allProviders.filter((p) => this.inActiveCategory(p));
		this.filteredProviders = query
			? fuzzyFilter(inCategory, query, (provider) => `${provider.name} ${provider.id} ${provider.authType}`)
			: inCategory;
		this.selectedIndex = queryChanged
			? 0
			: Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredProviders.length - 1)));
		this.updateTabBar();
		this.updateList();
	}

	private sortProviders(providers: AuthSelectorProvider[]): AuthSelectorProvider[] {
		return [...providers].sort((a, b) => {
			const rankDelta = this.getProviderSortRank(a) - this.getProviderSortRank(b);
			if (rankDelta !== 0) {
				return rankDelta;
			}
			if (this.mode === "login" && a.id !== b.id) {
				if (a.id === PRIME_INFERENCE_PROVIDER_ID) return -1;
				if (b.id === PRIME_INFERENCE_PROVIDER_ID) return 1;
			}
			return compareAuthSelectorProviders(a, b);
		});
	}

	refresh(): void {
		const selected = this.filteredProviders[this.selectedIndex];
		this.allProviders = this.sortProviders(this.allProviders);
		this.filterProviders(this.searchInput.getValue());
		if (selected) {
			const selectedIndex = this.filteredProviders.findIndex(
				(provider) => provider.id === selected.id && provider.authType === selected.authType,
			);
			if (selectedIndex >= 0) {
				this.selectedIndex = selectedIndex;
				this.updateList();
			}
		}
	}

	getSearchInput(): MenuSearchInput {
		return this.searchInput;
	}

	private getProviderSortRank(provider: AuthSelectorProvider): number {
		if (this.isProviderConfigured(provider)) {
			return 0;
		}
		if (this.isProviderStale(provider)) {
			return 1;
		}
		return 2;
	}

	private isProviderStale(provider: AuthSelectorProvider): boolean {
		const status = this.getAuthStatus(provider.id);
		const credential = this.authStorage.get(provider.id);
		const storageStatus = this.authStorage.getAuthStatus(provider.id);
		return status.source === "stale" || (storageStatus.source === "stale" && credential?.type === provider.authType);
	}

	private isProviderConfigured(provider: AuthSelectorProvider): boolean {
		const status = this.getAuthStatus(provider.id);
		const credential = this.authStorage.get(provider.id);
		if (this.isProviderStale(provider)) {
			return false;
		}

		if (status.source && status.source !== "stored") {
			return provider.authType === "api_key";
		}

		if (credential) {
			return true;
		}
		if (provider.authType !== "api_key") {
			return false;
		}
		return status.source !== undefined;
	}

	override render(width: number): string[] {
		const previousLayout = this.listLayout;
		this.updateLayout();
		if (
			this.listLayout.compact !== previousLayout.compact ||
			this.listLayout.visibleItems !== previousLayout.visibleItems
		) {
			this.updateList();
		}
		return super.render(width);
	}

	private updateList(): void {
		this.updateLayout();
		this.listContainer.clear();

		const maxVisible = this.listLayout.visibleItems;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredProviders.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredProviders.length);

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.filteredProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;

			this.listContainer.addChild(
				new MenuRow({
					primary: provider.name,
					secondary: provider.authType === "oauth" ? "订阅" : "API key",
					meta: this.formatStatusIndicator(provider),
					selected: isSelected,
				}),
			);
		}

		if (startIndex > 0 || endIndex < this.filteredProviders.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredProviders.length})`);
			this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
		}

		if (this.filteredProviders.length === 0) {
			const message =
				this.allProviders.length === 0
					? this.mode === "login"
						? "没有可用的模型服务"
						: "还没有登录任何模型服务，先用 /login"
					: "没有匹配的模型服务";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", message), 1, 0));
		}
	}

	private formatStatusIndicator(provider: AuthSelectorProvider): string {
		const status = this.getAuthStatus(provider.id);
		const credential = this.authStorage.get(provider.id);
		if (this.isProviderStale(provider)) {
			return theme.fg("warning", !status.label || status.label === "expired" ? "已过期" : status.label);
		}

		if (status.source && status.source !== "stored") {
			return provider.authType === "api_key"
				? this.formatApiKeyStatusIndicator(status)
				: theme.fg("muted", "未配置");
		}

		if (credential?.type === provider.authType) return theme.fg("success", "已配置");
		if (credential) {
			const label = credential.type === "oauth" ? "已配置订阅" : "已配置 API key";
			return theme.fg("warning", label);
		}
		if (provider.authType !== "api_key") return theme.fg("muted", "未配置");

		return this.formatApiKeyStatusIndicator(status);
	}

	private formatApiKeyStatusIndicator(status: AuthStatus): string {
		switch (status.source) {
			case "environment":
				return theme.fg("success", `env: ${status.label ?? "API key"}`);
			case "prime_cli":
				return theme.fg("success", status.label ?? "Prime CLI");
			case "runtime":
				return theme.fg("success", "运行时 API key");
			case "fallback":
				return theme.fg("success", "自定义 API key");
			case "models_json_key":
				return theme.fg("success", "models.json 中的 key");
			case "models_json_command":
				return theme.fg("success", "models.json 中的命令");
			default:
				return theme.fg("muted", "未配置");
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.min(this.filteredProviders.length - 1, this.selectedIndex + 1);
			this.updateList();
		}
		// Only steal left/right for tabs when the search field is empty, so cursor
		// editing still works while filtering.
		else if (
			this.categories.length > 1 &&
			this.searchInput.getValue() === "" &&
			kb.matches(keyData, "tui.editor.cursorLeft")
		) {
			this.switchCategory(-1);
		} else if (
			this.categories.length > 1 &&
			this.searchInput.getValue() === "" &&
			kb.matches(keyData, "tui.editor.cursorRight")
		) {
			this.switchCategory(1);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterProviders(this.searchInput.getValue());
		}
	}

	private get reservedRows(): number {
		return PROVIDER_LIST_RESERVED_ROWS + this.getHeaderRows() + (this.tabBar ? TAB_BAR_RESERVED_ROWS : 0);
	}

	private updateLayout(): void {
		this.listLayout = getMenuListLayout({
			getRows: this.viewport.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_PROVIDERS,
			totalItems: this.filteredProviders.length,
			reservedRows: this.reservedRows,
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: PROVIDER_SCROLL_INDICATOR_ROWS,
		});
	}
}
