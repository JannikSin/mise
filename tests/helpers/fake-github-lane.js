// A GitHub lane standing in for the real adapter in composite tests: files in
// a Map, git-looking shas, and a switch that makes every call fail the way an
// unreachable network does.

export function fakeGithubLane() {
  /** @type {Map<string, { data: any, sha: string }>} */
  const files = new Map();
  let n = 0;
  const lane = {
    down: false,
    files,
    /** @type {import("../../app/lib/backend.js").Backend} */
    backend: /** @type {any} */ (null),
  };
  const net = () => {
    if (lane.down) throw new Error("can't reach api.github.com");
  };
  lane.backend = {
    name: "github",
    read: async (path) => {
      net();
      const f = files.get(path);
      return f ? structuredClone(f) : null;
    },
    write: async (path, data) => {
      net();
      const sha = `git${++n}`;
      files.set(path, { data: structuredClone(data), sha });
      return { sha };
    },
    list: async () => {
      net();
      return [];
    },
    readMeta: async (path) => {
      net();
      const f = files.get(path);
      return f ? { sha: f.sha } : null;
    },
    authHeader: async () => null,
    status: async () => ({ privacy: "private", auth: "ok", reachable: true }),
    authBroken: () => false,
    stamp: () => "main",
    laneOf: () => "github",
    session: () => null,
  };
  return lane;
}
