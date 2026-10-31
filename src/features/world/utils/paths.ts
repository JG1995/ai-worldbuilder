/** The page name shown for a path: its last segment without the `.md` extension. */
export function pageNameOf(path: string) {
  return (path.split("/").at(-1) ?? path).replace(/\.md$/i, "");
}

/** The folder that holds `path`, or null at the world's top level. */
export function parentOf(path: string) {
  const end = path.lastIndexOf("/");
  return end === -1 ? null : path.slice(0, end);
}
