import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import { FIX, libA, connected, catalogFor, zipDir } from "./helpers.js";
// Archive libraries extract into a shared cache that each scan prunes; parallel test processes must not share it.
process.env.SKILLS_CACHE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "skills-cache-"));
import { parseSteps, parseChainDefinitions, buildValueChains, renderValueChain, detectLayout } from "../../src/vault.js";

const vault = path.join(FIX, "vault");
const vault2 = path.join(FIX, "vault2");
const skillsOf = (v: string) => path.join(v, "00-CORE", "Agents", "skills");
const ARGS = ["--lib", `bob=${vault}`, "--lib", `me=${vault2}`, "--name", "v"];

const EX = new Set(["_archive", "_audit"]), IG = new Set(["node_modules", ".git"]);

test("detectLayout: never reads above the root; vault root, wrapped vault, markers, explicit, opt-out, none", async () => {
  assert.deepEqual(await detectLayout(skillsOf(vault), undefined, EX, IG), { skillsRoot: skillsOf(vault), vaultRoot: null, how: "none" }, "a skills folder inside a vault serves skills only");
  assert.deepEqual(await detectLayout(vault, undefined, EX, IG), { skillsRoot: skillsOf(vault), vaultRoot: vault, how: "vault-root" });
  const wrap = await fs.mkdtemp(path.join(os.tmpdir(), "skills-wrap-"));
  await fs.cp(vault, path.join(wrap, "release-1.0"), { recursive: true });
  assert.deepEqual(await detectLayout(wrap, undefined, EX, IG), { skillsRoot: path.join(wrap, "release-1.0", "00-CORE", "Agents", "skills"), vaultRoot: path.join(wrap, "release-1.0"), how: "wrapped-vault" });
  assert.deepEqual(await detectLayout(libA, undefined, EX, IG), { skillsRoot: libA, vaultRoot: null, how: "none" });
  assert.deepEqual(await detectLayout(libA, "/my/vault", EX, IG), { skillsRoot: libA, vaultRoot: path.resolve("/my/vault"), how: "explicit" });
  assert.deepEqual(await detectLayout(vault, false, EX, IG), { skillsRoot: vault, vaultRoot: null, how: "none" });
  // markers: skills at the top, a Playbooks folder and a chain file somewhere below, no 00-CORE layout at all
  const flat = await fs.mkdtemp(path.join(os.tmpdir(), "skills-flat-"));
  await fs.cp(libA, flat, { recursive: true });
  await fs.mkdir(path.join(flat, "00-CORE", "Playbooks"), { recursive: true });
  assert.equal((await detectLayout(flat, undefined, EX, IG)).how, "markers");
  const flat2 = await fs.mkdtemp(path.join(os.tmpdir(), "skills-flat-"));
  await fs.cp(libA, flat2, { recursive: true });
  await fs.mkdir(path.join(flat2, "ops", "Playbooks"), { recursive: true });
  assert.equal((await detectLayout(flat2, undefined, EX, IG)).how, "none", "a stray Playbooks folder is not a vault marker");
});

test("parseSteps: numbered steps with skill arrow and actor; bare numbering; non-step lines ignored", () => {
  const body = `## Required Context\n- 1. not a step section\n\n## Steps\n\n1 (3). cro → audit page (AGENT)\n2 (2). Prioritise issues (HUMAN)\n3 (1). \`meeting-intelligence\` → document decisions (HUMAN + AGENT)\n\n## Quality gate\n1. this is not a step\n`;
  const steps = parseSteps(body);
  assert.deepEqual(steps, [
    { n: 1, skill: "cro", action: "audit page", actor: "AGENT" },
    { n: 2, action: "Prioritise issues", actor: "HUMAN" },
    { n: 3, skill: "meeting-intelligence", action: "document decisions", actor: "HUMAN + AGENT" },
  ]);
  assert.deepEqual(parseSteps("1. Do it\n2) Then this (AGENT)\n"), [{ n: 1, action: "Do it" }, { n: 2, action: "Then this", actor: "AGENT" }]);
  assert.deepEqual(parseSteps("1. Hand off to [[Other]] → nothing (HUMAN)"), [{ n: 1, action: "Hand off to [[Other]] → nothing", actor: "HUMAN" }]);
});

