/** Favorite-color options for the profile, plus matching helpers used by search + ranking. */

export const PROFILE_COLORS: { name: string; hex: string }[] = [
  { name: "black", hex: "#111318" },
  { name: "white", hex: "#f3f2ee" },
  { name: "gray", hex: "#8a8f98" },
  { name: "blue", hex: "#3b82f6" },
  { name: "green", hex: "#3fa564" },
  { name: "red", hex: "#e5484d" },
  { name: "pink", hex: "#ec4899" },
  { name: "purple", hex: "#8b5cf6" },
  { name: "beige", hex: "#d8c9a8" },
  { name: "yellow", hex: "#eab308" },
];

export const COLOR_NAMES = PROFILE_COLORS.map((c) => c.name);

/** Shades that count as the same favorite color when matching a product title/attributes. */
const COLOR_SYNONYMS: Record<string, string[]> = {
  black: ["black", "onyx", "jet"],
  white: ["white", "ivory", "off-white", "cream"],
  gray: ["gray", "grey", "charcoal", "slate", "graphite", "gunmetal"],
  blue: ["blue", "navy", "teal", "azure", "cobalt", "indigo"],
  green: ["green", "olive", "emerald", "sage", "forest", "mint"],
  red: ["red", "crimson", "burgundy", "maroon", "scarlet"],
  pink: ["pink", "rose", "blush", "fuchsia", "magenta"],
  purple: ["purple", "violet", "lavender", "plum", "lilac"],
  beige: ["beige", "tan", "khaki", "sand", "camel", "taupe"],
  yellow: ["yellow", "gold", "mustard", "amber"],
};

/** The favorite color the user saved as a tag, if any. */
export function colorFromTags(tags: string[]): string | undefined {
  return COLOR_NAMES.find((c) => tags.includes(c));
}

/** True when a product's title (or attrs) reads as the favorite color, shades included. */
export function colorMatches(text: string, color: string): boolean {
  const t = text.toLowerCase();
  return (COLOR_SYNONYMS[color] ?? [color]).some((w) => new RegExp(`\\b${w}\\b`).test(t));
}
