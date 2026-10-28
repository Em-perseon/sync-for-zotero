import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { parseHTML } from "linkedom";

function setup(markup, extra = {}) {
  const { document, window } = parseHTML(
    "<html><head></head><body>" + markup + "</body></html>",
  );
  const context = vm.createContext({ URL, TextEncoder, setTimeout, console });
  vm.runInContext(
    readFileSync(
      new URL("../extension/conversation_snapshot.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  const api = context.SyncZoteroSnapshot;
  const env = {
    document,
    window: { location: { href: "https://chatgpt.com/c/test-123" } },
    createDocument: () =>
      parseHTML("<html><head></head><body></body></html>").document,
    getComputedStyle: (el) => ({
      getPropertyValue: (key) =>
        key === "color"
          ? "rgb(12, 30, 90)"
          : key === "border-radius"
            ? "12px"
            : "",
    }),
    fetchImage: async () => "data:image/png;base64,aGVsbG8=",
    ...extra,
  };
  return {
    api,
    env,
    document,
    capture: () => api.capture(env.window.location.href, env),
  };
}

test("DIL snapshot preserves cards, tables, SVG paths and images without sidebar or executable content", async () => {
  const s = setup(
    `<aside>Private account/sidebar</aside><div data-content-search-unit-key="fallback-turn-0:0:user">Explain this paper</div><div data-content-search-unit-key="fallback-turn-0:2:assistant"><section style="border-radius:12px"><h2>Result</h2><table><tr><td>42</td></tr></table><svg viewBox="0 0 10 10"><path d="M0 0L10 10"></path></svg><img src="https://example.com/image.png" onerror="evil()"><script>secret()</script><button>Share</button><iframe src="https://example.com"></iframe><a href="javascript:evil()">bad</a></section></div>`,
  );
  const result = await s.capture();
  assert.equal(result.messageCount, 2);
  assert.match(result.html, /border-radius:12px/);
  assert.match(result.html, /<table/);
  assert.match(result.html, /<path/);
  assert.match(result.html, /data:image\/png;base64/);
  assert.match(result.html, /Content-Security-Policy/);
  assert.doesNotMatch(
    result.html,
    /Private account|secret\(\)|<script|<iframe|onerror|javascript:|>Share</,
  );
});

test("legacy markup works and nested role containers are not duplicated", async () => {
  const s = setup(
    '<div data-message-author-role="user">Question</div><div data-message-author-role="assistant"><p>Answer</p><div data-message-author-role="assistant">nested</div></div>',
  );
  assert.equal((await s.capture()).messageCount, 2);
});

test("mismatched URL, missing messages, and active generation fail explicitly", async () => {
  const s = setup('<div data-message-author-role="user">Q</div>');
  await assert.rejects(
    s.api.capture("https://chatgpt.com/c/other", s.env),
    /changed/,
  );
  await assert.rejects(
    setup("<aside>Sidebar only</aside>").capture(),
    /No conversation/,
  );
  await assert.rejects(
    setup('<button data-testid="stop-button"></button>').capture(),
    /finish/,
  );
});

test("failed images leave an explicit offline warning, never a remote resource", async () => {
  const s = setup(
    '<div data-message-author-role="assistant"><img src="https://private.example/image"></div>',
    {
      fetchImage: async () => {
        throw new Error("CORS");
      },
    },
  );
  const result = await s.capture();
  assert.equal(result.warnings.length, 1);
  assert.doesNotMatch(result.html, /private.example/);
  assert.match(result.html, /Image unavailable offline/);
});

test("navigation during image capture rejects rather than saving the wrong conversation", async () => {
  const s = setup(
    '<div data-message-author-role="assistant"><img src="https://example.com/image"></div>',
  );
  s.env.fetchImage = async () => {
    s.env.window.location.href = "https://chatgpt.com/c/other";
    return "data:image/png;base64,aGVsbG8=";
  };
  await assert.rejects(s.capture(), /changed while saving/);
});