test("parseSteps: wikilinked skills, continuation lines, actor notes, heads per the playbook-runner grammar", () => {
  const served = new Set(["win-loss-analysis", "research-company", "cro", "business-baseline", "pdf-report", "social-notes", "playbook-runner"]);
  const isSkill = (n: string) => served.has(n);
  const body = [
    "## Steps", "",
    "1 (6). **Scope.** Name the competitor and the intended",
    "   output. One paragraph (HUMAN)", "",
    "2 (5). **Mine our own losses first.** [[win-loss-analysis]] over deals where they appeared. Extract",
    "   what buyers said, then [[research-company]] and [[Lead-to-Cash E2E]]; ![[cro]] is an embed",
    "   (AGENT)", "",
    "3 (4). **Set the bar.** A public page ([[cro/SKILL.md|CRO audit]]) carries only sourced claims (HUMAN decides, AGENT drafts)",
    "4 (3). [[Client onboarding]] + [[business-baseline]] → draft the profile (AGENT + HUMAN)",
    "5 (2). **`playbook-runner`** (run) → run the bundle (AGENT — run weekly)",
    "6 (1). **Verify the package** (AGENT):",
    "   - count skill directories",
    "   - run `uv run {skills.root}/social-notes/scripts/x.py`",
    "   ```",
    "   7. not a step inside a fence",
    "   ```",
    "   1. an indented sub-list is not a step",
    "### Stage 2",
    "7. script:render.sh → render (AGENT, 5 min)",
    "8. [[pdf-report]] → compile the report",
    "   and send it", "",
    "   Nobody reads it until the end (HUMAN)",
    "", "## Quality gate", "1. not a step",
  ].join("\n");
  assert.deepEqual(parseSteps(body, isSkill), [
    { n: 1, action: "**Scope.** Name the competitor and the intended output. One paragraph", actor: "HUMAN" },
    { n: 2, skill: "win-loss-analysis", mentions: ["research-company"], action: "**Mine our own losses first.** [[win-loss-analysis]] over deals where they appeared. Extract what buyers said, then [[research-company]] and [[Lead-to-Cash E2E]]; ![[cro]] is an embed", actor: "AGENT" },
    { n: 3, skill: "cro", action: "**Set the bar.** A public page ([[cro/SKILL.md|CRO audit]]) carries only sourced claims", actor: "HUMAN decides, AGENT drafts" },
    { n: 4, skill: "business-baseline", action: "[[Client onboarding]] + [[business-baseline]] → draft the profile", actor: "AGENT + HUMAN" },
    { n: 5, skill: "playbook-runner", route: "run", action: "run the bundle", actor: "AGENT — run weekly" },
    { n: 6, skill: "social-notes", action: "**Verify the package**", actor: "AGENT" },
    { n: 7, action: "script:render.sh → render", actor: "AGENT, 5 min" },
    { n: 8, skill: "pdf-report", action: "compile the report and send it", actor: "HUMAN" },
  ]);
  // Without a served-skill set, links name no skills; the arrow head still does.
  assert.deepEqual(parseSteps("1. [[cro]] → audit (AGENT)\n2. cro → audit (AGENT)").map((s) => s.skill), [undefined, "cro"]);
});

test("parseSteps: without a Steps section, Phase headings are the steps", () => {
  const body = "# Pipeline\n\n## Route\n\n1. Create the note\n2. Schedule it\n\n### Pre-flight\n1. Check the API\n\n### Phase 1 — Read Queue\n\nRead it.\n\n### Phase 2: Fetch\n\n```bash\nuv run {skills.root}/social-notes/scripts/t.py\n```\n\n### Phase 3\n\nDone (HUMAN)\n";
  assert.deepEqual(parseSteps(body, (n) => n === "social-notes"), [
    { n: 1, action: "Read Queue" },
    { n: 2, skill: "social-notes", action: "Fetch" },
    { n: 3, action: "Phase 3", actor: "HUMAN" },
  ]);
});

