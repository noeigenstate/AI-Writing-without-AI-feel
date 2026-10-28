/** Small controlled form widgets shared by the rewrite, article and fiction setup views. */
export interface Option<T extends string> {
  id: T;
  label: string;
}

interface OptionSelectProps<T extends string> {
  id: string;
  className?: string;
  value: T;
  options: readonly Option<T>[];
  /** Label of a leading entry with an empty value (e.g. "no style"). */
  emptyLabel?: string;
  onChange: (value: T) => void;
}

export function OptionSelect<T extends string>({
  id,
  className = "styleselect compact",
  value,
  options,
  emptyLabel,
  onChange,
}: OptionSelectProps<T>) {
  return (
    <select id={id} className={className} value={value} onChange={(event) => onChange(event.target.value as T)}>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface SegmentedControlProps<T extends string> {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

/** A row of toggle buttons where exactly one option is pressed. */
export function SegmentedControl<T extends string>({ options, value, onChange, ...labelling }: SegmentedControlProps<T>) {
  return (
    <div className="segment" role="group" {...labelling}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={value === option.id ? "active" : ""}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
