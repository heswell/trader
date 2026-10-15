/**
 * Generates the API reference of the reusable front-end packages from their
 * TypeScript source (exports, signatures, props, defaults, JSDoc), plus a
 * component catalogue (tables, RPCs, CSS hooks, showcase examples, guides).
 *
 *   bun run docs:api           write docs/api/*.md
 *   bun run docs:api --check   fail if docs/api is out of date, an exported
 *                              function / component / hook / class has no
 *                              JSDoc, or a component has no showcase example
 *                              or guide
 *
 * The output is deterministic (no dates, sorted), so `--check` is stable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { COMPONENT_GUIDES } from "../../apps/showcase/src/examples/docs";

const ROOT = resolve(import.meta.dir, "../..");
const OUT_DIR = join(ROOT, "docs/api");
const check = process.argv.includes("--check");

interface Entry {
  /** Import specifier, e.g. `@heswell/trading-ui`. */
  specifier: string;
  file: string;
}

interface PackageDoc {
  name: string;
  out: string;
  title: string;
  intro: string;
  entries: Entry[];
}

const PACKAGES: PackageDoc[] = [
  {
    name: "@heswell/trading-ui",
    out: "trading-ui.md",
    title: "@heswell/trading-ui API reference",
    intro:
      "Every export of `@heswell/trading-ui`: React components, hooks, providers, data access, instrument linking, connection state, notifications and utilities. Guides: [components](../components/README.md), [catalogue](components.md), [UI guide](../ui-guide.md), [getting started](../getting-started.md).",
    entries: [
      {
        specifier: "@heswell/trading-ui",
        file: "packages/trading-ui/src/index.ts",
      },
    ],
  },
  {
    name: "@heswell/trading-schemas",
    out: "trading-schemas.md",
    title: "@heswell/trading-schemas API reference",
    intro:
      "The client entry of `@heswell/trading-schemas`: table definitions, enums, RPC contracts and validation, tick / lot maths. Shared by the UI, the servers and the in-browser engines. Overview: [schemas.md](../schemas.md), [package README](../../packages/trading-schemas/README.md).",
    entries: [
      {
        specifier: "@heswell/trading-schemas",
        file: "packages/trading-schemas/src/index.ts",
      },
    ],
  },
  {
    name: "@heswell/trading-test-data",
    out: "trading-test-data.md",
    title: "@heswell/trading-test-data API reference",
    intro:
      "The in-browser EXCHANGE + OMS (the real exchange-sim and OMS engines on `@heswell/vuu-data-engine-local`) behind the showcase, the tests and the engine-local mode of [getting started](../getting-started.md#2-engine-local-mode-no-servers). [Package README](../../packages/trading-test-data/README.md).",
    entries: [
      {
        specifier: "@heswell/trading-test-data",
        file: "packages/trading-test-data/src/index.ts",
      },
      {
        specifier: "@heswell/trading-test-data/react",
        file: "packages/trading-test-data/src/react.ts",
      },
    ],
  },
];

const UI_SRC = "packages/trading-ui/src";
const SHOWCASE_EXAMPLES = "apps/showcase/src/examples";
/** Files of the showcase host, which mounts its components around every example. */
const SHOWCASE_HOST_FILES = [
  "apps/showcase/src/ShowcaseApp.tsx",
  "apps/showcase/src/ShowcaseTradingHost.tsx",
];

// ------------------------------------------------------------------ program

const parsedConfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config,
  ts.sys,
  ROOT,
);
const rootFiles = [
  ...PACKAGES.flatMap((p) => p.entries.map((e) => join(ROOT, e.file))),
  join(ROOT, SHOWCASE_EXAMPLES, "index.ts"),
  ...SHOWCASE_HOST_FILES.map((f) => join(ROOT, f)),
];
const program = ts.createProgram(rootFiles, parsedConfig.options);
const checker = program.getTypeChecker();

const rel = (file: string) => relative(ROOT, file).split("\\").join("/");
const isOwnSource = (file: string) =>
  !file.includes("/node_modules/") && rel(file).startsWith("packages/");
/** The package of a node_modules file (the innermost node_modules). */
const packageOf = (file: string) =>
  [...rel(file).matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)].pop()?.[1];
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const cell = (text: string) => oneLine(text).replace(/\|/g, "\\|");
const code = (text: string) => {
  const t = cell(text);
  return t.includes("`")
    ? `<code>${t.replace(/</g, "&lt;")}</code>`
    : `\`${t}\``;
};

// ------------------------------------------------------------------ jsdoc

const docOf = (symbol: ts.Symbol) =>
  ts
    .displayPartsToString(symbol.getDocumentationComment(checker))
    .trim()
    .replace(/\r\n/g, "\n");

const tagOf = (symbol: ts.Symbol, name: string) => {
  const tag = symbol.getJsDocTags(checker).find((t) => t.name === name);
  return tag ? ts.displayPartsToString(tag.text).trim() : undefined;
};

// ------------------------------------------------------------------ kinds

