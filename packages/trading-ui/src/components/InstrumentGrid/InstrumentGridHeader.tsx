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

/** A cog (the Material settings icon, as vuu-icons' "settings"). */
const GearIcon = () => (
  <svg
    aria-hidden="true"
    fill="currentColor"
    height="14"
    viewBox="0 0 16 16"
    width="14"
  >
    <path d="M12.95 8.65c.03-.21.05-.43.05-.65s-.02-.44-.05-.65l1.41-1.1a.33.33 0 0 0 .08-.43l-1.33-2.31a.33.33 0 0 0-.41-.15l-1.66.67a4.9 4.9 0 0 0-1.13-.65l-.25-1.77a.33.33 0 0 0-.33-.28H6.67a.33.33 0 0 0-.33.28l-.25 1.77c-.41.17-.78.39-1.13.65L3.3 3.37a.33.33 0 0 0-.41.15L1.56 5.82a.33.33 0 0 0 .08.43l1.41 1.1A5.3 5.3 0 0 0 3 8c0 .22.02.44.05.65l-1.41 1.1a.33.33 0 0 0-.08.43l1.33 2.31c.08.15.26.2.41.15l1.66-.67c.35.27.72.49 1.13.65l.25 1.77c.02.16.16.28.33.28h2.66c.17 0 .31-.12.33-.28l.25-1.77c.41-.17.78-.39 1.13-.65l1.66.67c.15.06.33 0 .41-.15l1.33-2.31a.33.33 0 0 0-.08-.43zM8 10.33a2.33 2.33 0 1 1 0-4.66 2.33 2.33 0 0 1 0 4.66z" />
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
  /** Pin linked rows above the others (also the link column header). */
  pinLinked: boolean;
  onPinLinkedChange: (pin: boolean) => void;
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
  onPinLinkedChange,
  onShowFilterBarChange,
  onShowFooterChange,
  pinLinked,
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
        <MenuItem
          aria-checked={pinLinked}
          onClick={() => onPinLinkedChange(!pinLinked)}
          role="menuitemcheckbox"
        >
          <CheckIcon checked={pinLinked} />
          <span className={`${classBase}-itemLabel`}>
            Pin linked rows to the top
          </span>
        </MenuItem>
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
