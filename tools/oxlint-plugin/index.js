// CODE-13 / CODE-15: a limit on a model call, tool call or job must be a named constant from
// contracts/limits.ts (`Limits.<name>.value`) with an adjacent `// limit: <name>` comment.
const LIMIT_KEYS = new Set([
  "maxTokens",
  "maxOutputTokens",
  "maxInputTokens",
  "timeout",
  "timeoutMs",
  "timeoutMS",
  "workflowCompletionTimeoutMS",
  "maxRetries",
  "retries",
  "maxAttempts",
  "maxSteps",
  "concurrency",
  "maxConcurrency",
  "workerConcurrency",
  "rateLimit",
]);
const LIMIT_CALLS = new Set(["AbortSignal.timeout", "stepCountIs", "pLimit"]);

function keyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function calleeName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.object.type === "Identifier" && node.property.type === "Identifier") return `${node.object.name}.${node.property.name}`;
  return null;
}

/** `Limits.<name>.value` → name; anything else → null. */
function limitsReference(node) {
  if (!node || node.type !== "MemberExpression" || node.computed) return null;
  if (node.property.type !== "Identifier" || node.property.name !== "value") return null;
  const inner = node.object;
  if (inner.type !== "MemberExpression" || inner.computed) return null;
  if (inner.object.type !== "Identifier" || inner.object.name !== "Limits" || inner.property.type !== "Identifier") return null;
  return inner.property.name;
}

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

const rule = {
  meta: { type: "problem", docs: { description: "Limits must be named constants with a cited reason (CODE-13/15)" } },
  create(context) {
    const sourceCode = context.sourceCode;
    const text = sourceCode.text;
    const comments = sourceCode.getAllComments().map((c) => ({ line: lineOf(text, c.range[0]), endLine: lineOf(text, c.range[1]), value: c.value.trim() }));
    const citedNear = (node) => {
      const start = lineOf(text, node.range[0]);
      for (const c of comments) {
        if (c.endLine !== start && c.endLine !== start - 1 && c.line !== start) continue;
        const m = /^limit:\s*([A-Za-z0-9_]+)/.exec(c.value);
        if (m) return m[1];
      }
      return null;
    };
    const check = (node, valueNode, what) => {
      const cited = citedNear(node);
      const ref = limitsReference(valueNode);
      if (cited === null) {
        context.report({ node, message: `${what} is a limit with no reason. Use Limits.<name>.value from contracts/limits.ts and add "// limit: <name>" next to it (CODE-13).` });
        return;
      }
      if (ref === null) {
        context.report({ node, message: `${what} must be Limits.${cited}.value, never a literal at the call site (CODE-15).` });
        return;
      }
      if (ref !== cited) context.report({ node, message: `"// limit: ${cited}" does not match Limits.${ref} (CODE-13).` });
    };
    return {
      Property(node) {
        const name = keyName(node.key);
        if (name !== null && LIMIT_KEYS.has(name)) check(node, node.value, `"${name}"`);
      },
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name !== null && LIMIT_CALLS.has(name)) check(node, node.arguments[0], `${name}()`);
      },
    };
  },
};

export default { meta: { name: "household" }, rules: { "cited-limits": rule } };