test("parseChainDefinitions: canonical ### blocks and generated ## index", () => {
  const canonical = `# Value chains\n\n## Chains\n\n### lead-to-cash\n**SME Label:** Win and get paid\n**Description:** Revenue journey.\n**Stages:** prospect → qualify, propose\n\n### empty-chain\n\n## Notes\nNot a chain.\n`;
  assert.deepEqual(parseChainDefinitions(canonical), [{ id: "lead-to-cash", label: "Win and get paid", description: "Revenue journey.", stages: ["prospect", "qualify", "propose"], kind: "chain" }]);
  const index = `# Value Chains — Coverage Index\n\nCanonical chain definitions: x\n\n## procure-to-pay\n**Buy smart, pay right**\n\nThe purchasing lifecycle.\n\n**Stages:** need → pay\n\n| Stage | Skills |\n|---|---|\n| \`need\` | — |\n\n**All playbooks (1):** [[X]]\n\n_Counts: 1_\n\n## hire-to-productivity\n**Build the team**\n\nFrom need to milestone.\n\n**Stages:** need → recruit\n`;
  assert.deepEqual(parseChainDefinitions(index), [
    { id: "procure-to-pay", label: "Buy smart, pay right", description: "The purchasing lifecycle.", stages: ["need", "pay"], kind: "chain" },
    { id: "hire-to-productivity", label: "Build the team", description: "From need to milestone.", stages: ["need", "recruit"], kind: "chain" },
  ]);
});

test("parseChainDefinitions: bulleted fields; Cross-Chain / Meta-Chain sections and the valid-ID list become unstaged buckets", () => {
  const text = [
    "# Value Chains", "", "## Standard Chains (2)", "",
    "### lead-to-cash",
    "- **SME Label:** Win and get paid",
    "- **Description:** Revenue journey.",
    "- **Stages:** prospect → qualify → close",
    "- **Key Playbooks:** [[Lead-to-Cash E2E]]",
    "- **Key Skills:** icp-discovery, lead-qualifier",
    "",
    "### record-to-insight",
    "* **SME Label:** Know your numbers",
    "* **Stages:** capture → report",
    "",
    "## Cross-Chain: Operating Controls", "",
    "Skills tagged `operating-controls` serve multiple chains.", "",
    "| Control Area | Description |", "|---|---|", "| `strategy` | Where to play |", "",
    "See [[operating-controls]].", "",
    "## Meta-Chain: Infrastructure", "",
    "Skills tagged `infrastructure` are vault machinery.", "",
    "- **Stages:** ignored → for → buckets", "",
    "## Metadata Spec", "", "```yaml", "### not-a-heading", "value-chains: [lead-to-cash]", "```", "",
    "### Valid chain IDs",
    "`lead-to-cash`, `record-to-insight`, `operating-controls`, `infrastructure`, `people-ops`", "",
    "## Adding New Chains", "", "1. Define it here",
  ].join("\n");
  assert.deepEqual(parseChainDefinitions(text), [
    { id: "lead-to-cash", label: "Win and get paid", description: "Revenue journey.", stages: ["prospect", "qualify", "close"], kind: "chain" },
    { id: "record-to-insight", label: "Know your numbers", description: "", stages: ["capture", "report"], kind: "chain" },
    { id: "operating-controls", label: "Operating Controls", description: "Skills tagged `operating-controls` serve multiple chains.", stages: [], kind: "bucket" },
    { id: "infrastructure", label: "Infrastructure", description: "Skills tagged `infrastructure` are vault machinery.", stages: [], kind: "bucket" },
    { id: "people-ops", label: "", description: "", stages: [], kind: "bucket" },
  ]);
});