type Kind =
  | "component"
  | "hook"
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const";

interface ApiItem {
  name: string;
  kind: Kind;
  symbol: ts.Symbol;
  decl: ts.Declaration;
  file: string;
  /** Re-export of a third-party package. */
  external?: string;
  doc: string;
}

type FunctionNode =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration;

const isFunctionLike = (node: ts.Node | undefined): node is FunctionNode =>
  !!node &&
  (ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node));

/** The function implementing an export: unwraps forwardRef / memo calls. */
const implementation = (
  node: ts.Node | undefined,
): FunctionNode | undefined => {
  if (!node) return undefined;
  if (isFunctionLike(node)) return node;
  if (ts.isVariableDeclaration(node)) return implementation(node.initializer);
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))
    return implementation(node.expression);
  if (ts.isCallExpression(node)) {
    for (const arg of node.arguments) {
      const fn = implementation(arg);
      if (fn) return fn;
    }
  }
  return undefined;
};

const callSignature = (symbol: ts.Symbol, decl: ts.Declaration) =>
  checker.getSignaturesOfType(
    checker.getTypeOfSymbolAtLocation(symbol, decl),
    ts.SignatureKind.Call,
  )[0];

const kindOf = (
  name: string,
  symbol: ts.Symbol,
  decl: ts.Declaration,
): Kind => {
  if (ts.isInterfaceDeclaration(decl)) return "interface";
  if (ts.isTypeAliasDeclaration(decl)) return "type";
  if (ts.isEnumDeclaration(decl)) return "enum";
  if (ts.isClassDeclaration(decl)) return "class";
  const fnLike =
    ts.isFunctionDeclaration(decl) ||
    (ts.isVariableDeclaration(decl) && !!implementation(decl));
  if (!fnLike) return "const";
  if (/^use[A-Z0-9]/.test(name)) return "hook";
  const sig = callSignature(symbol, decl);
  const type = checker.typeToString(
    checker.getTypeOfSymbolAtLocation(symbol, decl),
  );
  const returns = sig ? checker.typeToString(sig.getReturnType()) : "";
  if (
    /^[A-Z]/.test(name) &&
    (/ExoticComponent|FunctionComponent|\bFC</.test(type) ||
      /Element|ReactNode/.test(returns))
  )
    return "component";
  return "function";
};

const collectItems = (entry: Entry): ApiItem[] => {
  const sf = program.getSourceFile(join(ROOT, entry.file));
  if (!sf) throw Error(`not in program: ${entry.file}`);
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) throw Error(`no module symbol: ${entry.file}`);
  const items: ApiItem[] = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported;
    const decls = symbol.getDeclarations() ?? [];
    // a value + type of the same name (`const Side` + `type Side`): document
    // the value
    const decl = decls.find((d) => !ts.isTypeAliasDeclaration(d)) ?? decls[0];
    if (!decl) continue;
    const file = decl.getSourceFile().fileName;
    const name = exported.getName();
    const external = isOwnSource(file)
      ? undefined
      : (packageOf(file) ?? rel(file));
    items.push({
      name,
      kind: external ? "const" : kindOf(name, symbol, decl),
      symbol,
      decl,
      file,
      external,
      doc: docOf(symbol),
    });
  }
  return items;
};

// ------------------------------------------------------------------ members

interface Member {
  name: string;
  type: string;
  optional: boolean;
  defaultValue?: string;
  doc: string;
  /** Declaring interface when not the documented one (e.g. LinkGroupProps). */
  from?: string;
}

const typeText = (symbol: ts.Symbol, decl: ts.Declaration) => {
  if (
    (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) &&
    decl.type
  )
    return decl.type.getText();
  if (ts.isMethodSignature(decl)) {
    const params = decl.parameters.map((p) => p.getText()).join(", ");
    return `(${params}) => ${decl.type?.getText() ?? "void"}`;
  }
  return checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, decl));
};

const containerName = (decl: ts.Declaration) => {
  const parent = decl.parent;
  if (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent))
    return parent.name?.getText();
  if (ts.isTypeLiteralNode(parent) && ts.isTypeAliasDeclaration(parent.parent))
    return parent.parent.name.getText();
  return undefined;
};

/**
 * Members of a type declared in this repo; members inherited from
 * third-party types (React HTMLAttributes, ...) are summarised by name.
 */
const membersOf = (type: ts.Type, ownName: string | undefined) => {
  const members: Member[] = [];
  const inherited = new Set<string>();
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.getDeclarations()?.[0];
    if (!decl) continue;
    if (!isOwnSource(decl.getSourceFile().fileName)) {
      const container = containerName(decl);
      const pkg = packageOf(decl.getSourceFile().fileName);
      inherited.add(
        container ? `${container}${pkg ? ` (${pkg})` : ""}` : (pkg ?? "?"),
      );
      continue;
    }
    const from = containerName(decl);
    members.push({
      name: prop.getName(),
      type: typeText(prop, decl),
      optional: !!(prop.flags & ts.SymbolFlags.Optional),
      defaultValue: tagOf(prop, "default"),
      doc: docOf(prop),
      from: from && from !== ownName ? from : undefined,
    });
  }
  return { members, inherited: [...inherited].sort() };
};

