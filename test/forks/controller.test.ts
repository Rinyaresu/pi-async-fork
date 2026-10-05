import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent, AgentState } from "@elpapi42/pi-fleet-sdk";
import type { Configuration } from "../../src/configuration.js";
import { Controller } from "../../src/forks/controller.js";
import type { ActivityCollection, Candidate, ManagedAgents, ObserverCallbacks } from "../../src/forks/agent.js";
import { buildAssignedTask } from "../../src/forks/task-prompt.js";

const configuration: Configuration = {
  agentDir: "/profile",
  stateDir: "/fleet",
  profiles: {
    fast: { provider: "p", model: "fast", thinking: "low" },
    balanced: { provider: "p", model: "balanced", thinking: "high" },
    deep: { provider: "p", model: "deep", thinking: "high" },
  },
};

class FakeAgents implements ManagedAgents {
  readonly agent = { id: "agent-1", name: "research-0000001" } as Agent;
  callbacks?: ObserverCallbacks;
  state: AgentState = "working";
  statusCalls = 0;
  statusHook?: () => Promise<AgentState>;
  destroyed = 0;
  destroyHook?: () => Promise<void>;
  sent: string[] = [];
  observed = 0;
  created = 0;
  stopped = 0;
  createdEnvironment: Record<string, string> | undefined;
  createdArgs: string[] | undefined;
  collected: Array<{ limit: number | undefined; signal: AbortSignal | undefined }> = [];
  activityCollection: ActivityCollection = { entries: [], stopReason: "idle", outputTruncated: false, incomplete: false };
  collectError: unknown;
  collectHook?: () => Promise<ActivityCollection>;
  async start() {}
  async stop() { this.stopped += 1; }
  async create(name: string, _cwd?: string, _agentDir?: string, _piArgs?: string[], env?: Record<string, string>) {
    this.created += 1;
    this.createdEnvironment = env;
    this.createdArgs = _piArgs;
    return { ...this.agent, name } as Agent;
  }
  async restore() { return this.agent; }
  async status() { this.statusCalls += 1; return this.statusHook ? this.statusHook() : this.state; }
  async collectActivity(_agent: Agent, limit: number | undefined, signal?: AbortSignal) {
    this.collected.push({ limit, signal });
    if (this.collectError) throw this.collectError;
    return this.collectHook ? this.collectHook() : this.activityCollection;
  }
  async steer(_agent: Agent, message: string) { this.sent.push(message); }
  observe(_agent: Agent, _after: string | undefined, callbacks: ObserverCallbacks) { this.observed += 1; this.callbacks = callbacks; }
  stopObserving() { this.stopped += 1; }
  async destroy() { this.destroyed += 1; await this.destroyHook?.(); }
  candidate(candidate: Candidate) { this.callbacks?.onCandidate(candidate); }
  activity() { this.callbacks?.onActivity(); }
  statusUpdate(state: AgentState) { this.callbacks?.onStatus(state); }
}

