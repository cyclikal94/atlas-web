/**
 * Which public surface the neutral root draws when nobody is signed in. There is no router in the neutral root: the path
 * decides, and any other path keeps its URL through sign-in (a deep link opens after sign-in, with no `next` parameter and
 * so no open redirect).
 */
export type PublicSurface = "join" | "sign-in";

export const JOIN_PATH = "/join";

export const isJoinPath = (pathname: string): boolean =>
  pathname === JOIN_PATH || pathname === `${JOIN_PATH}/`;

export const publicSurfaceFor = (pathname: string): PublicSurface =>
  isJoinPath(pathname) ? "join" : "sign-in";
