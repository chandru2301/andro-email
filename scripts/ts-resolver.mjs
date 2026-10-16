// Minimal resolver: lets Node load the app's extensionless TS imports
// ("./client" -> "./client.ts") so tests can exercise the real modules.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      /* fall through to the default resolution */
    }
  }
  return next(specifier, context);
}