function waitForLifecycle() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("requires explicit valid role and effort and valid context before creation side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-options-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents);
  try {
    for (const options of [undefined, {}, { role: "execute" }, { effort: "fast" }, { role: "invalid", effort: "fast" }, { role: "execute", effort: "invalid" }, { role: "verify", effort: "fast", context: "invalid" }]) {
      await assert.rejects(() => (controller.create as any)(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", options), /Fork (role|effort|context)/);
    }
    assert.equal(agents.created, 0);
    assert.equal(branch.some((entry) => entry?.data?.type === "fork.created"), false);
    await assert.rejects(() => readdir(join(root, "async-forks")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all role/effort combinations resolve context, persist contracts and select profiles solely by effort", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-matrix-"));
  try {
    for (const role of ["investigate", "execute", "verify"] as const) {
      for (const effort of ["fast", "balanced", "deep"] as const) {
        for (const context of [undefined, "inherit", "isolated"] as const) {
          const branch = invokingBranch();
          const { pi, ctx } = harness(root, branch);
          const agents = new FakeAgents();
          const controller = new Controller(pi, configuration, agents);
          await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role, effort, context });
          const created = branch.find((entry: any) => entry?.data?.type === "fork.created") as any;
          const effective = context ?? (role === "verify" ? "isolated" : "inherit");
          assert.equal(created.data.role, role);
          assert.equal(created.data.tier, effort);
          assert.equal(created.data.context, effective);
          assert.equal(Object.hasOwn(created.data, "effort"), false);
          assert.deepEqual(agents.createdArgs?.slice(2), ["--provider", "p", "--model", effort, "--thinking", configuration.profiles[effort].thinking]);
          const records = (await readFile(created.data.sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
          const boundary = records.at(-1);
          assert.equal(boundary.type, effective === "isolated" ? "custom_message" : "message");
          assert.match(effective === "isolated" ? boundary.content : boundary.message.content[0].text, new RegExp(`Role: ${role}\\.`));
          await controller.stop();
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registers only after task acceptance and finalizes a settled candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const parent = join(root, "parent.jsonl");
  const branch: any[] = [{ type: "message", id: "assistant", parentId: "user", message: {
    role: "assistant", stopReason: "toolUse", content: [
      { type: "text", text: "I will delegate research." },
      { type: "toolCall", id: "call-1", name: "create_fork", arguments: {} },
    ],
  } }];
  const sent: any[] = [];
  const pi = {
    appendEntry(_type: string, data: unknown) { branch.push({ type: "custom", customType: "pi-async-fork", data }); },
    sendMessage(message: unknown) { sent.push(message); },
  };
  const ctx = { cwd: root, sessionManager: {
    getBranch: () => branch,
    getSessionFile: () => parent,
    getHeader: () => ({ type: "session", version: 3, id: "parent", cwd: root }),
  } };
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    assert.match(forkId, /^research-\d{7}$/);
    const created = branch.find((entry) => entry?.data?.type === "fork.created");
    assert.equal(Object.hasOwn(created.data, "triggerTurn"), false);
    assert.equal(created.data.description, "Find the requested answer");
    assert.equal(branch.filter((entry) => entry?.data?.type === "fork.created").length, 1);
    assert.equal(agents.sent[0], buildAssignedTask("Find the answer."));

    agents.candidate({ text: "Answer", cursor: "cursor-1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);

    now += 10_000;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 1);
    const destroyed = branch.find((entry) => entry?.data?.type === "fork.destroyed");
    assert.equal(destroyed.data.kind, "response");
    assert.equal(destroyed.data.output, "Answer");
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, new RegExp(`^${forkId}:\\n\\nThis is the final report`));
    assert.equal(sent[0].details.kind, "response");
    assert.equal(sent[0].details.description, "Find the requested answer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an invalid description before creating a child session or fleet agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents);
  try {
    await assert.rejects(
      () => controller.create(ctx, "call-1", "research", "Find the answer.", "Only two", { role: "investigate", effort: "balanced" }),
      /Fork description must contain 3 to 6 words/,
    );
    assert.equal(agents.created, 0);
    assert.equal(branch.some((entry) => entry?.data?.type === "fork.created"), false);
    await assert.rejects(() => readdir(join(root, "async-forks")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("omits terminal wake choice from new records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const controller = new Controller(pi, configuration, new FakeAgents());
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    assert.equal(Object.hasOwn(branch.find((entry) => entry?.data?.type === "fork.created")?.data, "triggerTurn"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("passes configured child-Pi environment to agent creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  const env = Object.assign(Object.create(null), { PI_OBSERVATIONAL_MEMORY_PASSIVE: "1" });
  const controller = new Controller(pi, { ...configuration, env }, agents);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    assert.deepEqual(agents.createdEnvironment, env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("omits the state directory from a default-state fork record", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, { ...configuration, stateDir: undefined }, agents);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    const created = branch.find((item) => item?.data?.type === "fork.created");
    assert.equal(Object.hasOwn(created.data, "stateDir"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores historical and V2 forks without selecting new profiles or retrofitting contracts", async () => {
  for (const metadata of [{}, { role: "verify", context: "isolated" }]) {
    const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", stateDir: "/fleet", sessionPath: "/child", tier: "deep", ...metadata };
    const branch = [{ type: "custom", customType: "pi-async-fork", data: created }];
    const before = JSON.stringify(branch);
    const { pi, ctx } = harness("/work", branch);
    const agents = new FakeAgents();
    const controller = new Controller(pi, configuration, agents);
    await controller.start(ctx);
    assert.equal(agents.observed, 1);
    assert.equal(agents.created, 0);
    assert.equal(agents.createdArgs, undefined);
    assert.deepEqual(agents.sent, []);
    assert.equal(JSON.stringify(branch), before);
    await controller.stop();
  }
});

test("restores a default-state record only with the default current state", async () => {
  const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", sessionPath: "/child", tier: "balanced" };
  const branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: created }];
  const { pi, ctx } = harness("/work", branch);
  const defaultAgents = new FakeAgents();
  const defaultController = new Controller(pi, { ...configuration, stateDir: undefined }, defaultAgents);
  await defaultController.start(ctx);
  assert.equal(defaultAgents.observed, 1);

  const customAgents = new FakeAgents();
  const customController = new Controller(pi, configuration, customAgents);
  await customController.start(ctx);
  await assert.rejects(() => customController.status(ctx, created.forkId), /different pi-fleet state directory/);
});

test("drains active finalization before a session tree transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = [{ type: "message", id: "assistant", parentId: "user", message: {
    role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "create_fork", arguments: {} }],
  } }];
  const pi = { appendEntry(_type: string, data: unknown) { branch.push({ type: "custom", customType: "pi-async-fork", data }); }, sendMessage() {} };
  const ctx = { cwd: root, sessionManager: {
    getBranch: () => branch,
    getSessionFile: () => join(root, "parent.jsonl"),
    getHeader: () => ({ type: "session", version: 3, id: "parent", cwd: root }),
  } };
  const agents = new FakeAgents();
  let now = 0;
  let destroyStarted!: () => void;
  const started = new Promise<void>((resolve) => { destroyStarted = resolve; });
  let releaseDestroy!: () => void;
  const release = new Promise<void>((resolve) => { releaseDestroy = resolve; });
  agents.destroyHook = async () => { destroyStarted(); await release; };
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    agents.candidate({ text: "Answer", cursor: "cursor-1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    now += 10_000;
    agents.statusUpdate("idle");
    await started;
    let transitionFinished = false;
    const transition = controller.beforeTree().then(() => { transitionFinished = true; });
    await waitForLifecycle();
    assert.equal(transitionFinished, false);
    releaseDestroy();
    await transition;
    assert.equal(branch.some((entry) => entry?.data?.type === "fork.destroyed"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not register a fork when initial task acceptance fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = [{ type: "message", id: "assistant", parentId: "user", message: {
    role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "create_fork", arguments: {} }],
  } }];
  const pi = { appendEntry(_type: string, data: unknown) { branch.push({ type: "custom", customType: "pi-async-fork", data }); }, sendMessage() {} };
  const ctx = { cwd: root, sessionManager: {
    getBranch: () => branch,
    getSessionFile: () => join(root, "parent.jsonl"),
    getHeader: () => ({ type: "session", version: 3, id: "parent", cwd: root }),
  } };
  const agents = new FakeAgents();
  agents.steer = async () => { throw new Error("rejected"); };
  const controller = new Controller(pi, configuration, agents);
  try {
    await assert.rejects(() => controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" }), /rejected/);
    assert.equal(branch.some((entry) => entry?.data?.type === "fork.created"), false);
    assert.equal(agents.destroyed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function harness(root: string, branch: any[], sent: any[] = [], sendOptions: any[] = []) {
  const pi = {
    appendEntry(_type: string, data: unknown) { branch.push({ type: "custom", customType: "pi-async-fork", data }); },
    sendMessage(message: unknown, options: unknown) { sent.push(message); sendOptions.push(options); },
  };
  const ctx = { cwd: root, isIdle: () => true, signal: undefined as AbortSignal | undefined, sessionManager: {
    getBranch: () => branch,
    getSessionFile: () => join(root, "parent.jsonl"),
    getHeader: () => ({ type: "session", version: 3, id: "parent", cwd: root }),
  } };
  return { pi, ctx, sent, sendOptions };
}

function invokingBranch() {
  return [{ type: "message", id: "assistant", parentId: "user", message: {
    role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Delegating." }, { type: "toolCall", id: "call-1", name: "create_fork", arguments: {} }],
  } }];
}

test("buffers a fast candidate until task acceptance registers the fork", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  let release!: () => void;
  const accepted = new Promise<void>((resolve) => { release = resolve; });
  agents.steer = async (_agent, message) => {
    agents.sent.push(message);
    agents.candidate({ text: "Fast result", cursor: "c1" });
    agents.statusUpdate("idle");
    await accepted;
  };
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    await controller.beforeTree();
    const creating = controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    await waitForLifecycle();
    assert.equal(branch.some((item) => item?.data?.type === "fork.created"), false);
    assert.equal(agents.destroyed, 0);
    release();
    await creating;
    await waitForLifecycle();
    assert.equal(branch.filter((item) => item?.data?.type === "fork.created").length, 1);
    assert.equal(agents.destroyed, 0);
    now += 10_000;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(branch.filter((item) => item?.data?.type === "fork.destroyed").length, 1);
    assert.equal(agents.destroyed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starts the no-output grace period when idle is observed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    now = 50_000;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);
    now += 9_999;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);
    now += 1;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    const destroyed = branch.find((item) => item?.data?.type === "fork.destroyed");
    assert.equal(agents.destroyed, 1);
    assert.equal(destroyed?.data.kind, "notice");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defers inactive-branch completion until the owning branch is active again", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const owned: any[] = invokingBranch();
  let branch: any[] = owned;
  const { pi, ctx } = harness(root, branch);
  ctx.sessionManager.getBranch = () => branch;
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    branch = [];
    agents.candidate({ text: "Answer", cursor: "c1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);
    branch = owned;
    await controller.afterTree(ctx);
    agents.candidate({ text: "Answer", cursor: "c1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);
    now += 10_000;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 1);
    assert.equal(owned.some((item) => item?.data?.type === "fork.destroyed"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a valid active state when activity diagnostics fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents);
  try {
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    agents.collectError = new Error("diagnostic stream failed");
    const result = await controller.status(ctx, forkId);
    assert.equal(result.state, "working");
    assert.deepEqual(result.activity, { entries: [], stopReason: "error", outputTruncated: false, incomplete: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reprojects status after activity collection finishes during finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  let releaseActivity!: (value: ActivityCollection) => void;
  const activity = new Promise<ActivityCollection>((resolve) => { releaseActivity = resolve; });
  agents.collectHook = () => activity;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    const pendingStatus = controller.status(ctx, forkId);
    await Promise.resolve();
    agents.candidate({ text: "Answer", cursor: "c1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    now = 10_000;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 1);
    releaseActivity({ entries: [{ timestamp: 1, kind: "thinking" }], stopReason: "idle", outputTruncated: false, incomplete: true });
    assert.deepEqual(await pendingStatus, { state: "completed", description: "Find the requested answer" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns current raw status after activity collection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  let releaseActivity!: (value: ActivityCollection) => void;
  const activity = new Promise<ActivityCollection>((resolve) => { releaseActivity = resolve; });
  agents.collectHook = () => activity;
  const controller = new Controller(pi, configuration, agents);
  try {
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    const pendingStatus = controller.status(ctx, forkId);
    await Promise.resolve();
    agents.state = "idle";
    releaseActivity({ entries: [], stopReason: "idle", outputTruncated: false, incomplete: false });
    assert.equal((await pendingStatus).state, "idle");
    assert.equal(agents.statusCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns completed status when the post-collection status call loses a finalized agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  let rejectStatus!: (error: Error) => void;
  let secondStatusStarted!: () => void;
  const secondStatus = new Promise<void>((resolve) => { secondStatusStarted = resolve; });
  agents.statusHook = async () => {
    if (agents.statusCalls === 2) {
      secondStatusStarted();
      return new Promise<AgentState>((_resolve, reject) => { rejectStatus = reject; });
    }
    return agents.state;
  };
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    const pendingStatus = controller.status(ctx, forkId);
    await secondStatus;
    agents.candidate({ text: "Answer", cursor: "c1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    now = 10_000;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 1);
    rejectStatus(new Error("Agent is unavailable"));
    assert.deepEqual(await pendingStatus, { state: "completed", description: "Find the requested answer" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns completed status without activity collection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", stateDir: "/fleet", sessionPath: "/child", tier: "balanced", description: "Inspect completed fork history" };
  const destroyed = { type: "fork.destroyed", forkId: created.forkId, agentId: created.agentId, kind: "response", output: "Answer", cursor: "c1" };
  const branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: created }, { type: "custom", customType: "pi-async-fork", data: destroyed }];
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents);
  try {
    const result = await controller.status(ctx, created.forkId);
    assert.deepEqual(result, { state: "completed", description: "Inspect completed fork history" });
    assert.deepEqual(agents.collected, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replays completed output only when parent metadata has no match", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", stateDir: "/fleet", sessionPath: "/child", tier: "balanced" };
  const destroyed = { type: "fork.destroyed", forkId: created.forkId, agentId: created.agentId, kind: "response", output: "Answer", cursor: "c1" };
  const branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: created }, { type: "custom", customType: "pi-async-fork", data: destroyed }];
  const { pi, ctx, sent, sendOptions } = harness(root, branch);
  const controller = new Controller(pi, configuration, new FakeAgents());
  try {
    await controller.start(ctx);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.kind, "response");
    assert.deepEqual(sendOptions[0], { deliverAs: "steer", triggerTurn: true });
    branch.push({ type: "custom_message", customType: "pi-async-fork-result", details: { forkId: created.forkId, agentId: created.agentId, cursor: "c1" } });
    await controller.afterTree(ctx);
    assert.equal(sent.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replays completed output from legacy wake records with a turn trigger", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const destroyed = { type: "fork.destroyed", forkId: "research-0000001", agentId: "agent-1", kind: "response", output: "Answer", cursor: "c1" };
  try {
    for (const triggerTurn of [false, true]) {
      const created = { type: "fork.created", forkId: destroyed.forkId, agentId: destroyed.agentId, agentName: "research-0000001", stateDir: "/fleet", sessionPath: "/child", tier: "balanced", triggerTurn };
      const branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: created }, { type: "custom", customType: "pi-async-fork", data: destroyed }];
      const { pi, ctx, sendOptions } = harness(root, branch);
      await new Controller(pi, configuration, new FakeAgents()).start(ctx);
      assert.deepEqual(sendOptions, [{ deliverAs: "steer", triggerTurn: true }]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores active legacy forks with a turn trigger", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  try {
    for (const triggerTurn of [false, true]) {
      const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", stateDir: "/fleet", sessionPath: "/child", tier: "balanced", triggerTurn };
      const branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: created }];
      const { pi, ctx, sendOptions } = harness(root, branch);
      const agents = new FakeAgents();
      let now = 0;
      const controller = new Controller(pi, configuration, agents, () => now);
      await controller.start(ctx);
      agents.candidate({ text: "Answer", cursor: "c1" });
      agents.statusUpdate("idle");
      await waitForLifecycle();
      now += 10_000;
      agents.statusUpdate("idle");
      await waitForLifecycle();
      assert.deepEqual(sendOptions, [{ deliverAs: "steer", triggerTurn: true }]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not retain stale reconciliation after delayed restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", stateDir: "/fleet", sessionPath: "/child", tier: "balanced" };
  let branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: created }];
  const { pi, ctx } = harness(root, branch);
  ctx.sessionManager.getBranch = () => branch;
  const agents = new FakeAgents();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  agents.restore = async () => { await delayed; return agents.agent; };
  const controller = new Controller(pi, configuration, agents);
  try {
    const stale = controller.reconcile(ctx);
    await waitForLifecycle();
    branch = [];
    await controller.reconcile(ctx);
    release();
    await stale;
    assert.equal(agents.observed, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains the child session when failed creation cleanup leaves an agent alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  agents.steer = async () => { throw new Error("send failed"); };
  agents.destroyHook = async () => { throw new Error("destroy failed"); };
  const controller = new Controller(pi, configuration, agents);
  try {
    await assert.rejects(
      () => controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" }),
      /Agent cleanup failed: destroy failed.*Child session retained/,
    );
    assert.equal(branch.some((item) => item?.data?.type === "fork.created"), false);
    assert.equal(agents.stopped > 0, true);
    assert.equal((await readdir(join(root, "async-forks"))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes accepted steering before automatic destruction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => { sendStarted = resolve; });
    let releaseSend!: () => void;
    const release = new Promise<void>((resolve) => { releaseSend = resolve; });
    agents.steer = async (_agent, message) => {
      agents.sent.push(message);
      sendStarted();
      await release;
    };
    const steering = controller.steer(ctx, forkId, "Continue.");
    await started;
    agents.candidate({ text: "Updated answer", cursor: "c2" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);
    releaseSend();
    await steering;
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);
    now += 10_000;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects direct creation from a marked child session", async () => {
  const agents = new FakeAgents();
  const controller = new Controller({ appendEntry() {}, sendMessage() {} }, configuration, agents);
  const ctx = {
    cwd: "/work",
    sessionManager: {
      getHeader: () => ({ id: "child-session" }),
      getEntries: () => [{
        type: "custom",
        customType: "pi-async-fork-child",
        data: { version: 1, sessionId: "child-session", forkId: "parent-1234567" },
      }],
      getBranch: () => [],
    },
  };
  await assert.rejects(
    () => controller.create(ctx, "call", "research", "Do the task.", "Complete the assigned task", { role: "investigate", effort: "balanced" }),
    /This session is an async fork\. Async fork tools are unavailable here\./,
  );
  assert.equal(agents.observed, 0);
});

test("closes managed agents when startup reconciliation fails", async () => {
  const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", stateDir: "/fleet", sessionPath: "/child", tier: "balanced" };
  const destroyed = { type: "fork.destroyed", forkId: created.forkId, agentId: created.agentId, kind: "response", output: "Answer", cursor: "c1" };
  const branch: any[] = [
    { type: "custom", customType: "pi-async-fork", data: created },
    { type: "custom", customType: "pi-async-fork", data: destroyed },
  ];
  const ctx = { cwd: "/work", sessionManager: { getBranch: () => branch } };
  const pi = { appendEntry() {}, sendMessage() { throw new Error("delivery failed"); } };
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents);
  await assert.rejects(() => controller.start(ctx), /delivery failed/);
  assert.equal(agents.stopped, 1);
});

test("reports state-directory mismatch and ignores abort after accepted steering", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const mismatch = { type: "fork.created", forkId: "other-0000001", agentId: "other", agentName: "other-0000001", stateDir: "/other", sessionPath: "/child", tier: "balanced" };
  const branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: mismatch }];
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents);
  try {
    await controller.start(ctx);
    await assert.rejects(() => controller.status(ctx, mismatch.forkId), /different pi-fleet state directory/);

    branch.length = 0;
    branch.push(...invokingBranch());
    await controller.afterTree(ctx);
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    const abort = new AbortController();
    agents.steer = async (_agent, message) => { agents.sent.push(message); abort.abort(); };
    await controller.steer(ctx, forkId, "Continue.", abort.signal);
    assert.equal(agents.sent.at(-1), "Continue.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivers a continued report as progress without destroying the fork", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx, sent } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents, () => 0);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    agents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    agents.activity();
    agents.statusUpdate("working");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.kind, "progress");
    assert.equal(sent[0].details.description, "Find the requested answer");
    assert.match(sent[0].content, /intermediate progress report/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves progress order and finalizes only the last pending report after terminal grace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx, sent } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    agents.candidate({ text: "Checkpoint one", cursor: "progress-1" });
    agents.activity();
    agents.candidate({ text: "Checkpoint two", cursor: "progress-2" });
    agents.activity();
    agents.statusUpdate("working");
    agents.candidate({ text: "Final answer", cursor: "final-1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.deepEqual(sent.map((message) => message.details.kind), ["progress", "progress"]);
    assert.equal(agents.destroyed, 0);
    now += 10_000;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.deepEqual(sent.map((message) => message.details.kind), ["progress", "progress", "response"]);
    assert.equal(sent.filter((message) => message.details.cursor === "final-1").length, 1);
    assert.equal(agents.destroyed, 1);
    assert.equal(branch.filter((entry) => entry?.data?.type === "fork.destroyed").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("late continuation and accepted steering preserve progress before finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx, sent } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    agents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    now += 9_999;
    agents.activity();
    await waitForLifecycle();
    await controller.steer(ctx, forkId, "Check another source.");
    assert.equal(agents.destroyed, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.kind, "progress");
    assert.equal(agents.sent.at(-1), "Check another source.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defers progress on an inactive branch and suppresses a replayed delivered cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const owned: any[] = invokingBranch();
  let branch: any[] = owned;
  const { pi, ctx, sent } = harness(root, branch);
  ctx.sessionManager.getBranch = () => branch;
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents, () => 0);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    branch = [];
    agents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    agents.activity();
    await waitForLifecycle();
    assert.equal(sent.length, 0);

    branch = owned;
    await controller.afterTree(ctx);
    agents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    agents.activity();
    agents.statusUpdate("working");
    await waitForLifecycle();
    assert.equal(sent.length, 1);
    owned.push({ type: "custom_message", customType: "pi-async-fork-result", details: { forkId: sent[0].details.forkId, agentId: sent[0].details.agentId, cursor: "progress-1" } });

    await controller.afterTree(ctx);
    agents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    agents.activity();
    agents.statusUpdate("working");
    await waitForLifecycle();
    assert.equal(sent.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps delayed activity from turning an idle fork back into working", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx, sent } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    agents.candidate({ text: "Final answer", cursor: "final-1" });
    agents.statusUpdate("idle");
    agents.activity();
    await waitForLifecycle();
    assert.equal(sent.length, 0);
    now += 10_000;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.kind, "response");
    assert.equal(agents.destroyed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not send stale progress after failed status arrives before delayed activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx, sent } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    agents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    agents.statusUpdate("failed");
    agents.activity();
    await waitForLifecycle();
    assert.equal(sent.length, 0);
    now += 10_000;
    agents.statusUpdate("failed");
    await waitForLifecycle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.kind, "notice");
    assert.equal(agents.destroyed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("waits for a current working status before replaying historical progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", stateDir: "/fleet", sessionPath: "/child", tier: "balanced" };
  const branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: created }];
  const { pi, ctx, sent } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents, () => 0);
  try {
    await controller.start(ctx);
    agents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    agents.activity();
    await waitForLifecycle();
    assert.equal(sent.length, 0);
    agents.statusUpdate("working");
    await waitForLifecycle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.kind, "progress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies a prior visible report as progress when a newer report arrives", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx, sent } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    agents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    agents.candidate({ text: "Final answer", cursor: "final-1" });
    agents.statusUpdate("working");
    await waitForLifecycle();
    assert.deepEqual(sent.map((message) => message.details.kind), ["progress"]);
    agents.statusUpdate("idle");
    await waitForLifecycle();
    now += 10_000;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.deepEqual(sent.map((message) => message.details.kind), ["progress", "response"]);
    assert.equal(sent.filter((message) => message.details.cursor === "final-1").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not redeliver a persisted progress cursor after controller restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx, sent } = harness(root, branch);
  const firstAgents = new FakeAgents();
  const first = new Controller(pi, configuration, firstAgents, () => 0);
  try {
    const forkId = await first.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    firstAgents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    firstAgents.activity();
    firstAgents.statusUpdate("working");
    await waitForLifecycle();
    assert.equal(sent.length, 1);
    branch.push({ type: "custom_message", customType: "pi-async-fork-result", details: { forkId, agentId: "agent-1", cursor: "progress-1" } });
    await first.stop();

    const restoredAgents = new FakeAgents();
    const restored = new Controller(pi, configuration, restoredAgents, () => 0);
    await restored.start(ctx);
    restoredAgents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    restoredAgents.activity();
    restoredAgents.statusUpdate("working");
    await waitForLifecycle();
    assert.equal(sent.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sends a terminal notice after delivered progress when the fork fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx, sent } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    agents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    agents.activity();
    agents.statusUpdate("working");
    await waitForLifecycle();
    assert.deepEqual(sent.map((message) => message.details.kind), ["progress"]);

    agents.statusUpdate("failed");
    await waitForLifecycle();
    now += 10_000;
    agents.statusUpdate("failed");
    await waitForLifecycle();
    assert.deepEqual(sent.map((message) => message.details.kind), ["progress", "notice"]);
    assert.equal(agents.destroyed, 1);
    assert.equal(branch.filter((entry) => entry?.data?.type === "fork.destroyed").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fork status reports raw state without reordering lifecycle observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx, sent } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents, () => 0);
  try {
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    agents.candidate({ text: "Checkpoint", cursor: "progress-1" });
    agents.activity();
    agents.activityCollection = {
      entries: [
        { timestamp: 1_725_000_000_000, kind: "thinking" },
        { timestamp: 1_725_000_000_100, kind: "tool", toolName: "read", args: { path: "src/index.ts" } },
        { timestamp: 1_725_000_000_200, kind: "message" },
      ],
      stopReason: "idle",
      outputTruncated: false,
      incomplete: false,
    };
    const signal = new AbortController().signal;
    const result = await controller.status(ctx, forkId, 2, signal);
    assert.equal(result.state, "working");
    assert.equal(result.description, "Find the requested answer");
    assert.deepEqual(result.activity, agents.activityCollection);
    assert.deepEqual(agents.collected, [{ limit: 2, signal }]);
    assert.equal(sent.length, 0);

    agents.statusUpdate("working");
    await waitForLifecycle();
    assert.deepEqual(sent.map((message) => message.details.kind), ["progress"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


async function cancellationHarness(run: (h: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-cancel-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx, sent } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.", "Find the requested answer", { role: "investigate", effort: "balanced" });
    await waitForLifecycle();
    await run({ root, branch, pi, ctx, sent, agents, controller, forkId, advance: () => { now += 10_000; } });
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
}

function destroyedEntries(branch: any[]) {
  return branch.filter((entry) => entry?.data?.type === "fork.destroyed");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("cancels an active fork once, requests a notice and retains its child session", async () => {
  await cancellationHarness(async ({ root, branch, ctx, sent, agents, controller, forkId }) => {
    assert.deepEqual(await controller.cancel(ctx, forkId, "Scope changed"), { state: "completed", outcome: "cancelled" });
    assert.equal(agents.destroyed, 1);
    assert.equal(destroyedEntries(branch).length, 1);
    assert.equal(destroyedEntries(branch)[0].data.kind, "notice");
    assert.equal(destroyedEntries(branch)[0].data.output, "Fork explicitly cancelled. Reason: Scope changed");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.kind, "notice");
    assert.equal((await readdir(join(root, "async-forks"))).length, 1);
    assert.deepEqual(await controller.status(ctx, forkId), { state: "completed", description: "Find the requested answer" });
    assert.deepEqual(await controller.cancel(ctx, forkId), { state: "completed", outcome: "already_completed" });
    assert.equal(agents.destroyed, 1);
    assert.equal(sent.length, 1);
  });
});

test("serializes repeated cancellation and ignores callbacks queued after it", async () => {
  await cancellationHarness(async ({ branch, ctx, sent, agents, controller, forkId, advance }) => {
    const started = deferred();
    const release = deferred();
    agents.destroyHook = async () => { started.resolve(); await release.promise; };
    const first = controller.cancel(ctx, forkId);
    await started.promise;
    const second = controller.cancel(ctx, forkId);
    agents.candidate({ text: "Late answer", cursor: "late" });
    agents.statusUpdate("idle");
    advance();
    agents.statusUpdate("idle");
    release.resolve();
    assert.equal((await first).outcome, "cancelled");
    assert.equal((await second).outcome, "already_completed");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 1);
    assert.equal(destroyedEntries(branch).length, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /explicitly cancelled/);
    assert.doesNotMatch(sent[0].content, /Late answer/);
  });
});

test("cancels idle forks during grace but preserves an already finalized response", async () => {
  for (const finalized of [false, true]) {
    await cancellationHarness(async ({ branch, ctx, sent, agents, controller, forkId, advance }) => {
      agents.candidate({ text: "Answer", cursor: "c1" });
      agents.statusUpdate("idle");
      await waitForLifecycle();
      if (finalized) {
        advance();
        agents.statusUpdate("idle");
        await waitForLifecycle();
      }
      const result = await controller.cancel(ctx, forkId);
      assert.equal(result.outcome, finalized ? "already_completed" : "cancelled");
      assert.equal(agents.destroyed, 1);
      assert.equal(destroyedEntries(branch).length, 1);
      assert.equal(sent.length, 1);
      assert.equal(destroyedEntries(branch)[0].data.kind, finalized ? "response" : "notice");
    });
  }
});

test("completion already in the lifecycle queue wins over cancellation", async () => {
  await cancellationHarness(async ({ branch, ctx, agents, controller, forkId, advance }) => {
    agents.candidate({ text: "Answer", cursor: "c1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    const started = deferred();
    const release = deferred();
    agents.destroyHook = async () => { started.resolve(); await release.promise; };
    advance();
    agents.statusUpdate("idle");
    await started.promise;
    const cancelling = controller.cancel(ctx, forkId);
    release.resolve();
    assert.equal((await cancelling).outcome, "already_completed");
    assert.equal(agents.destroyed, 1);
    assert.equal(destroyedEntries(branch)[0].data.output, "Answer");
  });
});

test("cancellation rejects inactive branches and mismatched immutable identities", async () => {
  await cancellationHarness(async ({ branch, ctx, agents, controller, forkId }) => {
    ctx.sessionManager.getBranch = () => [];
    await assert.rejects(() => controller.cancel(ctx, forkId), /not found on this session branch/);
    ctx.sessionManager.getBranch = () => branch;
    const record = branch.find((entry: any) => entry?.data?.type === "fork.created");
    record.data.agentId = "replacement-agent";
    await assert.rejects(() => controller.cancel(ctx, forkId), /unavailable in this session/);
    assert.equal(agents.destroyed, 0);
    assert.equal(destroyedEntries(branch).length, 0);
  });
});

test("queued cancellation rejects a reconciled stale context", async () => {
  await cancellationHarness(async ({ ctx, agents, controller, forkId }) => {
    const started = deferred();
    const release = deferred();
    agents.steer = async () => { started.resolve(); await release.promise; };
    const steering = controller.steer(ctx, forkId, "Continue.");
    await started.promise;
    const cancelling = controller.cancel(ctx, forkId);
    const rejected = assert.rejects(() => cancelling, /context changed/);
    await controller.afterTree(ctx);
    release.resolve();
    await steering;
    await rejected;
    assert.equal(agents.destroyed, 0);
  });
});

test("tree transition drains cancellation already destroying an agent", async () => {
  await cancellationHarness(async ({ branch, ctx, agents, controller, forkId }) => {
    const started = deferred();
    const release = deferred();
    agents.destroyHook = async () => { started.resolve(); await release.promise; };
    const cancelling = controller.cancel(ctx, forkId);
    await started.promise;
    let transitioned = false;
    const transition = controller.beforeTree().then(() => { transitioned = true; });
    await waitForLifecycle();
    assert.equal(transitioned, false);
    release.resolve();
    assert.equal((await cancelling).outcome, "cancelled");
    await transition;
    assert.equal(destroyedEntries(branch).length, 1);
  });
});

test("cancellation recovers an aborted tree pause but rejects an ongoing tree transition", async () => {
  await cancellationHarness(async ({ ctx, agents, controller, forkId }) => {
    await controller.beforeTree();
    ctx.isIdle = () => false;
    await assert.rejects(() => controller.cancel(ctx, forkId), /tree navigation/);
    assert.equal(agents.destroyed, 0);
    // A veto leaves no session_tree event. A later idle or model turn proves
    // that the runtime has left navigation; both must permit cancellation.
    ctx.isIdle = () => true;
    assert.equal((await controller.cancel(ctx, forkId)).outcome, "cancelled");
  });
  await cancellationHarness(async ({ ctx, controller, forkId }) => {
    await controller.beforeTree();
    ctx.isIdle = () => false;
    ctx.signal = new AbortController().signal;
    assert.equal((await controller.cancel(ctx, forkId)).outcome, "cancelled");
  });
});

test("does not report success or append a notice when destruction fails", async () => {
  await cancellationHarness(async ({ branch, ctx, sent, agents, controller, forkId }) => {
    agents.destroyHook = async () => { throw new Error("SDK failure"); };
    await assert.rejects(() => controller.cancel(ctx, forkId), /Could not confirm.*SDK failure/);
    assert.equal(destroyedEntries(branch).length, 0);
    assert.equal(sent.length, 0);
  });
});

test("reports recording failure even when append mutated the in-memory branch", async () => {
  for (const mutateFirst of [false, true]) {
    await cancellationHarness(async ({ branch, pi, ctx, sent, agents, controller, forkId }) => {
      const append = pi.appendEntry;
      pi.appendEntry = (type: string, data: any) => {
        if (mutateFirst) append(type, data);
        throw new Error("EIO disk failure");
      };
      await assert.rejects(() => controller.cancel(ctx, forkId), /SDK confirmed.*recording.*EIO disk failure/);
      assert.equal(agents.destroyed, 1);
      assert.equal(sent.length, 0);
      await assert.rejects(() => controller.cancel(ctx, forkId), /recording.*EIO disk failure/);
      assert.equal(agents.destroyed, 1);
    });
  }
});

test("retains recording failures across navigation without replaying memory-only outcomes", async () => {
  for (const mutateFirst of [false, true]) {
    await cancellationHarness(async ({ branch, pi, ctx, sent, agents, controller, forkId }) => {
      const append = pi.appendEntry;
      pi.appendEntry = (type: string, data: any) => {
        if (mutateFirst) append(type, data);
        throw new Error("EIO disk failure");
      };
      await assert.rejects(() => controller.cancel(ctx, forkId), /recording.*EIO disk failure/);
      pi.appendEntry = append;

      // Leave the owning branch, then return to its possibly memory-only entry.
      await controller.beforeTree();
      ctx.sessionManager.getBranch = () => [];
      await controller.afterTree(ctx);
      await assert.rejects(() => controller.cancel(ctx, forkId), /not found on this session branch/);
      await assert.rejects(() => controller.status(ctx, forkId), /not found on this session branch/);
      await controller.beforeTree();
      ctx.sessionManager.getBranch = () => branch;
      await controller.afterTree(ctx);

      await assert.rejects(() => controller.cancel(ctx, forkId), /recording.*EIO disk failure/);
      await assert.rejects(() => controller.status(ctx, forkId), /recording.*EIO disk failure/);
      assert.equal(agents.destroyed, 1);
      assert.equal(agents.observed, 1, "must not restore the confirmed stopped agent");
      assert.equal(sent.length, 0, "must not replay an outcome whose recording failed");
    });
  }
});

test("recording failures do not leak to a different immutable agent on another branch", async () => {
  await cancellationHarness(async ({ branch, pi, ctx, sent, agents, controller, forkId }) => {
    const append = pi.appendEntry;
    pi.appendEntry = (type: string, data: any) => {
      append(type, data);
      throw new Error("EIO disk failure");
    };
    await assert.rejects(() => controller.cancel(ctx, forkId), /recording.*EIO disk failure/);
    pi.appendEntry = append;
    const created = branch.find((entry: any) => entry?.data?.type === "fork.created").data;
    const otherBranch = [
      { type: "custom", customType: "pi-async-fork", data: { ...created, agentId: "other-agent" } },
      { type: "custom", customType: "pi-async-fork", data: {
        type: "fork.destroyed", forkId, agentId: "other-agent", kind: "response", output: "Other outcome",
      } },
    ];
    await controller.beforeTree();
    ctx.sessionManager.getBranch = () => otherBranch;
    await controller.afterTree(ctx);
    assert.equal((await controller.cancel(ctx, forkId)).outcome, "already_completed");
    assert.equal((await controller.status(ctx, forkId)).state, "completed");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.agentId, "other-agent");

    await controller.beforeTree();
    ctx.sessionManager.getBranch = () => branch;
    await controller.afterTree(ctx);
    await assert.rejects(() => controller.cancel(ctx, forkId), /recording.*EIO disk failure/);
    await assert.rejects(() => controller.status(ctx, forkId), /recording.*EIO disk failure/);
    assert.equal(agents.destroyed, 1);
    assert.equal(sent.length, 1);
  });
});

test("reconciliation still retries transient restoration failures", async () => {
  await cancellationHarness(async ({ ctx, agents, controller, forkId }) => {
    const restore = agents.restore.bind(agents);
    agents.restore = async () => { throw new Error("Temporary fleet outage"); };
    await controller.beforeTree();
    await controller.afterTree(ctx);
    await assert.rejects(() => controller.status(ctx, forkId), /Temporary fleet outage/);

    agents.restore = restore;
    await controller.beforeTree();
    await controller.afterTree(ctx);
    assert.equal((await controller.status(ctx, forkId)).state, "working");
    assert.equal((await controller.cancel(ctx, forkId)).outcome, "cancelled");
    assert.equal(agents.destroyed, 1);
  });
});

test("status collection cannot turn a concurrent recording failure into completion", async () => {
  await cancellationHarness(async ({ pi, ctx, agents, controller, forkId }) => {
    const collecting = deferred();
    const release = deferred();
    agents.collectHook = async () => {
      collecting.resolve();
      await release.promise;
      return agents.activityCollection;
    };
    const status = controller.status(ctx, forkId);
    const rejected = assert.rejects(() => status, /recording.*EIO disk failure/);
    await collecting.promise;
    const append = pi.appendEntry;
    pi.appendEntry = (type: string, data: any) => {
      append(type, data);
      throw new Error("EIO disk failure");
    };
    await assert.rejects(() => controller.cancel(ctx, forkId), /recording.*EIO disk failure/);
    release.resolve();
    await rejected;
    assert.equal(agents.destroyed, 1);
  });
});

test("reports synchronous notification failure after keeping the recorded outcome", async () => {
  await cancellationHarness(async ({ branch, pi, ctx, agents, controller, forkId }) => {
    pi.sendMessage = () => { throw new Error("Notification rejected"); };
    await assert.rejects(() => controller.cancel(ctx, forkId), /recorded.*requesting.*Notification rejected/);
    assert.equal(destroyedEntries(branch).length, 1);
    assert.equal(agents.destroyed, 1);
    assert.equal((await controller.cancel(ctx, forkId)).outcome, "already_completed");
    const notifications: any[] = [];
    pi.sendMessage = (message: any) => { notifications.push(message); };
    await controller.afterTree(ctx);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].content, /explicitly cancelled/);
    assert.equal(agents.destroyed, 1);
  });
});

test("abort before destroy has no effect; abort during destroy still records cancellation", async () => {
  for (const during of [false, true]) {
    await cancellationHarness(async ({ branch, ctx, sent, agents, controller, forkId }) => {
      const abort = new AbortController();
      if (during) agents.destroyHook = async () => { abort.abort(); };
      else abort.abort();
      if (during) {
        assert.equal((await controller.cancel(ctx, forkId, undefined, abort.signal)).outcome, "cancelled");
        assert.equal(destroyedEntries(branch).length, 1);
        assert.equal(sent.length, 1);
      } else {
        await assert.rejects(() => controller.cancel(ctx, forkId, undefined, abort.signal), /aborted/);
        assert.equal(agents.destroyed, 0);
        assert.equal(destroyedEntries(branch).length, 0);
      }
    });
  }
});

test("cancellation rechecks abort after waiting behind an accepted steer", async () => {
  await cancellationHarness(async ({ branch, ctx, agents, controller, forkId }) => {
    const started = deferred();
    const release = deferred();
    agents.steer = async () => { started.resolve(); await release.promise; };
    const steering = controller.steer(ctx, forkId, "Continue.");
    await started.promise;
    const abort = new AbortController();
    const cancelling = controller.cancel(ctx, forkId, undefined, abort.signal);
    const rejected = assert.rejects(() => cancelling, /aborted/);
    abort.abort();
    release.resolve();
    await steering;
    await rejected;
    assert.equal(agents.destroyed, 0);
    assert.equal(destroyedEntries(branch).length, 0);
  });
});

test("direct cancellation rejects marked child sessions before lifecycle work", async () => {
  const agents = new FakeAgents();
  const controller = new Controller({}, configuration, agents);
  const ctx = { sessionManager: {
    getHeader: () => ({ id: "child" }),
    getEntries: () => [{ type: "custom", customType: "pi-async-fork-child", data: { version: 1, sessionId: "child", forkId: "parent-1234567" } }],
  } };
  await assert.rejects(() => controller.cancel(ctx, "research-1234567"), /Async fork tools are unavailable here/);
  assert.equal(agents.destroyed, 0);
});