/**
 * Destructuring defaults of a component's props parameter. A wrapper that
 * spreads its props onto another component (`<Inner {...props} />`) is
 * followed to that component.
 */
const propDefaults = (
  fn: FunctionNode | undefined,
  depth = 0,
): Map<string, string> => {
  const defaults = new Map<string, string>();
  const param = fn?.parameters[0];
  if (!fn || !param || depth > 3) return defaults;
  const readPattern = (pattern: ts.ObjectBindingPattern) => {
    for (const el of pattern.elements) {
      if (!el.initializer) continue;
      const key = (el.propertyName ?? el.name).getText().replace(/^"|"$/g, "");
      defaults.set(key, el.initializer.getText());
    }
  };
  if (ts.isObjectBindingPattern(param.name)) readPattern(param.name);
  else if (ts.isIdentifier(param.name) && fn.body) {
    const propsName = param.name.text;
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        node.initializer.text === propsName
      )
        readPattern(node.name);
      if (!isFunctionLike(node)) ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    if (defaults.size === 0) {
      let inner: FunctionNode | undefined;
      const findSpread = (node: ts.Node) => {
        if (
          !inner &&
          ts.isJsxSpreadAttribute(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === propsName
        ) {
          const tag = node.parent.parent;
          if (ts.isJsxOpeningElement(tag) || ts.isJsxSelfClosingElement(tag)) {
            const symbol = checker.getSymbolAtLocation(tag.tagName);
            inner = implementation(symbol?.getDeclarations()?.[0]);
          }
        }
        ts.forEachChild(node, findSpread);
      };
      ts.forEachChild(fn.body, findSpread);
      if (inner && inner !== fn) return propDefaults(inner, depth + 1);
    }
  }
  return defaults;
};