test("buildValueChains: a bucket keeps no stages; its members are listed without a stage and it has no gaps", () => {
  const defs = [{ id: "infrastructure", label: "Infrastructure", description: "", stages: [], kind: "bucket" as const }];
  const [c] = buildValueChains("bob", defs, "definition", [{ name: "playbook-runner", valueChains: ["infrastructure"], stage: "run" }], [{ name: "P", valueChain: "infrastructure", chainCoverage: ["build"] } as any]);
  assert.equal(c.kind, "bucket"); assert.equal(c.source, "definition");
  assert.deepEqual(c.stages, []);
  assert.deepEqual(c.skillsByStage, { "": ["playbook-runner"] });
  assert.deepEqual(c.playbooksByStage, { "": ["P"] });
  const md = renderValueChain(c);
  assert.match(md, /^# Value-chain bucket: infrastructure — Infrastructure/);
  assert.match(md, /Members: skills playbook-runner; playbooks P/);
  assert.doesNotMatch(md, /Coverage gaps/);
});

test("buildValueChains: joins definitions with skills/playbooks; derives undefined chains; stage inference only for derived", () => {
  const defs = [{ id: "lead-to-cash", label: "L2C", description: "", stages: ["prospect", "propose"], kind: "chain" as const }];
  const skills = [
    { name: "cro", valueChains: ["lead-to-cash"], stage: "propose" },
    { name: "odd", valueChains: ["lead-to-cash"], stage: "nowhere" },
    { name: "solo", valueChains: ["ghost"], stage: "pay" },
  ];
  const pb = (name: string, valueChain: string, chainCoverage: string[]) => ({ name, valueChain, chainCoverage } as any);
  const chains = buildValueChains("bob", defs, "definition", skills, [pb("A", "lead-to-cash", ["propose", "close"]), pb("B", "ghost", ["order"]), pb("C", "lead-to-cash", [])]);
  assert.deepEqual(chains.map((c) => [c.id, c.source, c.kind, c.stages]), [["lead-to-cash", "definition", "chain", ["prospect", "propose"]], ["ghost", "derived", "chain", ["pay", "order"]]]);
  const l2c = chains[0];
  assert.deepEqual(l2c.skillsByStage, { propose: ["cro"], "": ["odd"] });
  assert.deepEqual(l2c.playbooksByStage, { propose: ["A"], "": ["C"] });
  assert.equal(l2c.skillCount, 2); assert.equal(l2c.playbookCount, 2);
  assert.equal(l2c.uri, "value-chain://bob/lead-to-cash");
  assert.deepEqual(chains[1].skillsByStage, { pay: ["solo"] });
  assert.deepEqual(chains[1].playbooksByStage, { order: ["B"] });
});

test("catalog: playbooks served only with playbook-runner; status/archive/manifest filtering; chain sources; stats", async () => {
  const { cat } = await catalogFor(ARGS);
  const st = cat.getStats();
  const bob = st.libraries.find((l) => l.namespace === "bob")!;
  const me = st.libraries.find((l) => l.namespace === "me")!;
  assert.equal(bob.vault, true);
  assert.equal(bob.playbooks, 3, "CRO loop, Monthly Close, Misplaced");
  assert.equal(bob.playbooksHidden, 1, "Draft idea");
  assert.equal(bob.playbookRunner, "bob/playbook-runner");
  assert.equal(bob.valueChains, 5, "lead-to-cash, record-to-insight, buckets infrastructure and operating-controls, derived ghost-chain");
  assert.equal(bob.valueChainBuckets, 2);
  assert.equal(bob.valueChainSource, "definition");
  assert.deepEqual(cat.allPlaybooks("bob").map((p) => p.name), ["CRO improvement loop", "Misplaced", "Monthly Close"]);
  // vault2 has playbooks but no runner in any library except bob's: the bob runner is reused.
  assert.equal(me.vault, true);
  assert.equal(me.playbooks, 1);
  assert.equal(me.playbookRunner, "bob/playbook-runner");
  assert.equal(me.valueChainSource, "index");
  assert.equal(me.valueChains, 1);
  assert.equal(st.playbooks, 4); assert.equal(st.valueChains, 6);
  const w = st.warnings.join("\n");
  assert.match(w, /playbook step names skill 'copywriting' which is not served/);
  assert.match(w, /drafts\/Misplaced\.md: filed in a subdirectory/);
  assert.match(w, /library 'bob': 1 note\(s\) under 20-COMPANY\/03-PROCESSES\/Playbooks, 10-ME\/Playbooks are private playbooks and are not served/);
  assert.equal(cat.getPlaybook("Private process"), undefined, "company playbooks are private");
  assert.equal(cat.getPlaybook("My routine"), undefined, "personal playbooks are private");
  assert.match(w, /value chain\(s\) referenced by frontmatter but not defined: ghost-chain$/m);
  assert.doesNotMatch(w, /no recognisable chain definitions/);
  assert.doesNotMatch(w, /Old loop|AGENTS\.md|Notes\.md/);

  const pb = cat.getPlaybook("cro improvement loop")!;
  assert.equal(pb.playbookPath, "bob/CRO improvement loop");
  assert.equal(pb.uri, "playbook://bob/CRO%20improvement%20loop");
  assert.equal(pb.vaultRel, "00-CORE/Playbooks/CRO improvement loop.md");
  assert.deepEqual(pb.skills, ["cro", "copywriting", "ab-test-setup"]);
  assert.equal(pb.steps.length, 5); assert.equal(pb.totalSteps, 5);
  assert.deepEqual(pb.attachments.map((a) => a.rel), ["cro-loop-sequence.png"]);
  const mc = cat.getPlaybook("bob/Monthly Close")!;
  assert.equal(mc.name, "Monthly Close");
  assert.deepEqual(mc.skills, ["financial-reporting", "cro"], "[[cro/SKILL.md|…]] names a served skill; [[CRO improvement loop]] is a playbook");
  assert.deepEqual(mc.steps.map((s) => [s.n, s.skill, s.actor]), [[1, "financial-reporting", "AGENT"], [2, undefined, "HUMAN"], [3, "cro", "AGENT"]]);
  assert.equal(mc.totalSteps, 3);
  const infra = cat.getValueChain("bob/infrastructure")!;
  assert.equal(infra.kind, "bucket"); assert.deepEqual(infra.stages, []); assert.deepEqual(infra.skillsByStage, { "": ["playbook-runner"] });
  assert.equal(cat.getValueChain("bob/operating-controls")!.kind, "bucket");
  assert.equal(cat.getPlaybook("Draft idea"), undefined, "draft playbooks are not served");
  assert.equal(cat.getPlaybook("nope"), undefined);
  assert.equal(cat.resolvePlaybookUri("playbook://bob/CRO%20improvement%20loop/cro-loop-sequence.png")!.attachment!.rel, "cro-loop-sequence.png");
  assert.equal(cat.resolvePlaybookUri("playbook://bob/../x"), null);

  const l2c = cat.getValueChain("lead-to-cash")!;
  assert.equal(l2c.library, "bob");
  assert.deepEqual(l2c.stages, ["prospect", "qualify", "propose", "close", "deliver", "invoice", "collect"]);
  assert.deepEqual(l2c.skillsByStage, { propose: ["cro"], close: ["ab-test-setup"] });
  assert.deepEqual(l2c.playbooksByStage, { propose: ["CRO improvement loop"], close: ["CRO improvement loop"] });
  assert.equal(cat.getValueChain("procure-to-pay")!.label, "Buy smart, pay right");
  assert.equal(cat.getValueChain("procure-to-pay")!.playbookCount, 1);
  assert.equal(cat.resolveValueChainUri("value-chain://me/procure-to-pay")!.id, "procure-to-pay");
});

test("catalog: no runner anywhere withholds playbooks but keeps value chains; --show-disabled serves drafts; opt-outs", async () => {
  const solo = ["--lib", `me=${vault2}`, "--name", "v"];
  const { cat } = await catalogFor(solo);
  const me = cat.getStats().libraries[0];
  assert.equal(me.playbooks, 0); assert.equal(me.playbooksHidden, 1); assert.equal(me.playbookRunner, undefined);
  assert.equal(me.valueChains, 1);
  assert.match(cat.getStats().warnings.join("\n"), /1 playbook\(s\) found but no 'playbook-runner' skill is served; playbooks withheld/);

  const { cat: shown } = await catalogFor(["--lib", `bob=${vault}`, "--show-disabled"]);
  assert.equal(shown.getStats().libraries[0].playbooks, 4);
  assert.equal(shown.getPlaybook("Draft idea")!.status, "draft");

  const { cat: off } = await catalogFor(["--lib", `bob=${vault}`, "--no-playbooks", "--no-value-chains"]);
  assert.equal(off.getStats().playbooks, 0); assert.equal(off.getStats().valueChains, 0);
  assert.equal(off.getStats().libraries[0].vault, false);

  const { cat: skillsOnly } = await catalogFor(["--lib", `bob=${skillsOf(vault)}`]);
  assert.equal(skillsOnly.getStats().libraries[0].vault, false, "root is the skills folder: nothing above it is read");
  assert.equal(skillsOnly.getStats().playbooks, 0); assert.equal(skillsOnly.getStats().valueChains, 0);
  assert.equal(skillsOnly.all().length, 3);

  const { cat: plain } = await catalogFor(["--lib", `a=${libA}`]);
  assert.equal(plain.getStats().libraries[0].vault, false);
  assert.equal(plain.getStats().playbooks, 0);

  const { cat: explicit } = await catalogFor(["--lib", `a=${libA}`, "--vault", `a=${vault}`]);
  assert.equal(explicit.getStats().libraries[0].vault, true);
  assert.equal(explicit.getStats().libraries[0].playbooksHidden, 4, "libA has no runner: all four playbooks withheld");
  assert.equal(explicit.getStats().libraries[0].valueChains, 4, "defined chains and buckets, no skills reference them");
});

test("server: tools appear only when served; list/get playbooks; value chains; resources; prompt", async () => {
  const { client, close } = await connected(ARGS);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["v_list_playbooks", "v_get_playbook", "v_list_value_chains", "v_get_value_chain"]) assert.ok(tools.includes(t), t);
    assert.match(client.getInstructions()!, /4 playbooks .*v_list_playbooks/);
    assert.match(client.getInstructions()!, /6 value chains/);
    assert.match(client.getInstructions()!, /requires the 'playbook-runner' skill/);

    const ls = await client.callTool({ name: "v_list_playbooks", arguments: { query: "converting page" } });
    const lsc = ls.structuredContent as any;
    assert.equal(lsc.playbooks[0].path, "bob/CRO improvement loop");
    assert.equal(lsc.playbooks[0].runner, "bob/playbook-runner");
    assert.match((ls.content as any)[0].text, /Trigger: This page isn't converting/);
    const byStage = await client.callTool({ name: "v_list_playbooks", arguments: { value_chain: "record-to-insight", stage: "report" } });
    assert.deepEqual((byStage.structuredContent as any).playbooks.map((p: any) => p.name), ["Misplaced", "Monthly Close"]);
    const bySkill = await client.callTool({ name: "v_list_playbooks", arguments: { skill: "solo" } });
    assert.deepEqual((bySkill.structuredContent as any).playbooks.map((p: any) => p.path), ["me/Pay bills"]);
    const none = await client.callTool({ name: "v_list_playbooks", arguments: { query: "zzzz" } });
    assert.equal((none.structuredContent as any).total, 0); assert.ok((none.structuredContent as any).hint);
    const badLib = await client.callTool({ name: "v_list_playbooks", arguments: { library: "nope" } });
    assert.equal(badLib.isError, true);

    const get = await client.callTool({ name: "v_get_playbook", arguments: { name: "CRO improvement loop", include_frontmatter: true } });
    const g = get.structuredContent as any;
    assert.equal(g.vaultPath, "00-CORE/Playbooks/CRO improvement loop.md");
    assert.deepEqual(g.missingSkills, ["copywriting"]);
    assert.deepEqual(g.stepDetails[0], { n: 1, skill: "cro", skillPath: "bob/cro", action: "audit page for conversion issues", actor: "AGENT" });
    assert.equal(g.stepDetails[2].skillPath, undefined);
    assert.equal(g.frontmatter.type, "playbook");
    assert.equal(g.attachments[0].uri, "playbook://bob/CRO%20improvement%20loop/cro-loop-sequence.png");
    assert.match(g.attachments[0].digest, /^sha256:[0-9a-f]{64}$/);
    assert.match((get.content as any)[0].text, /v_get_skill\("bob\/playbook-runner"\)/);
    assert.doesNotMatch(JSON.stringify(get), /fixtures/, "no absolute paths");
    const unknown = await client.callTool({ name: "v_get_playbook", arguments: { name: "nope" } });
    assert.equal(unknown.isError, true);

    const chains = await client.callTool({ name: "v_list_value_chains", arguments: { library: "bob" } });
    assert.deepEqual((chains.structuredContent as any).valueChains.map((c: any) => [c.id, c.source, c.kind]), [["lead-to-cash", "definition", "chain"], ["record-to-insight", "definition", "chain"], ["infrastructure", "definition", "bucket"], ["operating-controls", "definition", "bucket"], ["ghost-chain", "derived", "chain"]]);
    assert.match((chains.content as any)[0].text, /bob\/infrastructure — Infrastructure: \(bucket: unstaged group\)/);
    const bucket = await client.callTool({ name: "v_get_value_chain", arguments: { id: "bob/infrastructure" } });
    assert.deepEqual((bucket.structuredContent as any).gaps, []);
    assert.deepEqual((bucket.structuredContent as any).unstaged.skills, ["playbook-runner"]);
    const chain = await client.callTool({ name: "v_get_value_chain", arguments: { id: "record-to-insight" } });
    const c = chain.structuredContent as any;
    assert.deepEqual(c.gaps, ["capture", "close-period", "decide"]);
    assert.deepEqual(c.stageTable.find((r: any) => r.stage === "report").playbooks, ["Misplaced", "Monthly Close"]);
    assert.match((chain.content as any)[0].text, /Coverage gaps \(no skill or playbook\): capture, close-period, decide/);
    const viaLib = await client.callTool({ name: "v_get_value_chain", arguments: { id: "me/procure-to-pay" } });
    assert.equal((viaLib.structuredContent as any).label, "Buy smart, pay right");

    const res = await client.listResources();
    const uris = res.resources.map((r) => r.uri);
    assert.ok(uris.includes("playbook://bob/CRO%20improvement%20loop"));
    assert.ok(uris.includes("value-chain://bob/lead-to-cash"));
    const pbRes = res.resources.find((r) => r.uri === "playbook://bob/CRO%20improvement%20loop") as any;
    assert.equal(pbRes._meta["io.thirdbrain.vault/value-chain"], "lead-to-cash");
    assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 5);
    const md = await client.readResource({ uri: "playbook://bob/CRO%20improvement%20loop" });
    assert.match((md.contents[0] as any).text, /^---\ntype: playbook/);
    const png = await client.readResource({ uri: "playbook://bob/CRO%20improvement%20loop/cro-loop-sequence.png" });
    assert.equal(png.contents[0].mimeType, "image/png");
    const vc = await client.readResource({ uri: "value-chain://bob/lead-to-cash" });
    assert.match((vc.contents[0] as any).text, /\| `propose` \| cro \| CRO improvement loop \|/);
    await assert.rejects(client.readResource({ uri: "playbook://bob/CRO%20improvement%20loop/nope.png" }), { code: -32602 });

    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    assert.deepEqual(prompts, ["use-skill", "run-playbook"]);
    const pr = await client.getPrompt({ name: "run-playbook", arguments: { playbook: "Monthly Close", inputs: "September 2026" } });
    const text = (pr.messages[0].content as any).text;
    assert.match(text, /<skill name="playbook-runner"/);
    assert.match(text, /<playbook name="Monthly Close"/);
    assert.match(text, /Run inputs: September 2026/);
    assert.match(text, /\[financial-reporting \(not served\)\]/);

    const libs = await client.callTool({ name: "v_list_libraries", arguments: {} });
    const bob = (libs.structuredContent as any).libraries.find((l: any) => l.namespace === "bob");
    assert.equal(bob.playbooks, 3); assert.equal(bob.playbookRunner, "bob/playbook-runner"); assert.equal(bob.valueChainSource, "definition");
    assert.match((libs.content as any)[0].text, /bob: 3 skills \(0 hidden\), 3 playbooks, 5 value chains/);
    const status = await client.callTool({ name: "v_catalog_status", arguments: { include_warnings: true } });
    assert.equal((status.structuredContent as any).playbooks, 4);
    assert.doesNotMatch(JSON.stringify(status), /fixtures/);
    const direct = await client.request({ method: "skills/list", params: {} }, z.any());
    assert.ok(direct.skills.every((s: any) => s.uri.startsWith("skill://")), "skills/list is unaffected");
  } finally { await close(); }
});

