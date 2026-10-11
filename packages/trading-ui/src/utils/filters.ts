/** Quote a string literal for a vuu filter expression (`ric = ${filterString(ric)}`). */
export const filterString = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
