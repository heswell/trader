import {
  Button,
  Menu,
  MenuGroup,
  MenuItem,
  MenuPanel,
  MenuTrigger,
} from "@salt-ds/core";
import {
  GridLayoutHeaderContribution,
  useGridLayoutItem,
} from "@vuu-ui/grid-layout";
import cx from "clsx";
import type { ReactNode } from "react";
import type { Watchlist } from "./watchlists";

const classBase = "tradingInstrumentGridHeader";

/** Scope id of all instruments (no watchlist). */
export const ALL_INSTRUMENTS = "__all__";

const ChevronDown = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="10"
    viewBox="0 0 10 10"
    width="10"
  >
    <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

const GearIcon = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="14"
    viewBox="0 0 16 16"
    width="14"
  >
    <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.3"
    />
  </svg>
);

const FilterIcon = () => (
  <svg
    aria-hidden="true"
    fill="currentColor"
    height="12"
    viewBox="0 0 16 16"
    width="12"
  >
    <path d="M2 3h12l-4.5 5.2V13L6.5 11.6V8.2z" />
  </svg>
);

const CheckIcon = ({ checked }: { checked: boolean }) => (
  <svg
    aria-hidden="true"
    className={`${classBase}-check`}
    fill="none"
    height="12"
    style={{ visibility: checked ? "visible" : "hidden" }}
    viewBox="0 0 12 12"
    width="12"
  >
    <path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

export interface InstrumentGridHeaderProps {
  /** ALL_INSTRUMENTS or a watchlist id. */
  scope: string;
  watchlists: readonly Watchlist[];
  onScopeChange: (scope: string) => void;
  /** Ric of the grid's selected row, for adding to / removing from a list. */
  selectedRic?: string;
  onNewWatchlist: () => void;
  onAddToWatchlist: (id: string, ric: string) => void;
  onRemoveFromWatchlist: (id: string, ric: string) => void;
  onDeleteWatchlist: (id: string) => void;
  showFilterBar: boolean;
  onShowFilterBarChange: (show: boolean) => void;
  /** Undefined when the grid offers no footer (showFooter={false}). */
  showFooter?: boolean;
  onShowFooterChange: (show: boolean) => void;
  /** Applied filter clauses; with the bar hidden, a badge shows them. */
  filterCount: number;
}

/**
 * The scope picker: the panel title, a menu of All instruments and the
 * watchlists, plus actions on the current watchlist.
 */
const ScopePicker = ({
  onAddToWatchlist,
  onDeleteWatchlist,
  onNewWatchlist,
  onRemoveFromWatchlist,
  onScopeChange,
  scope,
  selectedRic,
  watchlists,
}: InstrumentGridHeaderProps) => {
  const watchlist = watchlists.find(({ id }) => id === scope);
  const label = watchlist?.name ?? "All instruments";
  const inList =
    watchlist && selectedRic && watchlist.rics.includes(selectedRic);
  return (
    <Menu placement="bottom-start">
      <MenuTrigger>
        <Button
          aria-label={`Instruments: ${label}`}
          appearance="transparent"
          className={`${classBase}-scope`}
        >
          <span className={`${classBase}-scopeLabel`}>{label}</span>
          <ChevronDown />
        </Button>
      </MenuTrigger>
      <MenuPanel className={`${classBase}-menu`}>
        <MenuGroup>
          <MenuItem
            aria-checked={scope === ALL_INSTRUMENTS}
            onClick={() => onScopeChange(ALL_INSTRUMENTS)}
            role="menuitemradio"
          >
            <CheckIcon checked={scope === ALL_INSTRUMENTS} />
            All instruments
          </MenuItem>
        </MenuGroup>
        {watchlists.length ? (
          <MenuGroup label="Watchlists">
            {watchlists.map((list) => (
              <MenuItem
                aria-checked={scope === list.id}
                key={list.id}
                onClick={() => onScopeChange(list.id)}
                role="menuitemradio"
              >
                <CheckIcon checked={scope === list.id} />
                <span className={`${classBase}-itemLabel`}>{list.name}</span>
                <span className={`${classBase}-itemNote`}>
                  {list.rics.length}
                </span>
              </MenuItem>
            ))}
          </MenuGroup>
        ) : null}
        <MenuGroup>
          {watchlist && selectedRic ? (
            inList ? (
              <MenuItem
                onClick={() => onRemoveFromWatchlist(watchlist.id, selectedRic)}
              >
                {`Remove ${selectedRic} from ${watchlist.name}`}
              </MenuItem>
            ) : (
              <MenuItem
                onClick={() => onAddToWatchlist(watchlist.id, selectedRic)}
              >
                {`Add ${selectedRic} to ${watchlist.name}`}
              </MenuItem>
            )
          ) : null}
          <MenuItem onClick={onNewWatchlist}>New watchlist…</MenuItem>
          {watchlist ? (
            <MenuItem onClick={() => onDeleteWatchlist(watchlist.id)}>
              {`Delete ${watchlist.name}`}
            </MenuItem>
          ) : null}
        </MenuGroup>
      </MenuPanel>
    </Menu>
  );
};

/** Shown while the filter bar is hidden and filters apply; shows the bar. */
const FilterBadge = ({
  filterCount,
  onShowFilterBarChange,
  showFilterBar,
}: InstrumentGridHeaderProps) =>
  !showFilterBar && filterCount > 0 ? (
    <Button
      aria-label={`${filterCount} filter${filterCount === 1 ? "" : "s"} applied, show the filter bar`}
      appearance="transparent"
      className={`${classBase}-filterBadge`}
      onClick={() => onShowFilterBarChange(true)}
      title="Filters applied: show the filter bar"
    >
      <FilterIcon />
      <span className={`${classBase}-count`}>{filterCount}</span>
    </Button>
  ) : null;

/** The gear: Panel settings. */
const PanelSettings = ({
  onShowFilterBarChange,
  onShowFooterChange,
  showFilterBar,
  showFooter,
}: InstrumentGridHeaderProps) => (
  <Menu placement="bottom-end">
    <MenuTrigger>
      <Button
        aria-label="Panel settings"
        appearance="transparent"
        className={`${classBase}-settings`}
        title="Panel settings"
      >
        <GearIcon />
      </Button>
    </MenuTrigger>
    <MenuPanel className={`${classBase}-menu`}>
      <MenuGroup label="Panel settings">
        <MenuItem
          aria-checked={showFilterBar}
          onClick={() => onShowFilterBarChange(!showFilterBar)}
          role="menuitemcheckbox"
        >
          <CheckIcon checked={showFilterBar} />
          <span className={`${classBase}-itemLabel`}>Show filter bar</span>
          <kbd className={`${classBase}-key`}>Ctrl+Shift+F</kbd>
        </MenuItem>
        {showFooter !== undefined ? (
          <MenuItem
            aria-checked={showFooter}
            onClick={() => onShowFooterChange(!showFooter)}
            role="menuitemcheckbox"
          >
            <CheckIcon checked={showFooter} />
            <span className={`${classBase}-itemLabel`}>Show footer</span>
          </MenuItem>
        ) : null}
      </MenuGroup>
    </MenuPanel>
  </Menu>
);

/**
 * The grid's header: the scope picker as the title, then the filter badge
 * and the gear. In a grid-layout panel they go into the panel's own header
 * (the title, or the tab bar of a stack); anywhere else the grid shows them
 * in a header row of its own.
 */
export const InstrumentGridHeader = (props: InstrumentGridHeaderProps) => {
  const item = useGridLayoutItem();
  const actions: ReactNode = (
    <>
      <FilterBadge {...props} />
      <PanelSettings {...props} />
    </>
  );
  if (item) {
    return (
      <>
        <GridLayoutHeaderContribution
          className={cx(classBase, `${classBase}-titleContribution`)}
          location={item.stacked ? "start" : "title"}
        >
          <ScopePicker {...props} />
        </GridLayoutHeaderContribution>
        <GridLayoutHeaderContribution
          className={cx(classBase, `${classBase}-endContribution`)}
          location="end"
        >
          {actions}
        </GridLayoutHeaderContribution>
      </>
    );
  }
  return (
    <div className={cx(classBase, `${classBase}-inline`)}>
      <ScopePicker {...props} />
      <span className={`${classBase}-spacer`} />
      {actions}
    </div>
  );
};

/** Clauses in a FilterBar filter: an `and` counts its parts, else one. */
export const filterClauseCount = (
  filter: { op: string; filters?: readonly unknown[] } | undefined,
) =>
  filter === undefined
    ? 0
    : filter.op === "and" && filter.filters
      ? filter.filters.length
      : 1;
