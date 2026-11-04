import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EFRE_TIFINAGH, IFRAN_TIFINAGH, TifinaghName } from "./tifinagh";

describe("TifinaghName", () => {
  it("spells ifri and ifran in Tifinagh", () => {
    expect(EFRE_TIFINAGH).toBe("ⵉⴼⵔⵉ");
    expect(IFRAN_TIFINAGH).toBe("ⵉⴼⵔⴰⵏ");
  });

  it("is decorative next to the Latin name, and marked as Tamazight in Tifinagh", () => {
    const { container } = render(<TifinaghName />);
    const span = container.querySelector("span");
    expect(span?.textContent).toBe(EFRE_TIFINAGH);
    expect(span?.getAttribute("aria-hidden")).toBe("true");
    expect(span?.getAttribute("lang")).toBe("ber-Tfng");
    expect(span?.className).toContain("font-tifinagh");
  });

  it("has a spoken name when it stands alone", () => {
    render(<TifinaghName label="ifri" />);
    expect(screen.getByRole("img", { name: "ifri" }).textContent).toBe(EFRE_TIFINAGH);
  });
});
