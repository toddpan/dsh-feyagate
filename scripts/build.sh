#!/usr/bin/env bash
#
# Build both halves of the plugin.
#
# Two modes, and the difference matters:
#
#   * **standalone** (default) — uses this package's own `node_modules`, so a
#     contributor or a CI job needs nothing but `npm install`. This is the mode
#     the published package is built with.
#   * **linked** (`DSH_CHECKOUT=/path/to/deepseek-harness`) — symlinks the host's
#     own packages into `node_modules` first, so the build type-checks against
#     the checkout that is actually running. Only useful while working on two
#     repos at once.
#
# The client half must be bundled by tsdown, never by tsc: it has to be a single
# file wrapped in `window.__ModuleLoader__.load({ id, factory })`, and a plain
# tsc emit produces ESM the frontend cannot load.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "${DSH_CHECKOUT:-}" ]; then
  if [ ! -d "$DSH_CHECKOUT/packages" ]; then
    echo "DSH_CHECKOUT 指向的目录里没有 packages/：$DSH_CHECKOUT" >&2
    exit 1
  fi
  echo "== 链接宿主包（$DSH_CHECKOUT）=="
  mkdir -p node_modules/@deepseek-ai
  for pkg in cordis; do
    src="$DSH_CHECKOUT/vendor/$pkg"
    [ -d "$src" ] || src="$DSH_CHECKOUT/packages/$pkg"
    if [ -d "$src" ]; then
      rm -rf "node_modules/@deepseek-ai/$pkg"
      ln -s "$src" "node_modules/@deepseek-ai/$pkg"
      echo "  linked @deepseek-ai/$pkg -> $src"
    fi
  done
fi

echo "== 校验内置清单 =="
node scripts/verify-manifest.mjs

echo "== 校验 profile patch（解析失败会让 DSH 起不来）=="
node scripts/check-patch.mjs

echo "== 类型检查 + 宿主半侧构建 (tsc) =="
npx tsc -p tsconfig.json

echo "== 浏览器半侧打包 (tsdown → lib/client.js) =="
npx tsdown

# The failure this guard exists for: a client bundle that forgot to keep the
# lazy-CJS wrapper loads as a blank settings page with no error the user can act
# on. Check the contract here instead.
node -e '
const { readFileSync } = require("node:fs");
const code = readFileSync("lib/client.js", "utf8");
const problems = [];
if (!code.includes("window.__ModuleLoader__.load(")) problems.push("缺少 window.__ModuleLoader__.load(...) 包装");
if (!/\bid:\s*"@dsh-external\/dsh-feyagate-gateway"/.test(code)) problems.push("load() 的 id 与包名不一致");
if (!code.includes("factory:")) problems.push("缺少 factory");
// Every bare require must be a platform-seeded module; a typo or a forgotten
// `neverBundle` entry would otherwise surface as a blank settings page at run
// time with nothing in the build output to explain it.
const allowed = new Set([
  "react", "react/jsx-runtime", "react-dom", "react-dom/client",
  "@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives",
]);
const required = new Set([...code.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]));
const unknown = [...required].filter((id) => !allowed.has(id));
if (unknown.length) problems.push("require 了平台未提供的模块：" + unknown.join(", "));
if (problems.length) {
  console.error("lib/client.js 不满足前端加载契约：" + problems.join("；"));
  process.exit(1);
}
console.log("  lib/client.js ok (" + (code.length / 1024).toFixed(0) + " KB)，require 了 " + required.size + " 个平台模块");
'

echo "构建完成：lib/index.js（宿主）+ lib/client.js（浏览器）"
