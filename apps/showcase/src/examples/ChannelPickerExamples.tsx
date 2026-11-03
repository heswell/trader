import {
  ACTIVE_LINK_GROUP,
  ChannelPicker,
  type ChannelPickerDensity,
  type LinkGroupId,
  linkGroupDefinition,
  MarketDepth,
  PriceChart,
  TradeTape,
  useInstrumentLinkBus,
  useSelectedInstrument,
  useWorkspaceChannel,
  WorkspaceChannelProvider,
} from "@heswell/trading-ui";
import { Button, Text } from "@salt-ds/core";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";

import "./ChannelPickerExamples.css";

const ACCOUNT = "ACC-US-01";

/** Instruments for empty channels, so the example starts populated. */
const SEED: Record<LinkGroupId, string> = {
  red: "AAL.L",
  green: "BARC.L",
  blue: "VOD.L",
};

/** Publish SEED to channels that have nothing selected yet. */
const useSeedChannels = () => {
  const bus = useInstrumentLinkBus();
  useState(() => {
    for (const [channel, ric] of Object.entries(SEED)) {
      if (!bus.getSelection(channel)?.instrument) bus.publish(channel, { ric });
    }
  });
};

const TitleBar = ({ children }: { children: ReactNode }) => (
  <header className="cpDemo-titleBar">
    <span className="cpDemo-crumb">
      <Text styleAs="label">Workspaces /</Text>
      <Text styleAs="h4">Trader</Text>
    </span>
    {children}
    <span className="cpDemo-actions">
      <Button appearance="solid" sentiment="accented">
        + Add panel
      </Button>
    </span>
  </header>
);

/** A panel header showing the channel the panel follows. */
const Panel = ({
  children,
  linkGroup,
  pinned = false,
  title,
}: {
  children: ReactNode;
  linkGroup: LinkGroupId;
  pinned?: boolean;
  title: string;
}) => {
  const { selectedInstrument } = useSelectedInstrument({ linkGroup });
  const { color, label } = linkGroupDefinition(linkGroup);
  return (
    <section
      className="cpDemo-panel"
      style={{ "--channel-color": color } as CSSProperties}
    >
      <header className="cpDemo-panelHeader">
        <span>{title}</span>
        <span className="cpDemo-panelChannel">
          {pinned ? <span className="cpDemo-pinned">Pinned</span> : null}
          <span aria-hidden="true" className="cpDemo-dot" />
          <span>
            <span className="cpDemo-srOnly">{label} channel: </span>
            {selectedInstrument?.ric ?? "No instrument"}
          </span>
        </span>
      </header>
      <div className="cpDemo-panelBody">{children}</div>
    </section>
  );
};

/**
 * Panels in the `active` link group (they follow the picker's channel),
 * plus one pinned to Blue.
 */
const BoundPanels = () => {
  const { activeChannel } = useWorkspaceChannel();
  return (
    <div className="cpDemo-panels">
      <Panel linkGroup={activeChannel} title="Chart">
        <PriceChart
          account={ACCOUNT}
          defaultInterval="1s"
          linkGroup={ACTIVE_LINK_GROUP}
          style={{ height: "100%" }}
        />
      </Panel>
      <Panel linkGroup={activeChannel} title="Depth">
        <MarketDepth
          account={ACCOUNT}
          levels={8}
          linkGroup={ACTIVE_LINK_GROUP}
        />
      </Panel>
      <Panel linkGroup={activeChannel} title="Time & sales">
        <TradeTape linkGroup={ACTIVE_LINK_GROUP} />
      </Panel>
      <Panel linkGroup="blue" pinned title="Depth">
        <MarketDepth account={ACCOUNT} levels={8} linkGroup="blue" />
      </Panel>
    </div>
  );
};

/**
 * The picker centred in a workspace title bar. Clicking a channel switches
 * every bound panel to it; the active channel's search button (or a second
 * click) opens the instrument search.
 */
export const ChannelPickerWorkspace = () => {
  useSeedChannels();
  return (
    <WorkspaceChannelProvider defaultActiveChannel="green">
      <div className="cpDemo">
        <TitleBar>
          <ChannelPicker />
        </TitleBar>
        <BoundPanels />
      </div>
    </WorkspaceChannelProvider>
  );
};

const FIXED_WIDTHS = [1100, 680, 580];

/**
 * The same picker in title bars of different widths: full (B) where all
 * channels fit, else compact (A), else dots. The last bar has a width
 * slider.
 */
export const ChannelPickerFit = () => {
  useSeedChannels();
  const [forced, setForced] = useState<ChannelPickerDensity | "auto">("auto");
  const [width, setWidth] = useState(640);
  return (
    <WorkspaceChannelProvider defaultActiveChannel="green">
      <div className="cpDemo-fit">
        <span className="cpDemo-fitControls">
          <Text styleAs="label">Density</Text>
          {(["auto", "full", "compact", "dots"] as const).map((d) => (
            <Button
              aria-pressed={forced === d}
              appearance={forced === d ? "solid" : "bordered"}
              key={d}
              onClick={() => setForced(d)}
            >
              {d}
            </Button>
          ))}
        </span>
        {FIXED_WIDTHS.map((width) => (
          <div className="cpDemo-fitRow" key={width}>
            <Text styleAs="label">{width}px</Text>
            <div className="cpDemo-fitFrame" style={{ width }}>
              <TitleBar>
                <ChannelPicker density={forced} />
              </TitleBar>
            </div>
          </div>
        ))}
        <div className="cpDemo-fitRow">
          <label className="cpDemo-fitSlider">
            <Text styleAs="label">Width {width}px</Text>
            <input
              max={1200}
              min={240}
              onChange={(evt) => setWidth(Number(evt.target.value))}
              step={10}
              type="range"
              value={width}
            />
          </label>
          <div className="cpDemo-fitFrame" style={{ width }}>
            <TitleBar>
              <ChannelPicker density={forced} />
            </TitleBar>
          </div>
        </div>
      </div>
    </WorkspaceChannelProvider>
  );
};