const memberTable = (members: Member[], label = "Prop") => {
  if (members.length === 0) return "";
  const rows = members.map((m) => {
    const desc = [oneLine(m.doc), m.from && `(from \`${m.from}\`)`]
      .filter(Boolean)
      .join(" ");
    return `| \`${m.name}${m.optional ? "?" : ""}\` | ${code(m.type)} | ${m.defaultValue ? code(m.defaultValue) : ""} | ${cell(desc)} |`;
  });
  return [
    `| ${label} | Type | Default | Description |`,
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
};

// ------------------------------------------------------------------ signatures

const signatureOf = (item: ApiItem) => {
  const fn = implementation(item.decl);
  const sig = callSignature(item.symbol, item.decl);
  const params = fn
    ? fn.parameters.map((p) => oneLine(p.getText())).join(", ")
    : (sig?.parameters
        .map(
          (p) =>
            `${p.getName()}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(p, item.decl))}`,
        )
        .join(", ") ?? "");
  const returns = fn?.type
    ? oneLine(fn.type.getText())
    : sig
      ? checker.typeToString(sig.getReturnType())
      : "unknown";
  const typeParams = fn?.typeParameters
    ? `<${fn.typeParameters.map((p) => p.getText()).join(", ")}>`
    : "";
  return `${item.name}${typeParams}(${params}): ${returns}`;
};

// ------------------------------------------------------------------ render

/** GitHub's heading anchor for a plain identifier heading. */
const anchor = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");

const sourceLink = (item: ApiItem) => {
  const sf = item.decl.getSourceFile();
  const line = sf.getLineAndCharacterOfPosition(item.decl.getStart()).line + 1;
  const label = rel(item.file).replace(/^packages\/[^/]+\/src\//, "");
  return `[${label}](${relative(OUT_DIR, item.file)}#L${line})`;
};

const KIND_LABEL: Record<Kind, string> = {
  component: "Components",
  hook: "Hooks",
  function: "Functions",
  class: "Classes",
  interface: "Interfaces",
  type: "Types",
  enum: "Enums",
  const: "Constants",
};

/** Section (folder) of an export, e.g. `components/OrderBlotter`, `data`. */
const sectionOf = (item: ApiItem) => {
  if (item.external) return "re-exports";
  const parts = rel(item.file)
    .replace(/^packages\/[^/]+\/src\//, "")
    .split("/");
  if (parts[0] === "components" && parts.length > 2)
    return `components/${parts[1]}`;
  return parts.length > 1 ? parts[0] : parts[0].replace(/\.tsx?$/, "");
};

/** The props type name as written: `forwardRef<E, Props>` or `(props: Props)`. */
const declaredPropsName = (decl: ts.Declaration) => {
  let node: ts.Node | undefined = ts.isVariableDeclaration(decl)
    ? decl.initializer
    : decl;
  while (node && ts.isCallExpression(node)) {
    const typeArg = node.typeArguments?.[1] ?? node.typeArguments?.[0];
    if (
      node.typeArguments?.length === 2 &&
      typeArg &&
      ts.isTypeReferenceNode(typeArg)
    )
      return typeArg.typeName.getText();
    node = node.arguments[0];
  }
  const paramType = implementation(decl)?.parameters[0]?.type;
  return paramType && ts.isTypeReferenceNode(paramType)
    ? paramType.typeName.getText()
    : undefined;
};

const propsTypeOf = (item: ApiItem) => {
  const param = callSignature(item.symbol, item.decl)?.parameters[0];
  if (!param) return undefined;
  const type = checker.getTypeOfSymbolAtLocation(param, item.decl);
  const named = type.aliasSymbol ?? type.getSymbol();
  const name =
    declaredPropsName(item.decl) ??
    (named && !/^__/.test(named.getName()) ? named.getName() : undefined);
  return { type, name };
};

const heritageOf = (
  decl: ts.InterfaceDeclaration | ts.ClassDeclaration,
): string | undefined =>
  decl.heritageClauses
    ?.flatMap((h) => h.types.map((t) => oneLine(t.getText())))
    .join(", ");

/** React's DOM attribute interfaces, summarised as one phrase. */
const REACT_DOM =
  /^(AriaAttributes|Attributes|DOMAttributes|HTMLAttributes|SVGAttributes|RefAttributes) \(@types\/react\)$/;

const summariseInherited = (inherited: string[]) => {
  const dom = inherited.filter((i) => REACT_DOM.test(i));
  const rest = inherited.filter((i) => !REACT_DOM.test(i));
  const parts: string[] = [];
  if (dom.length) {
    const kind = dom.some((i) => i.startsWith("SVG")) ? "SVG" : "HTML";
    const ref = dom.some((i) => i.startsWith("RefAttributes"));
    parts.push(`the standard ${kind} attributes${ref ? " and `ref`" : ""}`);
  }
  if (rest.length)
    parts.push(`the props of ${rest.map((i) => `\`${i}\``).join(", ")}`);
  return parts.join(", and ");
};

const renderItem = (item: ApiItem, propsOwners: Map<string, string>) => {
  const lines: string[] = [`#### ${item.name}`, ""];
  if (item.external) {
    lines.push(`*re-export* from \`${item.external}\``, "");
    if (item.doc) lines.push(item.doc, "");
    return lines.join("\n");
  }
  lines.push(`*${item.kind}* · ${sourceLink(item)}`, "");
  if (item.doc) lines.push(item.doc, "");
  const owner = propsOwners.get(item.name);

  switch (item.kind) {
    case "component": {
      const props = propsTypeOf(item);
      if (!props) break;
      const { members, inherited } = membersOf(props.type, props.name);
      const defaults = propDefaults(implementation(item.decl));
      for (const m of members)
        if (!m.defaultValue && defaults.has(m.name))
          m.defaultValue = defaults.get(m.name);
      if (props.name) lines.push(`Props: \`${props.name}\``, "");
      if (props.type.isUnion()) {
        // A discriminated union: one table per variant.
        lines.push("One of:", "");
        for (const variant of props.type.types) {
          const v = membersOf(variant, props.name).members;
          for (const m of v)
            if (!m.defaultValue && defaults.has(m.name))
              m.defaultValue = defaults.get(m.name);
          lines.push(memberTable(v));
        }
      } else lines.push(memberTable(members));
      if (inherited.length)
        lines.push(`Also accepts ${summariseInherited(inherited)}.`, "");
      break;
    }
    case "hook":
    case "function":
      lines.push("```ts", signatureOf(item), "```", "");
      break;
    case "interface": {
      if (owner) {
        lines.push(`Props of [\`${owner}\`](#${anchor(owner)}).`, "");
        break;
      }
      const heritage = heritageOf(item.decl as ts.InterfaceDeclaration);
      if (heritage) lines.push(`Extends ${code(heritage)}.`, "");
      const { members, inherited } = membersOf(
        checker.getDeclaredTypeOfSymbol(item.symbol),
        item.name,
      );
      lines.push(memberTable(members, "Member"));
      if (inherited.length)
        lines.push(
          `Inherits ${inherited.map((i) => `\`${i}\``).join(", ")}.`,
          "",
        );
      break;
    }
    case "type": {
      if (owner) {
        lines.push(`Props of [\`${owner}\`](#${anchor(owner)}).`, "");
        break;
      }
      const decl = item.decl as ts.TypeAliasDeclaration;
      if (ts.isTypeLiteralNode(decl.type)) {
        const { members } = membersOf(
          checker.getTypeAtLocation(decl.type),
          item.name,
        );
        lines.push(memberTable(members, "Member"));
      } else {
        const params = decl.typeParameters
          ? `<${decl.typeParameters.map((p) => p.getText()).join(", ")}>`
          : "";
        lines.push(
          "```ts",
          `type ${item.name}${params} = ${decl.type.getText()}`,
          "```",
          "",
        );
      }
      break;
    }
    case "enum": {
      const decl = item.decl as ts.EnumDeclaration;
      lines.push(
        `Members: ${decl.members.map((m) => code(m.getText())).join(", ")}`,
        "",
      );
      break;
    }
    case "class": {
      const decl = item.decl as ts.ClassDeclaration;
      const heritage = heritageOf(decl);
      if (heritage) lines.push(`Extends ${code(heritage)}.`, "");
      const ctor = decl.members.find(ts.isConstructorDeclaration);
      if (ctor)
        lines.push(
          "```ts",
          `new ${item.name}(${ctor.parameters.map((p) => oneLine(p.getText())).join(", ")})`,
          "```",
          "",
        );
      const rows = decl.members
        .filter(
          (m) =>
            (ts.isMethodDeclaration(m) ||
              ts.isPropertyDeclaration(m) ||
              ts.isGetAccessor(m)) &&
            m.name &&
            !ts.isPrivateIdentifier(m.name) &&
            !(
              ts.getCombinedModifierFlags(m as ts.Declaration) &
              (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)
            ),
        )
        .map((m) => {
          const name = m.name as ts.PropertyName;
          const sym = checker.getSymbolAtLocation(name);
          const text = ts.isMethodDeclaration(m)
            ? `${name.getText()}(${m.parameters.map((p) => oneLine(p.getText())).join(", ")})`
            : name.getText();
          return `| ${code(text)} | ${cell(sym ? docOf(sym) : "")} |`;
        });
      if (rows.length)
        lines.push("| Member | Description |", "| --- | --- |", ...rows, "");
      break;
    }
    case "const": {
      const decl = item.decl as ts.VariableDeclaration;
      const text = decl.type
        ? decl.type.getText()
        : checker.typeToString(
            checker.getTypeOfSymbolAtLocation(item.symbol, item.decl),
          );
      lines.push("```ts", `const ${item.name}: ${oneLine(text)}`, "```", "");
      break;
    }
  }
  return lines.join("\n");
};

