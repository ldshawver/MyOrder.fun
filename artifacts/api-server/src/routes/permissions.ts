// Compatibility shim: the canonical role/permission API lives in
// ./role-permissions.  Keep this module as a single-source re-export so tests
// and any older imports cannot drift into a duplicate implementation.
export { default } from "./role-permissions";
