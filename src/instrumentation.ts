let databaseBootstrap: Promise<void> | undefined;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  databaseBootstrap ??= import("./db/bootstrap").then(({ bootstrapDatabase }) =>
    bootstrapDatabase(),
  );
  await databaseBootstrap;
}
