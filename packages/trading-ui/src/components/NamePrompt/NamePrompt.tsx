import {
  FormField,
  FormFieldHelperText,
  FormFieldLabel,
  Input,
} from "@salt-ds/core";
import { Prompt } from "@vuu-ui/vuu-ui-controls";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

const classBase = "tradingNamePrompt";

export interface NamePromptProps {
  /** More fields, under the name (e.g. where a new item is available). */
  children?: ReactNode;
  /** Confirm button label, e.g. "Create". */
  confirmLabel?: string;
  /** Starting value, e.g. the current name when renaming. */
  initialName?: string;
  /** Field label. */
  label?: string;
  maxLength?: number;
  onClose: () => void;
  /** Called with the trimmed name; the prompt then closes. */
  onConfirm: (name: string) => void;
  open?: boolean;
  placeholder?: string;
  title: string;
  /**
   * The error for a trimmed, non-empty name, or undefined when it is
   * valid. A blank name only disables the confirm button.
   */
  validate?: (name: string) => string | undefined;
}

/**
 * A vuu Prompt (Salt Dialog) asking for a name: the grid's replacement for
 * window.prompt. Enter confirms a valid name, Esc cancels.
 */
export const NamePrompt = ({
  children,
  confirmLabel = "Create",
  initialName = "",
  label = "Name",
  maxLength = 40,
  onClose,
  onConfirm,
  open = true,
  placeholder,
  title,
  validate,
}: NamePromptProps) => {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  const name = value.trim();
  const error = name ? validate?.(name) : undefined;
  const valid = name !== "" && error === undefined;

  // The Dialog moves focus to itself as it opens; take it for the field.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => inputRef.current?.select(), 50);
    return () => clearTimeout(timer);
  }, [open]);

  const confirm = () => {
    if (!valid) return false;
    onConfirm(name);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (confirm() !== false) onClose();
    }
  };

  return (
    <Prompt
      className={classBase}
      confirmButtonProps={{ disabled: !valid, label: confirmLabel }}
      disableAccent
      onClose={onClose}
      onConfirm={confirm}
      open={open}
      title={title}
    >
      <FormField validationStatus={error ? "error" : undefined}>
        <FormFieldLabel>{label}</FormFieldLabel>
        <Input
          inputProps={{
            "aria-label": label,
            autoComplete: "off",
            maxLength,
            onChange: (e) => setValue(e.target.value),
            onKeyDown: handleKeyDown,
            spellCheck: false,
          }}
          inputRef={inputRef}
          placeholder={placeholder}
          value={value}
        />
        {error ? <FormFieldHelperText>{error}</FormFieldHelperText> : null}
      </FormField>
      {children}
    </Prompt>
  );
};
