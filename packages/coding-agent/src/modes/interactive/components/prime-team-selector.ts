import { Container, type Focusable, fuzzyFilter, getKeybindings, Spacer, TruncatedText } from "@earendil-works/pi-tui";
import type { PrimeTeam } from "../../../core/prime-inference-auth.js";
import { theme } from "../theme/theme.js";
import {
	CollapsibleMenuArea,
	countWrappedSubtitleRows,
	getMenuListLayout,
	MenuList,
	MenuPanel,
	MenuRow,
	MenuSearchInput,
	type MenuViewportProvider,
	menuViewportRows,
} from "./menu-panel.js";
import { shouldTreatAsBack } from "./modal-back.js";

type PrimeTeamOption = {
	type: "personal" | "team";
	team: PrimeTeam | null;
};

const PREFERRED_VISIBLE_TEAMS = 8;
const TEAM_LIST_RESERVED_ROWS = 7;
const TEAM_SCROLL_INDICATOR_ROWS = 1;
const TEAM_SUBTITLE = "Choose which account pays for Prime Inference usage.";

export class PrimeTeamSelectorComponent extends Container implements Focusable {
	private readonly searchInput: MenuSearchInput;
	private readonly listContainer: Container;
	private readonly allOptions: PrimeTeamOption[];
	private filteredOptions: PrimeTeamOption[];
	private selectedIndex = 0;
	private searchQuery = "";
	private _focused = false;
	/** Width of the latest render, so the subtitle's wrapped rows can be budgeted. */
	private lastWidth = 0;
	private readonly searchArea = new CollapsibleMenuArea();
	/** True when the terminal is too short for the full chrome; the search area and subtitle drop out. */
	private criticalShortage = false;
	private listLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE_TEAMS,
		reservedRows: TEAM_LIST_RESERVED_ROWS,
		comfortableItemRows: 3,
		compactItemRows: 2,
	});

	constructor(
		teams: PrimeTeam[],
		private readonly currentTeamId: string | undefined,
		private readonly onSelect: (team: PrimeTeam | null) => void,
		private readonly onCancel: () => void,
		private readonly viewport: MenuViewportProvider = {},
	) {
		super();

		this.allOptions = [{ type: "personal", team: null }, ...teams.map((team) => ({ type: "team" as const, team }))];
		this.filteredOptions = this.allOptions;

		const panel = new MenuPanel({
			title: "Prime Team",
			subtitle: () => (this.criticalShortage ? undefined : TEAM_SUBTITLE),
		});
		this.addChild(panel);

		this.searchInput = new MenuSearchInput("Search teams");
		this.searchInput.onSubmit = () => {
			const selected = this.filteredOptions[this.selectedIndex];
			if (selected) {
				this.onSelect(selected.team);
			}
		};
		this.searchArea.addChild(this.searchInput);
		this.searchArea.addChild(new Spacer(1));
		panel.addChild(this.searchArea);

		this.listContainer = new MenuList({ compact: () => this.listLayout.compact });
		panel.addChild(this.listContainer);
		this.filterOptions("");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private filterOptions(query: string): void {
		const queryChanged = query !== this.searchQuery;
		this.searchQuery = query;
		this.filteredOptions = query
			? fuzzyFilter(this.allOptions, query, (option) => this.getSearchText(option))
			: this.allOptions;
		this.selectedIndex = queryChanged
			? 0
			: Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredOptions.length - 1)));
		this.updateList();
	}

	private getSearchText(option: PrimeTeamOption): string {
		if (option.type === "personal") {
			return "personal account";
		}
		const team = option.team;
		return team ? `${team.name} ${team.slug ?? ""} ${team.role ?? ""} ${team.teamId}` : "";
	}

	override render(width: number): string[] {
		this.lastWidth = width;
		this.updateCriticalShortage(width);
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
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredOptions.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredOptions.length);

		for (let i = startIndex; i < endIndex; i++) {
			const option = this.filteredOptions[i];
			if (!option) {
				continue;
			}
			this.listContainer.addChild(
				new MenuRow({
					primary: this.getPrimary(option),
					secondary: this.getSecondary(option),
					meta: this.getMeta(option),
					selected: i === this.selectedIndex,
				}),
			);
		}

		if (startIndex > 0 || endIndex < this.filteredOptions.length) {
			this.listContainer.addChild(
				new TruncatedText(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredOptions.length})`), 1, 0),
			);
		}

		if (this.filteredOptions.length === 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", "No matching teams"), 1, 0));
		}
	}

	private getPrimary(option: PrimeTeamOption): string {
		return option.team?.name ?? "Personal";
	}

	private getSecondary(option: PrimeTeamOption): string {
		if (!option.team) {
			return "personal account";
		}
		const role = option.team.role?.toLowerCase() ?? "member";
		return option.team.slug ? `slug: ${option.team.slug}, role: ${role}` : `role: ${role}`;
	}

	private getMeta(option: PrimeTeamOption): string {
		const isCurrent = option.team ? option.team.teamId === this.currentTeamId : this.currentTeamId === undefined;
		return isCurrent ? theme.fg("success", "current") : "";
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredOptions.length === 0) {
				return;
			}
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredOptions.length === 0) {
				return;
			}
			this.selectedIndex = Math.min(this.filteredOptions.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredOptions[this.selectedIndex];
			if (selected) {
				this.onSelect(selected.team);
			}
		} else if (kb.matches(keyData, "tui.select.cancel") || shouldTreatAsBack(keyData, this.searchInput)) {
			this.onCancel();
		} else if (!this.criticalShortage) {
			// The search field is hidden at critical shortage; don't type into it blind.
			this.searchInput.handleInput(keyData);
			this.filterOptions(this.searchInput.getValue());
		}
	}

	private updateLayout(): void {
		this.listLayout = getMenuListLayout({
			getRows: this.viewport.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_TEAMS,
			totalItems: this.filteredOptions.length,
			reservedRows: this.reservedRows,
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: this.criticalShortage ? 0 : TEAM_SCROLL_INDICATOR_ROWS,
		});
	}

	private get reservedRows(): number {
		// The base budget prices the subtitle as one row; pay for the rows it
		// actually wraps to at the current width instead.
		if (this.criticalShortage) {
			return TEAM_LIST_RESERVED_ROWS - 3;
		}
		return TEAM_LIST_RESERVED_ROWS - 1 + countWrappedSubtitleRows(TEAM_SUBTITLE, this.lastWidth);
	}

	/**
	 * When even one compact item cannot fit under the full chrome, the overlay's
	 * top-anchored clip would cut the list away entirely; drop the decoration
	 * (subtitle, search area) and the scroll indicator so one option survives.
	 */
	private updateCriticalShortage(width: number): void {
		const rows = menuViewportRows(this.viewport.getRows);
		if (rows === undefined) {
			this.criticalShortage = false;
			return;
		}
		const fullChrome = TEAM_LIST_RESERVED_ROWS - 3 + countWrappedSubtitleRows(TEAM_SUBTITLE, width) + 2;
		// +2: one compact item (primary + secondary) must fit, or the clip eats the list.
		this.criticalShortage = rows < fullChrome + 2;
		this.searchArea.hidden = this.criticalShortage;
	}
}
