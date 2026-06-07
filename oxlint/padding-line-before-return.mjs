const rule = {
  meta: {
    type: "layout",
    docs: {
      description: "Require a blank line before return statements.",
    },
    fixable: "whitespace",
    messages: {
      missingBlankLine: "Expected a blank line before this return statement.",
    },
  },
  create(context) {
    return {
      BlockStatement(node) {
        for (let index = 1; index < node.body.length; index++) {
          const statement = node.body[index];
          if (statement.type !== "ReturnStatement") continue;

          const previousStatement = node.body[index - 1];
          if (hasBlankLineBetween(previousStatement, statement)) continue;

          context.report({
            loc: statement.loc,
            messageId: "missingBlankLine",
            fix: (fixer) =>
              fixer.insertTextAfterRange([previousStatement.end, previousStatement.end], "\n"),
          });
        }
      },
    };
  },
};

function hasBlankLineBetween(previousStatement, statement) {
  return statement.loc.start.line - previousStatement.loc.end.line >= 2;
}

export default {
  meta: {
    name: "diff2prompt",
  },
  rules: {
    "padding-line-before-return": rule,
  },
};
