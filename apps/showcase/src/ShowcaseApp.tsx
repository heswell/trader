import {
  InstrumentContextProvider,
  TradingDataProvider,
  useSelectedInstrument,
} from "@heswell/trading-ui";
import {
  Link,
  StackLayout,
  Text,
  ToggleButton,
  ToggleButtonGroup,
} from "@salt-ds/core";
import { type SyntheticEvent, useEffect, useState } from "react";
import "./ShowcaseApp.css";
import { examples } from "./examples";
import {
  REMOTE_CONNECTION_ID,
  type ShowcaseDataMode,
  useShowcaseDataMode,
} from "./useShowcaseDataMode";

const exampleFromHash = () =>
  examples.find(({ id }) => `#${id}` === window.location.hash) ?? examples[0];

const groups = [...new Set(examples.map(({ group }) => group))];

const SelectedInstrument = () => {
  const { selectedInstrument } = useSelectedInstrument();
  return <Text>Instrument: {selectedInstrument?.ric ?? "none"}</Text>;
};

export const ShowcaseApp = () => {
  const [example, setExample] = useState(exampleFromHash);
  const { error, localServer, mode, remoteStatus, switchMode } =
    useShowcaseDataMode();

  useEffect(() => {
    const onHashChange = () => setExample(exampleFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const { Component } = example;
  return (
    <InstrumentContextProvider>
      <div className="showcaseApp">
        <header className="showcaseApp-header">
          <span className="showcaseApp-title">Trading UI showcase</span>
          <SelectedInstrument />
          {error ? <Text color="error">{error}</Text> : null}
          <ToggleButtonGroup
            aria-label="Data source"
            value={mode}
            onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
              switchMode(e.currentTarget.value as ShowcaseDataMode)
            }
          >
            <ToggleButton value="local">Local test data</ToggleButton>
            <ToggleButton value="remote">
              {remoteStatus === "connecting" ? "Connecting…" : "Remote server"}
            </ToggleButton>
          </ToggleButtonGroup>
        </header>
        <nav className="showcaseApp-nav" aria-label="Examples">
          {groups.map((group) => (
            <StackLayout key={group} gap={0.5}>
              <div className="showcaseApp-group">{group}</div>
              {examples
                .filter((e) => e.group === group)
                .map(({ id, title }) => (
                  <Link
                    key={id}
                    href={`#${id}`}
                    aria-current={id === example.id ? "page" : undefined}
                  >
                    {title}
                  </Link>
                ))}
            </StackLayout>
          ))}
        </nav>
        <main className="showcaseApp-main">
          {example.description ? (
            <p className="showcaseApp-description">{example.description}</p>
          ) : null}
          <div className="showcaseApp-example">
            {mode === "local" ? (
              <TradingDataProvider
                key="local"
                mode="local"
                localServer={localServer}
              >
                <Component key={example.id} />
              </TradingDataProvider>
            ) : (
              <TradingDataProvider
                key="remote"
                mode="remote"
                connectionId={REMOTE_CONNECTION_ID}
              >
                <Component key={example.id} />
              </TradingDataProvider>
            )}
          </div>
        </main>
      </div>
    </InstrumentContextProvider>
  );
};
