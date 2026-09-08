/**
 * The protocol-server directory's only import surface (eslint
 * `no-restricted-imports`); the siblings are implementation and import each
 * other directly, never this file.
 */

export { internalRoutes } from "./daemon.ts";
export { RESPONSE_SENT, startProtocolServer } from "./protocol-server.ts";
export { permissionRequestOf } from "./permission-broker.ts";
