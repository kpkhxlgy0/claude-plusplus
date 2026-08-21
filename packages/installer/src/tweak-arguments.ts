export interface CreateTweakArguments {
  target: string;
  id?: string;
  name?: string;
  repo?: string;
  scope?: "renderer" | "main" | "both";
  force: boolean;
}

export interface ValidateTweakArguments {
  target: string;
}

export interface DevTweakArguments {
  target: string;
  name?: string;
  replace: boolean;
  watch: boolean;
}

type FlagKind = "boolean" | "value";

const CREATE_FLAGS: Readonly<Record<string, FlagKind>> = {
  "--id": "value",
  "--name": "value",
  "--repo": "value",
  "--scope": "value",
  "--force": "boolean",
};

const DEV_FLAGS: Readonly<Record<string, FlagKind>> = {
  "--name": "value",
  "--replace": "boolean",
  "--no-watch": "boolean",
};

export function parseCreateTweakArguments(argv: string[]): CreateTweakArguments {
  const { positionals, options } = parseArguments(argv, CREATE_FLAGS);
  if (positionals.length !== 1) {
    throw new Error("create-tweak requires exactly one target");
  }

  const id = valueOption(options, "--id");
  const name = valueOption(options, "--name");
  const repo = valueOption(options, "--repo");
  const scope = valueOption(options, "--scope");
  if (scope !== undefined && scope !== "renderer" && scope !== "main" && scope !== "both") {
    throw new Error(`invalid --scope: ${scope}`);
  }

  return {
    target: positionals[0]!,
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(repo === undefined ? {} : { repo }),
    ...(scope === undefined ? {} : { scope }),
    force: options.has("--force"),
  };
}

export function parseValidateTweakArguments(argv: string[]): ValidateTweakArguments {
  const { positionals } = parseArguments(argv, {});
  if (positionals.length > 1) {
    throw new Error("validate-tweak accepts at most one target");
  }
  return { target: positionals[0] ?? "." };
}

export function parseDevTweakArguments(argv: string[]): DevTweakArguments {
  const { positionals, options } = parseArguments(argv, DEV_FLAGS);
  if (positionals.length > 1) {
    throw new Error("dev accepts at most one target");
  }

  const name = valueOption(options, "--name");
  return {
    target: positionals[0] ?? ".",
    ...(name === undefined ? {} : { name }),
    replace: options.has("--replace"),
    watch: !options.has("--no-watch"),
  };
}

function parseArguments(
  argv: string[],
  flags: Readonly<Record<string, FlagKind>>,
): { positionals: string[]; options: Map<string, string | true> } {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      if (token.startsWith("-")) throw new Error(`unknown option: ${token}`);
      positionals.push(token);
      continue;
    }
    const kind = flags[token];
    if (!kind) throw new Error(`unknown option: ${token}`);
    if (options.has(token)) throw new Error(`duplicate option: ${token}`);
    if (kind === "boolean") {
      options.set(token, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`${token} requires a value`);
    options.set(token, value);
    index += 1;
  }
  return { positionals, options };
}

function valueOption(options: Map<string, string | true>, flag: string): string | undefined {
  const value = options.get(flag);
  return typeof value === "string" ? value : undefined;
}
