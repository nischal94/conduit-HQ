import { describe, expect, it } from "vitest";
import { createDispatchCell } from "./dispatch.js";

describe("DispatchCell (§5.5)", () => {
  it("INVARIANT §5.5 (#28): the dispatch cell is monotonic — none → initializing → dispatched, never lowered", () => {
    const cell = createDispatchCell();
    expect(cell.state).toBe("none");
    cell.advance("initializing");
    expect(cell.state).toBe("initializing");
    cell.advance("dispatched");
    cell.advance("initializing");
    cell.advance("none");
    expect(cell.state).toBe("dispatched");
  });
});
