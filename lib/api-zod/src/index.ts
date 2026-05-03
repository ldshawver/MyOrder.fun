export * from "./generated/api";
// Re-export generated types as type-only to avoid value-vs-type collisions
// with the zod schema constants in ./generated/api (e.g. `UpdateUserRoleBody`
// exists as a zod object value AND as an interface in ./generated/types).
// The runtime constants from ./generated/api take precedence; consumers who
// need the static type can `import type { UpdateUserRoleBody } from "@workspace/api-zod"`.
export type * from "./generated/types";