const SECTION_ORDER = [
  "data",
  "instrument-context",
  "hooks",
  "connection",
  "notifications",
  "feature-root",
  "components",
  "utils",
];
const sectionRank = (section: string) => {
  const i = SECTION_ORDER.indexOf(section.split("/")[0]);
  return i === -1 ? SECTION_ORDER.length : i;
};
const KIND_ORDER: Kind[] = [
  "component",
  "hook",
  "function",
  "class",
  "const",
  "enum",
  "interface",
  "type",
];
const byName = (a: ApiItem, b: ApiItem) => a.name.localeCompare(b.name);

const renderPackage = (pkg: PackageDoc, items: ApiItem[]) => {
  // interfaces / types documented as a component's props table
  const propsOwners = new Map<string, string>();
  for (const item of items.slice().sort(byName))
    if (item.kind === "component") {
      const name = propsTypeOf(item)?.name;
      if (name && items.some((i) => i.name === name) && !propsOwners.has(name))
        propsOwners.set(name, item.name);
    }

  const bySection = new Map<string, ApiItem[]>();
  for (const item of items) {
    const section = sectionOf(item);
    bySection.set(section, [...(bySection.get(section) ?? []), item]);
  }
  const sections = [...bySection.keys()].sort(
    (a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b),
  );

  const out: string[] = [
    `# ${pkg.title}`,
    "",
    "<!-- Generated by scripts/docs/api-reference.ts from the TypeScript source. Do not edit: run `bun run docs:api`. -->",
    "",
    pkg.intro,
    "",
    `Imports: ${pkg.entries.map((e) => `\`${e.specifier}\``).join(", ")}. ${items.length} exports. Types are shown as written in the source; defaults come from \`@default\` tags or the component's destructuring defaults.`,
    "",
    "## Contents",
    "",
  ];
  for (const section of sections)
    out.push(
      `- **${section}**: ${(bySection.get(section) ?? [])
        .slice()
        .sort(byName)
        .map((i) => `[${i.name}](#${anchor(i.name)})`)
        .join(", ")}`,
    );
  out.push("");
  for (const section of sections) {
    out.push(`## ${section}`, "");
    const sectionItems = bySection.get(section) ?? [];
    for (const kind of KIND_ORDER) {
      const ofKind = sectionItems.filter((i) => i.kind === kind).sort(byName);
      if (ofKind.length === 0) continue;
      out.push(`### ${KIND_LABEL[kind]} (${section})`, "");
      for (const item of ofKind) out.push(renderItem(item, propsOwners));
    }
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
};

// ------------------------------------------------------------------ catalogue

