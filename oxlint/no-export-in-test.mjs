const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow exports from test files.",
    },
    messages: {
      noExport: "Do not export from a test file. Move shared helpers to a separate file.",
    },
  },
  create(context) {
    return {
      ExportAllDeclaration: reportExport,
      ExportDefaultDeclaration: reportExport,
      ExportNamedDeclaration: reportExport,
      AssignmentExpression(node) {
        if (!isCommonJsExport(node.left)) return;

        context.report({
          loc: node.left.loc,
          messageId: "noExport",
        });
      },
    };

    function reportExport(node) {
      context.report({
        loc: node.loc,
        messageId: "noExport",
      });
    }
  },
};

function isCommonJsExport(node) {
  if (node.type !== "MemberExpression") return false;
  if (isIdentifier(node.object, "exports")) return true;

  return isIdentifier(node.object, "module") && isStaticProperty(node.property, "exports");
}

function isStaticProperty(node, name) {
  return isIdentifier(node, name) || (node.type === "Literal" && node.value === name);
}

function isIdentifier(node, name) {
  return node.type === "Identifier" && node.name === name;
}

export default {
  meta: {
    name: "diff2prompt",
  },
  rules: {
    "no-export": rule,
  },
};