test("server: tools, prompt and templates are listed whenever the feature is on; they answer empty for a skills-only library; --no-* removes them", async () => {
  const { client, close } = await connected(["--lib", `a=${libA}`, "--name", "plain"]);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["plain_list_playbooks", "plain_get_playbook", "plain_list_value_chains", "plain_get_value_chain"]) assert.ok(tools.includes(t), t);
    assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name), ["use-skill", "run-playbook"]);
    assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 5);
    assert.match(client.getInstructions()!, /Playbooks .* are served when a library ships them/);
    const ls = await client.callTool({ name: "plain_list_playbooks", arguments: {} });
    assert.equal((ls.structuredContent as any).total, 0);
    assert.match((ls.structuredContent as any).hint, /No playbooks are served/);
    const vc = await client.callTool({ name: "plain_list_value_chains", arguments: {} });
    assert.deepEqual((vc.structuredContent as any).valueChains, []);
    const g = await client.callTool({ name: "plain_get_playbook", arguments: { name: "x" } });
    assert.equal(g.isError, true); assert.match(JSON.stringify(g), /No playbooks are served/);
    const c = await client.callTool({ name: "plain_get_value_chain", arguments: { id: "x" } });
    assert.equal(c.isError, true);
    const pr = client.getPrompt({ name: "run-playbook", arguments: { playbook: "x" } });
    await assert.rejects(pr, /No playbooks are served/);
  } finally { await close(); }
  const off = await connected(["--lib", `a=${libA}`, "--name", "plain", "--no-playbooks", "--no-value-chains"]);
  try {
    const tools = (await off.client.listTools()).tools.map((t) => t.name);
    assert.ok(!tools.some((t) => /playbook|value_chain/.test(t)));
    assert.deepEqual((await off.client.listPrompts()).prompts.map((p) => p.name), ["use-skill"]);
    assert.equal((await off.client.listResourceTemplates()).resourceTemplates.length, 2);
    assert.doesNotMatch(off.client.getInstructions()!, /playbook/i);
    const r = await off.client.callTool({ name: "plain_list_playbooks", arguments: {} });
    assert.equal(r.isError, true);
  } finally { await off.close(); }
});

