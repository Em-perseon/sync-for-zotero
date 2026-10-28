import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(
  new URL("../extension/background.js", import.meta.url),
  "utf8",
);
const worker = source.slice(
  source.indexOf("let snapshotRunning = false;"),
  source.indexOf("async function pollForCommand()"),
);
const url = "https://chatgpt.com/c/target-1";
function create({ tabs = [{ id: 8, url }], busy = false, old = false } = {}) {
  const posts = [],
    executions = [];
  const context = vm.createContext({
    URL,
    pipelineRunning: busy,
    zoteroConnected: true,
    SERVER: "http://127.0.0.1:23119/llm-for-zotero/webchat",
    activeChatTabId: 3,
    relayFetch: async (endpoint, options) => {
      if (options) posts.push(JSON.parse(options.body));
      return {
        ok: !old,
        json: async () => ({ request: { id: "request-1", version: 1, url } }),
      };
    },
    chrome: {
      tabs: { query: async () => tabs },
      scripting: {
        executeScript: async (options) => {
          executions.push(options);
          return [
            {
              result: {
                version: 1,
                url,
                html: "<html>test</html>",
                messageCount: 2,
                warnings: [],
              },
            },
          ];
        },
      },
    },
  });
  vm.runInContext(worker + "\nglobalThis.poll = pollForSnapshot;", context);
  return { poll: context.poll, posts, executions };
}

test("snapshot targets the exact URL even if the tracked tab belongs to another conversation", async () => {
  const s = create({
    tabs: [
      { id: 3, url: "https://chatgpt.com/c/other" },
      { id: 8, url },
    ],
  });
  await s.poll();
  assert.equal(s.executions.length, 2);
  assert.equal(s.executions[0].target.tabId, 8);
  assert.equal(s.posts[0].id, "request-1");
  assert.equal(s.posts[0].url, url);
});

test("missing tab returns a useful error without navigating or creating a chat", async () => {
  const s = create({ tabs: [] });
  await s.poll();
  assert.equal(s.executions.length, 0);
  assert.match(s.posts[0].error, /Open this conversation/);
});

test("older relays, active generation and overlapping polling do not trigger duplicate captures", async () => {
  const old = create({ old: true });
  await old.poll();
  assert.equal(old.executions.length, 0);
  const busy = create({ busy: true });
  await busy.poll();
  assert.equal(busy.executions.length, 0);
  const s = create();
  await Promise.all([s.poll(), s.poll()]);
  assert.equal(s.posts.length, 1);
});