/** Relative imports of a file, resolved to source files. */
const relativeImports = (file: string) => {
  const sf = program.getSourceFile(file);
  if (!sf) return [];
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (
      (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text.startsWith(".")
    ) {
      const resolved = ts.resolveModuleName(
        stmt.moduleSpecifier.text,
        file,
        parsedConfig.options,
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      if (resolved && !resolved.endsWith(".css")) out.push(resolved);
    }
  }
  return out;
};

const TABLE_RE =
  /(?:use(?:TradingDataSource|TradingRows)\(\s*|subscribeTradingRows\([^,]+,\s*|\btable = )"(\w+)"/g;
const RPC_RE = /sendTradingRpc\(\s*[\w.]+,\s*(?:"(\w+)"|RpcName\.(\w+))/g;
/** Shared hooks are counted as part of the unit that uses them. */
const DESCEND = /\/src\/hooks\//;

interface UnitFacts {
  tables: Set<string>;
  rpcs: Set<string>;
  editSession: boolean;
  composes: Set<string>;
  classBases: Set<string>;
  cssVars: Set<string>;
  dataAttrs: Set<string>;
}

/** `components/<Name>` or the top-level folder of a trading-ui source file. */
const unitOfFile = (file: string) => {
  const path = rel(file);
  if (!path.startsWith(`${UI_SRC}/`)) return undefined;
  const parts = path.slice(UI_SRC.length + 1).split("/");
  return parts[0] === "components" ? `components/${parts[1]}` : parts[0];
};

const factsOf = (unit: string, files: string[]): UnitFacts => {
  const facts: UnitFacts = {
    tables: new Set(),
    rpcs: new Set(),
    editSession: false,
    composes: new Set(),
    classBases: new Set(),
    cssVars: new Set(),
    dataAttrs: new Set(),
  };
  const seen = new Set<string>();
  const queue = [...files];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(TABLE_RE)) facts.tables.add(m[1]);
    for (const m of text.matchAll(RPC_RE))
      facts.rpcs.add(m[1] ?? m[2].charAt(0).toLowerCase() + m[2].slice(1));
    for (const m of text.matchAll(/classBase = "(\w+)"/g))
      facts.classBases.add(m[1]);
    for (const m of text.matchAll(/["\s{]data-([a-z][a-z-]*)[=:"]/g))
      facts.dataAttrs.add(`data-${m[1]}`);
    for (const imported of relativeImports(file)) {
      const importedUnit = unitOfFile(imported);
      if (rel(imported).endsWith("data/editSessionAmend.ts"))
        facts.editSession = true;
      if (importedUnit === unit || DESCEND.test(imported)) queue.push(imported);
      else if (importedUnit?.startsWith("components/"))
        facts.composes.add(importedUnit.slice("components/".length));
    }
  }
  // CSS custom properties of the unit's stylesheets (theming hooks)
  const dirs = new Set(
    [...seen].filter((f) => unitOfFile(f) === unit).map((f) => dirname(f)),
  );
  for (const dir of dirs)
    for (const css of ts.sys.readDirectory(
      dir,
      [".css"],
      undefined,
      undefined,
      1,
    )) {
      const text = readFileSync(css, "utf8");
      for (const m of text.matchAll(/(--trading[\w-]+)\s*:/g))
        facts.cssVars.add(m[1]);
      for (const m of text.matchAll(/var\((--trading-[\w-]+)/g))
        facts.cssVars.add(m[1]);
    }
  return facts;
};

/** trading-ui exports referenced by each showcase example (transitively). */
const showcaseCoverage = (uiExports: Set<string>) => {
  const sf = program.getSourceFile(join(ROOT, SHOWCASE_EXAMPLES, "index.ts"));
  if (!sf) throw Error("showcase registry not in program");
  const coverage = new Map<string, Set<string>>(); // export -> example ids
  const groups = new Map<string, string>(); // example id -> group
  // Cell renderers are used by name in a TableConfig, not by identifier.
  const renderers = new Map<string, string>(); // renderer name -> component
  for (const file of program.getSourceFiles())
    if (rel(file.fileName).startsWith(`${UI_SRC}/`))
      for (const m of file.text.matchAll(
        /registerComponent\(\s*"([\w.-]+)",\s*(\w+)/g,
      ))
        if (uiExports.has(m[2])) renderers.set(m[1], m[2]);

  /** trading-ui exports a node references, following showcase declarations. */
  const referenced = (root: ts.Node, out: Set<string>, seen: Set<ts.Node>) => {
    if (seen.has(root)) return;
    seen.add(root);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && renderers.has(node.text))
        out.add(renderers.get(node.text) as string);
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        const target =
          symbol && symbol.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(symbol)
            : symbol;
        const targetDecl = target?.getDeclarations()?.[0];
        const file = targetDecl ? rel(targetDecl.getSourceFile().fileName) : "";
        if (file.startsWith(`${UI_SRC}/`) && uiExports.has(node.text))
          out.add(node.text);
        else if (
          targetDecl &&
          file.startsWith("apps/showcase/src/") &&
          (ts.isVariableDeclaration(targetDecl) ||
            ts.isFunctionDeclaration(targetDecl))
        )
          referenced(targetDecl, out, seen);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(root, visit);
  };

  const registry = sf.statements.find(
    (s): s is ts.VariableStatement =>
      ts.isVariableStatement(s) &&
      s.declarationList.declarations[0]?.name.getText() === "examples",
  );
  const array = registry?.declarationList.declarations[0]?.initializer;
  if (!array || !ts.isArrayLiteralExpression(array))
    throw Error("examples registry array not found");
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const prop = (name: string) =>
      element.properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) && p.name.getText() === name,
      )?.initializer;
    const id = (prop("id") as ts.StringLiteral).text;
    groups.set(id, (prop("group") as ts.StringLiteral).text);
    const component = prop("Component");
    const symbol = component && checker.getSymbolAtLocation(component);
    const target =
      symbol && symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    const decl = target?.getDeclarations()?.[0];
    if (!decl) continue;
    const used = new Set<string>();
    referenced(decl, used, new Set());
    for (const name of used)
      coverage.set(name, (coverage.get(name) ?? new Set()).add(id));
  }
  const host = new Set<string>();
  for (const file of SHOWCASE_HOST_FILES) {
    const hostSf = program.getSourceFile(join(ROOT, file));
    if (hostSf) referenced(hostSf, host, new Set());
  }
  return { coverage, groups, host };
};

