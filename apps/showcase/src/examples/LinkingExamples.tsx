import {
  AccountSelector,
  InstrumentContextProvider,
  InstrumentLookupProvider,
  InstrumentPicker,
  type LinkGroupId,
  LinkGroupProvider,
  LinkGroupSelector,
  LinkGroupSwatch,
  useInstrumentLookup,
  useSelectedAccount,
  useSelectedInstrument,
} from "@heswell/trading-ui";
import { Text } from "@salt-ds/core";
import { useState } from "react";

const column = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 16,
} as const;

/** The selection of the inherited (or given) link group. */
const SelectionReadout = ({ linkGroup }: { linkGroup?: LinkGroupId }) => {
  const { selectedInstrument, linkGroup: group } = useSelectedInstrument({
    linkGroup,
  });
  return (
    <Text>
      <LinkGroupSwatch group={group} /> {group}:{" "}
      <strong>{selectedInstrument?.ric ?? "–"}</strong>{" "}
      {selectedInstrument?.description ?? ""}
    </Text>
  );
};

/**
 * InstrumentContextProvider with a private bus: the pickers below are not
 * linked to the rest of the showcase. Each LinkGroupProvider puts its
 * subtree in a group; the third readout follows the LinkGroupSelector.
 */
export const LinkingProvidersExample = () => {
  const [group, setGroup] = useState<LinkGroupId>("green");
  return (
    <InstrumentContextProvider
      initialInstrument={{ ric: "VOD.L" }}
      linkGroup="red"
    >
      <div style={column}>
        <Text>
          A private bus (not linked to the header): red starts on VOD.L.
        </Text>
        <LinkGroupProvider linkGroup="red">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <InstrumentPicker style={{ width: 260 }} />
            <SelectionReadout />
          </div>
        </LinkGroupProvider>
        <LinkGroupProvider linkGroup="green">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <InstrumentPicker style={{ width: 260 }} />
            <SelectionReadout />
          </div>
        </LinkGroupProvider>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <LinkGroupSelector onChange={setGroup} value={group} />
          <SelectionReadout linkGroup={group} />
        </div>
      </div>
    </InstrumentContextProvider>
  );
};

/** Static data of the selected instrument, from the nearest lookup. */
const LookupReadout = () => {
  const lookup = useInstrumentLookup();
  const { selectedInstrument } = useSelectedInstrument();
  const instrument = selectedInstrument && lookup.get(selectedInstrument.ric);
  return (
    <Text>
      {lookup.size} instruments loaded. Selected:{" "}
      {instrument
        ? `${instrument.ric} tick ${instrument.tickSize} lot ${instrument.lotSize} ${instrument.currency}`
        : "pick one"}
    </Text>
  );
};

/** InstrumentLookupProvider, AccountSelector and LinkGroupSelector. */
export const SelectorsExample = () => {
  const [account, setAccount, accounts] = useSelectedAccount();
  const [group, setGroup] = useState<LinkGroupId>("red");
  return (
    <div style={column}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Text>Account</Text>
        <AccountSelector
          accounts={accounts}
          onChange={setAccount}
          value={account}
        />
        <Text>
          useSelectedAccount: <strong>{account ?? "–"}</strong>
        </Text>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Text>Link group</Text>
        <LinkGroupSelector onChange={setGroup} value={group} />
        <InstrumentPicker linkGroup={group} style={{ width: 260 }} />
      </div>
      <InstrumentLookupProvider>
        <LookupReadout />
      </InstrumentLookupProvider>
    </div>
  );
};
