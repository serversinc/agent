/**
 * Replaces every `Config.Env` value in an inspect with `[redacted]`, keeping
 * each entry's key (the text before the first `=`). An entry without `=` gets
 * `=[redacted]` appended, and an empty entry is left as is.
 */
export function redactInspect<T>(inspect: T): T {
  if (inspect === null || typeof inspect !== "object") {
    return inspect;
  }

  const source = inspect as { Config?: { Env?: string[] } | null };

  if (!source.Config || !Array.isArray(source.Config.Env)) {
    return inspect;
  }

  return {
    ...source,
    Config: {
      ...source.Config,
      Env: source.Config.Env.map(entry => (entry === "" ? entry : `${entry.split("=")[0]}=[redacted]`)),
    },
  } as T;
}