const list = (values: Iterable<string>) =>
  [...values]
    .sort()
    .map((v) => (v.startsWith("*") ? v : `\`${v}\``))
    .join(", ");

const guideLink = (guide: string | undefined) =>
  guide ? `[guide](../${guide.replace(/^docs\//, "")})` : "";

const renderCatalogue = (uiItems: ApiItem[]) => {
  const components = uiItems.filter((i) => i.kind === "component").sort(byName);
  const { coverage, groups, host } = showcaseCoverage(
    new Set(uiItems.map((i) => i.name)),
  );

  const units = new Map<string, string[]>();
  for (const item of uiItems) {
    const unit = unitOfFile(item.file);
    if (unit)
      units.set(unit, [...new Set([...(units.get(unit) ?? []), item.file])]);
  }
  // Folder facts (CSS hooks, providers) and per-component facts, which start
  // from the file declaring the component (and follow imports in its folder).
  const facts = new Map<string, UnitFacts>();
  for (const [unit, files] of units) facts.set(unit, factsOf(unit, files));
  const componentFacts = new Map<string, UnitFacts>();
  for (const item of components) {
    const unit = unitOfFile(item.file);
    if (unit) componentFacts.set(item.name, factsOf(unit, [item.file]));
  }
  const rpcsOf = (f: UnitFacts | undefined) => [
    ...(f?.rpcs ?? []),
    ...(f?.editSession ? ["*edit session*"] : []),
  ];

  const problems: string[] = [];
  const out: string[] = [
    "# Component catalogue",
    "",
    "<!-- Generated by scripts/docs/api-reference.ts from the TypeScript source. Do not edit: run `bun run docs:api`. -->",
    "",
    "Every React component exported by `@heswell/trading-ui`, with facts read from the source. Hand-written guides: [components/README.md](../components/README.md).",
    "",
    "- **Tables**: Vuu tables the component subscribes to itself (`useTradingDataSource` / `useTradingRows`, following imports within its folder and the shared hooks in `src/hooks`).",
    "- **RPCs**: RPCs it sends with `sendTradingRpc`; *edit session* means it amends through a `parentOrders` edit session.",
    "- **Composes**: other component folders it renders or uses; their tables and RPCs are on their own rows.",
    "- **Showcase**: example ids, opened at `http://localhost:5001/#<id>` (`bun run dev:showcase`, local data). *host* means the showcase host mounts it around every example.",
    "",
    "Roles are enforced by the OMS on every viewport and RPC; components only shape the UI (see [permissions](../components/README.md#permissions)).",
    "",
    "| Component | Folder | Tables | RPCs | Composes | Showcase | Guide |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of components) {
    const unit = unitOfFile(item.file) ?? "";
    const f = componentFacts.get(item.name);
    const ids = coverage.get(item.name);
    const showcase = ids?.size
      ? list(ids)
      : host.has(item.name)
        ? "*host*"
        : "";
    if (!showcase) problems.push(`${item.name}: no showcase example`);
    const guide = COMPONENT_GUIDES[item.name];
    if (!guide)
      problems.push(
        `${item.name}: no entry in COMPONENT_GUIDES (apps/showcase/src/examples/docs.ts)`,
      );
    out.push(
      `| [${item.name}](trading-ui.md#${anchor(item.name)}) | \`${unit}\` | ${list(f?.tables ?? [])} | ${list(rpcsOf(f))} | ${[...(f?.composes ?? [])].sort().join(", ")} | ${showcase} | ${guideLink(guide)} |`,
    );
  }

  out.push(
    "",
    "## CSS hooks",
    "",
    "Class bases (elements are `<base>-<element>`), the CSS custom properties each folder's stylesheets declare or read (`--trading-*` are the shared tokens, see [ui-guide §2–3](../ui-guide.md#2-styling-css-injection-and-salt--vuu-theming)), and the `data-*` attributes to select on.",
    "",
    "| Folder | Class base | Custom properties | `data-*` |",
    "| --- | --- | --- | --- |",
  );
  for (const unit of [...facts.keys()].sort()) {
    const f = facts.get(unit) as UnitFacts;
    if (!f.classBases.size && !f.cssVars.size && !f.dataAttrs.size) continue;
    out.push(
      `| \`${unit}\` | ${list(f.classBases)} | ${list(f.cssVars)} | ${list(f.dataAttrs)} |`,
    );
  }

  out.push(
    "",
    "## Providers and data folders",
    "",
    "| Folder | Tables | RPCs |",
    "| --- | --- | --- |",
  );
  for (const unit of [...facts.keys()].sort()) {
    if (unit.startsWith("components/")) continue;
    const f = facts.get(unit) as UnitFacts;
    if (!f.tables.size && !rpcsOf(f).length) continue;
    out.push(`| \`${unit}\` | ${list(f.tables)} | ${list(rpcsOf(f))} |`);
  }

  out.push(
    "",
    "## Showcase groups",
    "",
    "| Group | Examples | Guide |",
    "| --- | --- | --- |",
  );
  const byGroup = new Map<string, string[]>();
  for (const [id, group] of groups)
    byGroup.set(group, [...(byGroup.get(group) ?? []), id]);
  for (const [group, ids] of [...byGroup].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const guide = COMPONENT_GUIDES[group];
    if (!guide)
      problems.push(`showcase group ${group}: no entry in COMPONENT_GUIDES`);
    out.push(`| ${group} | ${list(ids)} | ${guideLink(guide)} |`);
  }
  for (const [key, guide] of Object.entries(COMPONENT_GUIDES))
    if (!existsSync(join(ROOT, guide.split("#")[0])))
      problems.push(`COMPONENT_GUIDES.${key}: ${guide} does not exist`);
  return { text: `${out.join("\n")}\n`, problems };
};

