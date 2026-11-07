export interface AdvisoryFields {
  readonly id: string;
  readonly source: number;
  readonly name: string;
  readonly severity: string;
  readonly title: string;
  readonly range: string;
}

export function advisory(fields: AdvisoryFields) {
  return {
    source: fields.source,
    name: fields.name,
    dependency: fields.name,
    title: fields.title,
    url: `https://github.com/advisories/${fields.id}`,
    severity: fields.severity,
    cwe: ["CWE-1321"],
    cvss: { score: 7.5, vectorString: null },
    range: fields.range,
  };
}

export function vulnerability(
  name: string,
  fields: {
    readonly severity: string;
    readonly via: readonly unknown[];
    readonly range: string;
    readonly isDirect?: boolean;
    readonly effects?: readonly string[];
    readonly fixAvailable?: unknown;
  },
) {
  return {
    name,
    severity: fields.severity,
    isDirect: fields.isDirect ?? false,
    via: fields.via,
    effects: fields.effects ?? [],
    range: fields.range,
    nodes: [`node_modules/${name}`],
    fixAvailable: fields.fixAvailable ?? true,
  };
}

export function auditReport(
  vulnerabilities: Readonly<Record<string, unknown>>,
) {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: {}, dependencies: {} },
  };
}

export const minimist = advisory({
  id: "GHSA-xvch-5gv4-984h",
  source: 1096465,
  name: "minimist",
  severity: "critical",
  title: "Prototype Pollution in minimist",
  range: "<0.2.4",
});

export const undici = advisory({
  id: "GHSA-xjj6-f33q-929c",
  source: 1243113,
  name: "undici",
  severity: "high",
  title: "undici vulnerable to Denial of Service via unhandled error",
  range: ">=7.18.0 <7.30.1",
});

export const minimatch = advisory({
  id: "GHSA-g3hv-75wg-m249",
  source: 1244623,
  name: "minimatch",
  severity: "moderate",
  title: "minimatch has potential denial of service",
  range: ">=7.0.0 <11.0.1",
});

export const threeSeverities = auditReport({
  minimatch: vulnerability("minimatch", {
    severity: "moderate",
    via: [minimatch],
    range: "7.0.0 - 11.0.0",
  }),
  minimist: vulnerability("minimist", {
    severity: "critical",
    via: [minimist],
    range: "<=0.2.3",
    effects: ["mkdirp"],
    fixAvailable: { name: "mkdirp", version: "0.5.6", isSemVerMajor: false },
  }),
  mkdirp: vulnerability("mkdirp", {
    severity: "critical",
    via: ["minimist"],
    range: "0.4.1 - 0.5.1",
    isDirect: true,
  }),
  undici: vulnerability("undici", {
    severity: "high",
    via: [undici],
    range: "7.18.0 - 7.30.0",
  }),
});

export const installTree = {
  name: "demo",
  version: "1.0.0",
  dependencies: {
    mkdirp: {
      version: "0.5.1",
      dependencies: { minimist: { version: "0.2.1" } },
    },
    workflow: {
      version: "1.2.0",
      dependencies: {
        "@workflow/core": {
          version: "5.0.2",
          dependencies: { undici: { version: "7.18.0" } },
        },
      },
    },
    minimist: { version: "1.2.8" },
    minimatch: { version: "10.0.0" },
    optional: { missing: true },
  },
};
