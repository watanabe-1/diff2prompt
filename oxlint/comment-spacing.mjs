const rule = {
  meta: {
    type: "layout",
    docs: {
      description: "Require a space after comment delimiters.",
    },
    fixable: "whitespace",
    messages: {
      missingSpace: "Expected a space after the comment delimiter.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (!shouldCheckComment(comment)) continue;

          const insertOffset = comment.start + 2;
          context.report({
            loc: comment.loc,
            messageId: "missingSpace",
            fix: (fixer) => fixer.insertTextAfterRange([insertOffset, insertOffset], " "),
          });
        }
      },
    };
  },
};

function shouldCheckComment(comment) {
  if (comment.type !== "Line" && comment.type !== "Block") return false;

  const value = comment.value;
  if (value.length === 0) return false;
  if (/^\s/u.test(value)) return false;

  // Preserve common comment forms that have syntax or tooling meaning.
  if (comment.type === "Line" && (value.startsWith("/") || value.startsWith("!"))) return false;
  if (comment.type === "Block" && (value.startsWith("*") || value.startsWith("!"))) return false;

  return true;
}

export default {
  meta: {
    name: "diff2prompt",
  },
  rules: {
    "comment-spacing": rule,
  },
};
