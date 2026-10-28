// js-prueffactory's changes to the rules of typescript-eslint for lint.typed.
// This text is part of the generated ESLint config module and runs inside it.

// no-floating-promises accepts a rejection handler only if the type of the
// argument has a call signature. In JavaScript without types the handler is
// often `any` or `Function` (`.catch(next)` in Express), so that a chain that
// does end in `.catch(handler)` or `.then(onFulfilled, handler)` is reported
// as unhandled. The rule says so with these message IDs, and only then: a chain
// with no handler at all gets other IDs. The reports about the handler are
// dropped; the rule is otherwise untouched and keeps its ID.
const uselessHandlerReports = ['floatingUselessRejectionHandler', 'floatingUselessRejectionHandlerVoid'];

function trustRejectionHandlers(rule) {
  return {
    ...rule,
    create(context) {
      const filtered = Object.create(context, {
        report: {
          value(descriptor) {
            if (!uselessHandlerReports.includes(descriptor.messageId)) context.report(descriptor);
          },
        },
      });
      return rule.create(filtered);
    },
  };
}
