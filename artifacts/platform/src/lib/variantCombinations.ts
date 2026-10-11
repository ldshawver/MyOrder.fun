export function parseVariantAxes(input: string): Array<{ name: string; values: string[] }> {
  const parts = input.split(";").map(part => part.trim()).filter(Boolean);
  const axes = parts.map(part => {
    const separator = part.indexOf("=");
    if (separator < 0 && parts.length === 1) {
      const values = part.split(",").map(value => value.trim());
      if (!values.length || values.some(value => !value) || new Set(values.map(value => value.toLocaleLowerCase())).size !== values.length) {
        throw new Error("Each option needs unique, non-empty values");
      }
      return { name: "Option", values };
    }
    if (separator < 1) throw new Error("Use Size=Small,Large; a lone comma list is treated as values of one Option axis");
    const name = part.slice(0, separator).trim();
    const values = part.slice(separator + 1).split(",").map(value => value.trim());
    if (!name || !values.length || values.some(value => !value) || new Set(values.map(value => value.toLocaleLowerCase())).size !== values.length) {
      throw new Error("Each option needs unique, non-empty values");
    }
    return { name, values };
  });
  if (!axes.length || axes.length > 8 || new Set(axes.map(axis => axis.name.toLocaleLowerCase())).size !== axes.length) {
    throw new Error("Provide one to eight uniquely named options");
  }
  const combinations = axes.reduce((count, axis) => count * axis.values.length, 1);
  if (combinations > 500) throw new Error("A product may generate at most 500 variants at once");
  return axes;
}

export function generateVariantCombinations(axes: Array<{ name: string; values: string[] }>): Array<Record<string, string>> {
  return axes.reduce<Array<Record<string, string>>>((combinations, axis) =>
    combinations.flatMap(existing => axis.values.map(value => ({ ...existing, [axis.name]: value }))), [{}]);
}
