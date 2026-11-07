import { Button, Input } from "@salt-ds/core";
import { useState } from "react";

const classBase = "tradingBotDetail";

const plain = (value: unknown) =>
  value === null || value === undefined || value === "" ? "–" : String(value);

export interface BotParamListProps {
  /** Rows of botParams or clientBotParams (name, value, spec, baseline). */
  params: readonly Record<string, unknown>[];
  pending: boolean;
  /** Set one parameter; resolves true when it was applied. */
  onSet: (name: string, value: string) => Promise<boolean>;
  "data-testid"?: string;
}

/**
 * A bot's parameters with their specs: editable ones get an input with Set,
 * changed ones are marked with a reset to the baseline. Shared by BotDetail
 * and ClientBotDetail (remount with a `key` per bot to clear drafts).
 */
export const BotParamList = ({
  params,
  pending,
  onSet,
  "data-testid": testId,
}: BotParamListProps) => {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const set = async (name: string, value: string) => {
    if (await onSet(name, value)) setDrafts(({ [name]: _, ...rest }) => rest);
  };
  return (
    <dl data-testid={testId}>
      {params.map((param) => {
        const name = String(param.name);
        const value = String(param.value ?? "");
        const draft = drafts[name];
        const editing = draft !== undefined && draft !== value;
        const numeric = param.type === "number" || param.type === "integer";
        return (
          <div key={String(param.id)} style={{ display: "contents" }}>
            <dt title={plain(param.description)}>
              {name}
              {param.changed ? (
                <span
                  className={`${classBase}-changed`}
                  data-testid="trading-bot-param-changed"
                  title={`Changed from baseline ${plain(param.baseline)}`}
                >
                  {" "}
                  *
                </span>
              ) : null}
            </dt>
            <dd className={`${classBase}-param`}>
              {param.readOnly ? (
                <span>{plain(param.value)}</span>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editing) set(name, draft);
                  }}
                >
                  <Input
                    inputProps={{
                      "aria-label": name,
                      inputMode: numeric ? "decimal" : "text",
                    }}
                    onChange={(e) =>
                      setDrafts((d) => ({
                        ...d,
                        [name]: (e.target as HTMLInputElement).value,
                      }))
                    }
                    style={{ width: 90 }}
                    value={draft ?? value}
                  />
                  {editing ? (
                    <Button
                      disabled={pending}
                      sentiment="accented"
                      type="submit"
                    >
                      Set
                    </Button>
                  ) : null}
                  {param.changed && !editing ? (
                    <Button
                      disabled={pending}
                      onClick={() => set(name, String(param.baseline))}
                      sentiment="neutral"
                    >
                      Reset
                    </Button>
                  ) : null}
                </form>
              )}
              {param.unit ? <small> {plain(param.unit)}</small> : null}
              {numeric &&
              ((param.min ?? null) !== null || (param.max ?? null) !== null) ? (
                <small>
                  {" "}
                  [{plain(param.min)}…{plain(param.max)}]
                </small>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
};