test("portability: a release zip with a wrapper folder serves skills, playbooks and chains; skill paths stay clean", async () => {
  const zip = await zipDir(vault, "thirdbrain-1.0/");
  const { client, cat, close } = await connected(["--lib", `bob=${zip}`, "--name", "z"]);
  try {
    const st = cat.getStats();
    assert.equal(st.libraries[0].kind, "archive");
    assert.deepEqual(cat.all().map((s) => s.skillPath), ["bob/ab-test-setup", "bob/cro", "bob/playbook-runner"]);
    assert.equal(st.libraries[0].playbooks, 3);
    assert.equal(st.libraries[0].valueChainSource, "definition");
    const g = await client.callTool({ name: "z_get_playbook", arguments: { name: "Monthly Close" } });
    assert.equal((g.structuredContent as any).vaultPath, "00-CORE/Playbooks/Monthly Close.md");
    assert.doesNotMatch(JSON.stringify(g), /skills-mcp|\.cache|tmp/, "no cache or temp paths leak");
    const vc = await client.callTool({ name: "z_get_value_chain", arguments: { id: "lead-to-cash" } });
    assert.deepEqual((vc.structuredContent as any).stageTable[2].skills, ["cro"]);
    const status = await client.callTool({ name: "z_catalog_status", arguments: { include_warnings: true } });
    assert.doesNotMatch(JSON.stringify(status), /skills-mcp\/[0-9a-f]{64}/, "no extraction path in warnings");
  } finally { await close(); }
});