// ------------------------------------------------------------------ main

const outputs = new Map<string, string>();
const problems: string[] = [];
let uiItems: ApiItem[] = [];
for (const pkg of PACKAGES) {
  const items = pkg.entries.flatMap(collectItems);
  if (pkg.name === "@heswell/trading-ui") uiItems = items;
  outputs.set(pkg.out, renderPackage(pkg, items));
  for (const item of items)
    if (
      !item.external &&
      ["component", "hook", "function", "class"].includes(item.kind) &&
      !item.doc
    )
      problems.push(`${pkg.name} ${item.name} (${rel(item.file)}): no JSDoc`);
}
const catalogue = renderCatalogue(uiItems);
outputs.set("components.md", catalogue.text);
problems.push(...catalogue.problems);
outputs.set(
  "README.md",
  [
    "# API reference",
    "",
    "<!-- Generated by scripts/docs/api-reference.ts from the TypeScript source. Do not edit: run `bun run docs:api`. -->",
    "",
    "Generated from the exported TypeScript declarations and their JSDoc. `bun run docs:check` (CI) fails when these files are out of date, when a reusable component or hook has no JSDoc, no showcase example or no guide.",
    "",
    "| File | Contents |",
    "| --- | --- |",
    ...PACKAGES.map((p) => `| [${p.out}](${p.out}) | \`${p.name}\` |`),
    "| [components.md](components.md) | Catalogue of the `@heswell/trading-ui` components: tables, RPCs, CSS hooks, showcase examples and guides |",
    "",
    "Hand-written guides: [../components/](../components/README.md).",
    "",
  ].join("\n"),
);

// Headings that differ only in case (linkGroupDefinition / LinkGroupDefinition)
// share a slug; GitHub suffixes repeats with -1, -2... Resolve every link whose
// text names a heading to that heading's real anchor.
const headingSlugs = (text: string) => {
  const seen = new Map<string, number>();
  const slugs = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^#{1,6} (.+)$/.exec(line);
    if (!m) continue;
    const heading = m[1].trim();
    const base = anchor(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if (!slugs.has(heading)) slugs.set(heading, n ? `${base}-${n}` : base);
  }
  return slugs;
};
const slugsByFile = new Map(
  [...outputs].map(([file, text]) => [file, headingSlugs(text)]),
);
for (const [file, text] of outputs) {
  outputs.set(
    file,
    text.replace(
      /\[(`?)([^\]`]+)\1\]\(((?:[\w.-]+\.md)?)#([^)\s]+)\)/g,
      (link, tick: string, name: string, target: string) => {
        const slug = slugsByFile.get(target || file)?.get(name);
        return slug ? `[${tick}${name}${tick}](${target}#${slug})` : link;
      },
    ),
  );
}

if (check) {
  for (const [file, text] of outputs) {
    const path = join(OUT_DIR, file);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text)
      problems.push(`docs/api/${file} is out of date: run bun run docs:api`);
  }
  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(`docs/api is up to date (${outputs.size} files)`);
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [file, text] of outputs) writeFileSync(join(OUT_DIR, file), text);
  console.log(
    `wrote ${[...outputs.keys()].map((f) => `docs/api/${f}`).join(", ")}`,
  );
  if (problems.length) console.warn(problems.map((p) => `! ${p}`).join("\n"));
}
