import { seal, seedForm } from "../skills/index.js";
/** Specialize a known UIA method from typed operands. No model selects individual keys. */
export function calculatorAddition(
  left: number,
  right: number,
  target: string,
) {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    left > 999999 ||
    right > 999999
  )
    throw new Error("Calculator method supports bounded nonnegative integers");
  const controls = [
    "clearButton",
    ...String(left)
      .split("")
      .map((d) => "num" + d + "Button"),
    "plusButton",
    ...String(right)
      .split("")
      .map((d) => "num" + d + "Button"),
    "equalButton",
  ];
  return seal({
    ...seedForm(),
    id: "calculator.add." + left + "." + right,
    description: "Known addition method specialized from typed operands",
    inputs: { left: "number", right: "number" },
    outputs: ["uia.CalculatorResults"],
    capabilities: ["invoke"],
    preconditions: [],
    compatibility: [target],
    budgets: { retries: 0, steps: controls.length },
    machine: {
      initial: "calculate",
      states: [
        {
          id: "calculate",
          steps: controls.map((locator, i) => ({
            id: "button" + i,
            operation: "invoke",
            args: { locator },
            scope: "edit",
          })),
          monitor: ["focused"],
        },
      ],
    },
  });
}