test("portability: only 00-CORE/Playbooks is served; other Playbooks folders are private; the chain file may sit anywhere shallow", async () => {
  const flat = await fs.mkdtemp(path.join(os.tmpdir(), "skills-flat-"));
  await fs.cp(skillsOf(vault), path.join(flat, "skills"), { recursive: true });
  await fs.mkdir(path.join(flat, "00-CORE", "Playbooks"), { recursive: true });
  await fs.copyFile(path.join(vault, "00-CORE", "Playbooks", "Monthly Close.md"), path.join(flat, "00-CORE", "Playbooks", "Monthly Close.md"));
  await fs.mkdir(path.join(flat, "company", "ops", "Playbooks"), { recursive: true });
  await fs.copyFile(path.join(vault, "00-CORE", "Playbooks", "CRO improvement loop.md"), path.join(flat, "company", "ops", "Playbooks", "CRO improvement loop.md"));
  await fs.mkdir(path.join(flat, "docs"));
  await fs.copyFile(path.join(vault, "20-COMPANY", "03-PROCESSES", "value-chains.md"), path.join(flat, "docs", "Value-Chains.md"));
  const { cat } = await catalogFor(["--lib", `x=${flat}`]);
  const st = cat.getStats().libraries[0];
  assert.equal(st.vault, true);
  assert.deepEqual(cat.all().map((s) => s.name), ["ab-test-setup", "cro", "playbook-runner"]);
  assert.deepEqual(cat.allPlaybooks().map((p) => p.name), ["Monthly Close"]);
  assert.equal(cat.getPlaybook("Monthly Close")!.vaultRel, "00-CORE/Playbooks/Monthly Close.md");
  assert.equal(st.valueChainSource, "definition");
  assert.deepEqual(cat.getValueChain("record-to-insight")!.playbooksByStage, { reconcile: ["Monthly Close"], report: ["Monthly Close"] });
});
